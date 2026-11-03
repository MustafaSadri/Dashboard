'use strict';
// Babylon (partner) commission — Admin panel.
//
//   profit per model     = sales − purchase cost per unit × pieces sold
//   Babylon commission   = profit × share  (summed over all models)
//
// Purchase cost per unit:
//   • imported models: USD price × RUB_PER_USD (fixed below)
//   • every other (locally bought) model: weighted average price from
//     MoySklad purchase orders dated up to the end of the month
// Share: 25.5% of profit on imported models, 40% on local models.
//
// Sales come from MoySklad shipments (ms_demands / ms_demand_positions) —
// the same source as the Dashboard's revenue.
const { query } = require('./pool');

const RUB_PER_USD = 87;
const IMPORTED = {
  'ELFBAR GH23000':            { usd: 5.37 },
  'STAR 30000 20mg/ml 800mAh': { usd: 4.72 },
};
const SHARE_IMPORTED = 25.5;
const SHARE_LOCAL = 40;
const MS_BASE = 'https://api.moysklad.ru/api/remap/1.2';

const isMonth = m => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));
function monthBounds(month) {
  const [y, m] = month.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return [`${month}-01 00:00:00`, `${next}-01 00:00:00`];
}

// Same rule the sync uses for ms_*_positions.base_name (see
// sync/moysklad-sync.js), so purchase-order lines and sold lines group into
// identical model names: strip the trailing "(flavour)", paren-depth aware.
function baseNameOf(name) {
  const s = (name || '').trim();
  if (!s.endsWith(')')) return s;
  let depth = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] === ')') depth++;
    else if (s[i] === '(') { depth--; if (depth === 0) return s.slice(0, i).trim() || s; }
  }
  return s;
}

// Every purchase-order line (model, unit price after discount, qty, PO
// number/date/supplier) straight from the MoySklad API. Purchase orders
// aren't part of the dashboard's synced data, so they're fetched here and
// cached for 10 min. Zero-price lines (e.g. an import order entered without
// prices) are kept for the per-model detail but excluded from averages —
// they'd drag the average towards zero.
let _poCache = null;
async function fetchPurchaseLines() {
  if (_poCache && Date.now() - _poCache.at < 10 * 60 * 1000) return _poCache.lines;
  const headers = { Authorization: 'Bearer ' + process.env.TOKEN, Accept: 'application/json;charset=utf-8' };
  const get = async path => {
    const r = await fetch(MS_BASE + path, { headers, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`MoySklad purchase orders: HTTP ${r.status}`);
    return r.json();
  };
  const orders = [];
  for (let offset = 0; ; offset += 100) {
    const d = await get(`/entity/purchaseorder?limit=100&offset=${offset}&expand=agent`);
    orders.push(...(d.rows || []));
    if ((d.rows || []).length < 100) break;
  }
  const lines = [];
  for (let i = 0; i < orders.length; i += 4) {
    await Promise.all(orders.slice(i, i + 4).map(async o => {
      for (let offset = 0; ; offset += 1000) {
        const d = await get(`/entity/purchaseorder/${o.id}/positions?expand=assortment&limit=1000&offset=${offset}`);
        for (const p of d.rows || []) {
          const unit = (Number(p.price) || 0) * (1 - (Number(p.discount) || 0) / 100);   // kopecks
          if (p.quantity > 0) lines.push({
            model: baseNameOf(p.assortment && p.assortment.name), unit, qty: p.quantity,
            moment: o.moment, po: o.name, supplier: (o.agent && o.agent.name) || '—',
          });
        }
        if ((d.rows || []).length < 1000) break;
      }
    }));
  }
  _poCache = { lines, at: Date.now() };
  return lines;
}

// Weighted average purchase price per model (kopecks), using purchase orders
// dated before `beforeMoment`; models with none yet fall back to the average
// over all purchase orders (flagged as such).
function averagePurchasePrices(lines, beforeMoment) {
  const acc = (filter) => {
    const m = {};
    lines.filter(l => l.unit > 0).filter(filter).forEach(l => {
      m[l.model] = m[l.model] || { value: 0, qty: 0, pos: new Set() };
      m[l.model].value += l.unit * l.qty; m[l.model].qty += l.qty; m[l.model].pos.add(l.po);
    });
    return m;
  };
  const upTo = acc(l => (l.moment || '') < beforeMoment), all = acc(() => true);
  const out = {};
  Object.keys(all).forEach(model => {
    const a = upTo[model] || all[model];
    out[model] = { unit: a.value / a.qty, orders: a.pos.size, fromLater: !upTo[model] };
  });
  return out;
}

async function getReport(month) {
  const [from, to] = monthBounds(month);
  const [sales, shipCount, poLines] = await Promise.all([
    query(`
      SELECT COALESCE(NULLIF(p.base_name, ''), p.product_name, '—') AS model,
             SUM(p.quantity) AS qty, SUM(p.amount_kopecks) AS revenue
      FROM ms_demand_positions p JOIN ms_demands d ON d.id = p.demand_id
      WHERE d.moment >= $1 AND d.moment < $2
      GROUP BY 1 ORDER BY SUM(p.amount_kopecks) DESC`, [from, to]),
    query('SELECT COUNT(*)::int AS n FROM ms_demands WHERE moment >= $1 AND moment < $2', [from, to]),
    fetchPurchaseLines(),
  ]);
  const avg = averagePurchasePrices(poLines, to);

  // Per model, its purchase orders (one row per PO): pcs, price per pc, and
  // whether that PO counts towards this month's average.
  const poByModel = {};
  poLines.forEach(l => {
    const m = (poByModel[l.model] = poByModel[l.model] || {});
    const e = (m[l.po] = m[l.po] || { po: l.po, date: (l.moment || '').slice(0, 10), moment: l.moment || '', supplier: l.supplier, qty: 0, pricedQty: 0, value: 0 });
    e.qty += l.qty;
    if (l.unit > 0) { e.pricedQty += l.qty; e.value += l.unit * l.qty; }
  });
  const purchaseOrdersFor = model => Object.values(poByModel[model] || {})
    .sort((a, b) => b.moment.localeCompare(a.moment))
    .map(e => ({
      po: e.po, date: e.date, supplier: e.supplier, qty: e.qty,
      price: e.pricedQty ? e.value / e.pricedQty / 100 : null,
      total: e.value / 100,
      status: !e.pricedQty ? 'no_price' : e.moment >= to ? 'after_month' : 'counted',
    }));

  const totals = { qty: 0, revenue: 0, profit: 0, commission: 0 };
  const models = [], unpriced = [];
  for (const r of sales.rows) {
    const qty = Number(r.qty) || 0, revenue = Number(r.revenue) || 0;   // kopecks
    totals.qty += qty; totals.revenue += revenue;
    const imp = IMPORTED[r.model];
    let unitCost, costNote, share;
    if (imp) {
      unitCost = Math.round(imp.usd * RUB_PER_USD * 100);
      costNote = `$${imp.usd} × ${RUB_PER_USD}`;
      share = SHARE_IMPORTED;
    } else if (avg[r.model]) {
      unitCost = avg[r.model].unit;
      costNote = `avg of ${avg[r.model].orders} purchase order${avg[r.model].orders === 1 ? '' : 's'}${avg[r.model].fromLater ? ' (later orders)' : ''}`;
      share = SHARE_LOCAL;
    } else {
      unpriced.push({ model: r.model, qty, revenue: revenue / 100, purchaseOrders: purchaseOrdersFor(r.model) });
      continue;
    }
    const profit = revenue - unitCost * qty;
    const commission = profit * share / 100;
    totals.profit += profit; totals.commission += commission;
    models.push({
      model: r.model, type: imp ? 'Imported' : 'Local', qty,
      revenue: revenue / 100, unitCost: unitCost / 100, costNote,
      profit: profit / 100, share, commission: commission / 100,
      purchaseOrders: purchaseOrdersFor(r.model),
    });
  }
  return {
    month, models, unpriced,
    totals: { qty: totals.qty, shipments: shipCount.rows[0].n, revenue: totals.revenue / 100, profit: totals.profit / 100, commission: totals.commission / 100 },
    rules: { rubPerUsd: RUB_PER_USD, imported: IMPORTED, shareImported: SHARE_IMPORTED, shareLocal: SHARE_LOCAL },
  };
}

// The shipments (with their sales order) that make up one model's pcs and
// sales for the month — what the "Shipped sales" button lists.
async function getShippedSales(month, model) {
  const [from, to] = monthBounds(month);
  const { rows } = await query(`
    SELECT d.name AS shipment, to_char(d.moment, 'YYYY-MM-DD') AS date,
           COALESCE(cp.name, d.customer_name, '—') AS customer, o.name AS order_name,
           SUM(p.quantity) AS qty, SUM(p.amount_kopecks) AS amount
    FROM ms_demand_positions p
    JOIN ms_demands d ON d.id = p.demand_id
    LEFT JOIN ms_counterparties cp ON cp.id = d.customer_id
    LEFT JOIN ms_orders o ON o.id = d.order_id
    WHERE d.moment >= $1 AND d.moment < $2
      AND COALESCE(NULLIF(p.base_name, ''), p.product_name, '—') = $3
    GROUP BY d.id, d.name, d.moment, cp.name, d.customer_name, o.name
    ORDER BY d.moment DESC`, [from, to, model]);
  return rows.map(r => {
    const qty = Number(r.qty) || 0, amount = Number(r.amount) || 0;
    return { shipment: r.shipment, date: r.date, customer: r.customer, order: r.order_name || null,
             qty, price: qty ? amount / qty / 100 : null, amount: amount / 100 };
  });
}

// ── Sales manager commission (one employee per entry) ──────────────────────
// basis 'payments': payments RECEIVED in the month (MoySklad Financials →
//   Payments: incoming payments + cash receipts) whose "Select Office" field
//   is `office`; rates are % of the payment amount.
// basis 'orders': sales orders dated in the month whose owner is `ownerUid`
//   (declined/cancelled orders don't count); rates are % of the order sum,
//   plus `perPcs.rub` for every pc of a product in the `perPcs.folder`
//   inventory folder.
// Customers listed in `special` get their own rate, everyone else `rate`.
const STAFF = {
  alex: {
    name: 'Alex', title: 'Sales Manager', basis: 'payments', office: 'Berlin Office', fromMonth: '2026-10',
    rate: 0.5, special: { KHAN: 1 },
  },
  pasha: {
    name: 'Pasha', title: 'Sales Manager', basis: 'orders', ownerUid: 'ss1@mustafa7', ownerName: 'SS1 B.', fromMonth: '2026-10',
    rate: 1.5, special: { KHAN: 0.375, 'MT OPT': 0.375 },
    perPcs: { folder: '3. CHEWING TOBACCO', label: 'Chewing tobacco', rub: 4 },
  },
  // basis 'model_pcs': every sales order in the month (anyone's), paid per pc
  // of the model only — no % commission.
  evgeny: {
    name: 'Evgeny', title: 'Employee', basis: 'model_pcs', fromMonth: '2026-10',
    rate: 0, perPcs: { model: 'GH23000', label: 'GH23000', rub: 2 },
  },
};
// Draft and declined/cancelled sales orders aren't sales.
const NOT_SOLD_STATE = '(draft|declin|cancel|черновик|отмен)';
const custKey = n => String(n || '').trim().toUpperCase();

// "Select Office" is a custom field that isn't part of the synced data, so the
// month's payments come straight from the MoySklad API (cached 5 min).
const _payCache = {};
async function fetchPaymentsIn(month) {
  const hit = _payCache[month];
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.rows;
  const [from, to] = monthBounds(month);
  const headers = { Authorization: 'Bearer ' + process.env.TOKEN, Accept: 'application/json;charset=utf-8' };
  const filter = encodeURIComponent(`moment>=${from};moment<${to}`);
  const rows = [];
  for (const entity of ['paymentin', 'cashin']) {
    for (let offset = 0; ; offset += 100) {
      const r = await fetch(`${MS_BASE}/entity/${entity}?limit=100&offset=${offset}&filter=${filter}&expand=agent&order=moment,asc`,
        { headers, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`MoySklad payments: HTTP ${r.status}`);
      const d = await r.json();
      for (const p of d.rows || []) {
        const office = (p.attributes || []).find(a => a.name === 'Select Office');
        rows.push({
          no: p.name || '—', date: (p.moment || '').slice(0, 16), type: entity === 'cashin' ? 'Cash' : 'Bank',
          customer: (p.agent && p.agent.name) || '—', office: (office && office.value && office.value.name) || null,
          amount: (Number(p.sum) || 0) / 100, comment: p.description || '',
        });
      }
      if ((d.rows || []).length < 100) break;
    }
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  _payCache[month] = { rows, at: Date.now() };
  return rows;
}

// Names of the products in an inventory folder (and its subfolders), from the
// MoySklad API — product folders aren't part of the synced data. Order lines
// are flavour variants ("ODEN'S TAR (16 гр.) (Cola, 20 pouches)"), so they're
// matched on their base name. Cached 30 min.
const _folderCache = {};
async function folderProductNames(folder) {
  const hit = _folderCache[folder];
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.names;
  const headers = { Authorization: 'Bearer ' + process.env.TOKEN, Accept: 'application/json;charset=utf-8' };
  const names = new Set();
  for (let offset = 0; ; offset += 1000) {
    const r = await fetch(`${MS_BASE}/entity/product?limit=1000&offset=${offset}&filter=${encodeURIComponent('pathName~' + folder)}`,
      { headers, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`MoySklad products: HTTP ${r.status}`);
    const d = await r.json();
    (d.rows || []).forEach(p => names.add(custKey(p.name)));
    if ((d.rows || []).length < 1000) break;
  }
  _folderCache[folder] = { names, at: Date.now() };
  return names;
}

async function fetchOwnerOrders(s, month) {
  const [from, to] = monthBounds(month);
  const [orders, pcsNames] = await Promise.all([
    query(`
      SELECT o.id, o.name, to_char(o.moment, 'YYYY-MM-DD HH24:MI') AS date, o.sum_kopecks,
             COALESCE(cp.name, o.customer_name, '—') AS customer, COALESCE(st.name, o.state_name, '—') AS state
      FROM ms_orders o
      JOIN ms_employees e ON e.id = o.owner_id
      LEFT JOIN ms_counterparties cp ON cp.id = o.customer_id
      LEFT JOIN ms_states st ON st.id = o.state_id
      WHERE e.uid = $1 AND o.moment >= $2 AND o.moment < $3
        AND COALESCE(st.name, o.state_name, '') !~* '${NOT_SOLD_STATE}'
      ORDER BY o.moment`, [s.ownerUid, from, to]),
    s.perPcs ? folderProductNames(s.perPcs.folder) : Promise.resolve(new Set()),
  ]);
  const pcsByOrder = {};
  if (s.perPcs && orders.rows.length) {
    const { rows } = await query(`
      SELECT order_id, COALESCE(NULLIF(base_name, ''), product_name) AS base, product_name, SUM(quantity) AS qty
      FROM ms_order_positions WHERE order_id = ANY($1) GROUP BY 1, 2, 3`, [orders.rows.map(o => o.id)]);
    rows.forEach(r => {
      if (pcsNames.has(custKey(r.base)) || pcsNames.has(custKey(r.product_name)))
        pcsByOrder[r.order_id] = (pcsByOrder[r.order_id] || 0) + (Number(r.qty) || 0);
    });
  }
  return orders.rows.map(o => ({
    no: o.name || '—', date: o.date, type: 'Order', customer: o.customer, comment: o.state,
    amount: (Number(o.sum_kopecks) || 0) / 100, pcs: pcsByOrder[o.id] || 0,
  }));
}

// Every sales order in the month (anyone's) with pcs of the model; `amount`
// is just that model's lines.
async function fetchModelOrders(s, month) {
  const [from, to] = monthBounds(month);
  const { rows } = await query(`
    SELECT o.name, to_char(o.moment, 'YYYY-MM-DD HH24:MI') AS date,
           COALESCE(cp.name, o.customer_name, '—') AS customer, COALESCE(st.name, o.state_name, '—') AS state,
           COALESCE(e.name, '—') AS owner, SUM(p.quantity) AS pcs, SUM(p.amount_kopecks) AS amount
    FROM ms_orders o
    JOIN ms_order_positions p ON p.order_id = o.id
    LEFT JOIN ms_counterparties cp ON cp.id = o.customer_id
    LEFT JOIN ms_states st ON st.id = o.state_id
    LEFT JOIN ms_employees e ON e.id = o.owner_id
    WHERE o.moment >= $1 AND o.moment < $2
      AND COALESCE(st.name, o.state_name, '') !~* '${NOT_SOLD_STATE}'
      AND COALESCE(NULLIF(p.base_name, ''), p.product_name, '') ILIKE $3
    GROUP BY o.id, o.name, o.moment, cp.name, o.customer_name, st.name, o.state_name, e.name
    ORDER BY o.moment`, [from, to, '%' + s.perPcs.model + '%']);
  return rows.map(r => ({
    no: r.name || '—', date: r.date, type: 'Order', customer: r.customer, comment: r.state, owner: r.owner,
    amount: (Number(r.amount) || 0) / 100, pcs: Number(r.pcs) || 0,
  }));
}

async function getStaffReport(key, month) {
  const s = STAFF[key];
  if (!s) throw new Error('Unknown employee');
  const rows = s.basis === 'orders' ? await fetchOwnerOrders(s, month)
    : s.basis === 'model_pcs' ? await fetchModelOrders(s, month)
    : (await fetchPaymentsIn(month)).filter(p => p.office === s.office);
  const perPcs = s.perPcs ? s.perPcs.rub : 0;
  const groups = {};   // 'KHAN' / 'Other customers' → totals
  const payments = rows.map(p => {
    const special = Object.keys(s.special || {}).find(k => custKey(k) === custKey(p.customer));
    const rate = special ? s.special[special] : s.rate;
    const group = special || 'Other customers';
    const pcs = p.pcs || 0, bonus = pcs * perPcs;
    const commission = p.amount * rate / 100;
    const g = (groups[group] = groups[group] || { group, rate, count: 0, amount: 0, commission: 0 });
    g.count++; g.amount += p.amount; g.commission += commission;
    return { ...p, group, rate, commission, pcs, bonus, total: commission + bonus };
  });
  const order = [...Object.keys(s.special || {}), 'Other customers'];
  const sum = f => payments.reduce((a, p) => a + p[f], 0);
  return {
    key, month, employee: s,
    groups: order.filter(g => groups[g]).map(g => groups[g]),
    payments,
    totals: {
      count: payments.length, amount: sum('amount'), commission: sum('commission'),
      pcs: sum('pcs'), bonus: sum('bonus'), total: sum('total'),
    },
  };
}

module.exports = { isMonth, getReport, getShippedSales, STAFF, getStaffReport };
