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

// MoySklad API data cache: within `freshMs` it's used as is; up to `staleMs`
// the last copy is returned at once and refreshed in the background (so the
// page never waits on MoySklad); older than that, the request waits for a
// fresh load. Concurrent loads of the same key share one request.
const _swr = {};
function swr(key, freshMs, staleMs, load) {
  const e = (_swr[key] = _swr[key] || {});
  const age = e.at ? Date.now() - e.at : Infinity;
  const refresh = () => e.pending || (e.pending = load()
    .then(v => { e.value = v; e.at = Date.now(); return v; })
    .finally(() => { e.pending = null; }));
  if (age < freshMs) return Promise.resolve(e.value);
  if (age < staleMs) { refresh().catch(() => {}); return Promise.resolve(e.value); }
  return refresh();
}

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
// cached (see swr: fresh 10 min, then refreshed in the background). Zero-price lines (e.g. an import order entered without
// prices) are kept for the per-model detail but excluded from averages —
// they'd drag the average towards zero.
function fetchPurchaseLines() {
  return swr('purchase_lines', 10 * 60 * 1000, 6 * 60 * 60 * 1000, loadPurchaseLines);
}
async function loadPurchaseLines() {
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
// basis 'order_payments': payments received in the month that are linked to a
//   sales order owned by `ownerUid` — directly, or through the order's
//   shipment or invoice; rates are % of the linked amount, plus `perPcs.rub`
//   per pc of a product in the `perPcs.folder` inventory folder, in proportion
//   to how much of the order that payment covers.
// Customers listed in `special` get their own rate, everyone else `rate`.
// `networkRates`: rate by the sales order's "Sales Network" field; an order
// without it counts as `networkDefault`.
// `newCustomer`: customers ticked on the page get this rate instead, for
// `months` months from the month they were ticked in.
// Tata, Alex2 and Danial share the same rules.
const networkManager = (name, ownerUid, ownerName) => ({
  name, title: 'Sales Manager', basis: 'order_payments', ownerUid, ownerName, fromMonth: '2026-11',
  rate: 1, networkRates: { Distro: 1, Retail: 1.5 }, networkDefault: 'Distro',
  newCustomer: { rate: 2, months: 3, group: 'New customers' },
});
const STAFF = {
  alex: {
    name: 'Alex', title: 'Sales Manager', basis: 'payments', office: 'Berlin Office', fromMonth: '2026-10',
    rate: 0.35,
  },
  pasha: {
    name: 'Pasha', title: 'Sales Manager', basis: 'order_payments', ownerUid: 'ss1@mustafa7', ownerName: 'SS1 B.', fromMonth: '2026-10',
    rate: 1.5, special: { KHAN: 0.35, 'MT OPT': 0.35, 'BHOLA (Sky Seven)': 0.35, BHOLA: 0.35 },
    perPcs: { folder: '3. CHEWING TOBACCO', label: 'Chewing tobacco', rub: 4 },
  },
  tata: networkManager('Tata', 'tata@mustafa7', 'Tata B.'),
  alex2: networkManager('Alex2', 'alexyar@mustafa7', 'alexyar B.'),
  danial: networkManager('Danial', 'dan@mustafa7', 'Dan Balan B.'),
  // basis 'model_pcs': every sales order in the month (anyone's), paid per pc
  // of perPcs.model only — no % commission.
};
// Draft and declined/cancelled sales orders aren't sales.
const NOT_SOLD_STATE = '(draft|declin|cancel|черновик|отмен)';
const custKey = n => String(n || '').trim().toUpperCase();

// "Select Office" is a custom field that isn't part of the synced data, so the
// month's payments come straight from the MoySklad API (fresh 3 min, then
// refreshed in the background — warmCaches keeps the current month warm).
function fetchPaymentsIn(month) {
  return swr('payments_' + month, 3 * 60 * 1000, 20 * 60 * 1000, () => loadPaymentsIn(month));
}
async function loadPaymentsIn(month) {
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
          links: (p.operations || []).map(o => ({
            type: o.meta.type, id: o.meta.href.split('/').pop().split('?')[0], sum: (Number(o.linkedSum) || 0) / 100,
          })),
        });
      }
      if ((d.rows || []).length < 100) break;
    }
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

// Names of the products in an inventory folder (and its subfolders), from the
// MoySklad API — product folders aren't part of the synced data. Order lines
// are flavour variants ("ODEN'S TAR (16 гр.) (Cola, 20 pouches)"), so they're
// matched on their base name. Fresh 30 min, then refreshed in the background.
function folderProductNames(folder) {
  return swr('folder_' + folder, 30 * 60 * 1000, 24 * 60 * 60 * 1000, () => loadFolderProductNames(folder));
}
async function loadFolderProductNames(folder) {
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
  return names;
}

// "Sales Network" of the owner's sales orders (order id → value) — a custom
// field that isn't part of the synced data, so it comes from the MoySklad API.
function ownerOrderNetworks(s) {
  return swr('networks_' + s.ownerUid, 3 * 60 * 1000, 20 * 60 * 1000, () => loadOwnerOrderNetworks(s));
}
async function loadOwnerOrderNetworks(s) {
  const { rows } = await query('SELECT id FROM ms_employees WHERE uid = $1', [s.ownerUid]);
  if (!rows.length) return {};
  const headers = { Authorization: 'Bearer ' + process.env.TOKEN, Accept: 'application/json;charset=utf-8' };
  const filter = encodeURIComponent(`owner=${MS_BASE}/entity/employee/${rows[0].id}`);
  const map = {};
  for (let offset = 0; ; offset += 100) {
    const r = await fetch(`${MS_BASE}/entity/customerorder?limit=100&offset=${offset}&filter=${filter}`,
      { headers, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`MoySklad sales orders: HTTP ${r.status}`);
    const d = await r.json();
    for (const o of d.rows || []) {
      const a = (o.attributes || []).find(x => x.name === 'Sales Network');
      if (a && a.value && a.value.name) map[o.id] = a.value.name;
    }
    if ((d.rows || []).length < 100) break;
  }
  return map;
}

// Customers ticked as new, per employee. Created here so it needs no separate
// migration step on deploy.
let _newCustTable = null;
function ensureNewCustomerTable() {
  return _newCustTable || (_newCustTable = query(`
    CREATE TABLE IF NOT EXISTS commission_new_customers (
      employee_key  TEXT NOT NULL,
      customer_key  TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      start_month   TEXT NOT NULL,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (employee_key, customer_key)
    )`).catch(e => { _newCustTable = null; throw e; }));
}
const addMonths = (month, n) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
async function getNewCustomers(key) {
  await ensureNewCustomerTable();
  const { rows } = await query('SELECT customer_key, start_month FROM commission_new_customers WHERE employee_key = $1', [key]);
  return Object.fromEntries(rows.map(r => [r.customer_key, r.start_month]));
}
async function setNewCustomer(key, customer, month, on) {
  const s = STAFF[key];
  if (!s || !s.newCustomer) throw new Error('Unknown employee');
  await ensureNewCustomerTable();
  if (!on) {
    await query('DELETE FROM commission_new_customers WHERE employee_key = $1 AND customer_key = $2', [key, custKey(customer)]);
    return;
  }
  await query(`
    INSERT INTO commission_new_customers (employee_key, customer_key, customer_name, start_month)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (employee_key, customer_key)
    DO UPDATE SET customer_name = EXCLUDED.customer_name, start_month = EXCLUDED.start_month, updated_at = now()`,
    [key, custKey(customer), customer, month]);
}
async function ownerCustomers(s) {
  const { rows } = await query(`
    SELECT DISTINCT COALESCE(cp.name, o.customer_name) AS name
    FROM ms_orders o
    JOIN ms_employees e ON e.id = o.owner_id
    LEFT JOIN ms_counterparties cp ON cp.id = o.customer_id
    WHERE e.uid = $1 AND COALESCE(cp.name, o.customer_name) IS NOT NULL
    ORDER BY 1`, [s.ownerUid]);
  return rows.map(r => r.name);
}

// The month's payments split by the owner's sales orders they're linked to:
// one row per payment + order, for the linked amount only (one payment often
// covers several orders of a customer).
async function fetchOwnerPayments(s, month) {
  const [payments, pcsNames, networks] = await Promise.all([
    fetchPaymentsIn(month),
    s.perPcs ? folderProductNames(s.perPcs.folder) : Promise.resolve(new Set()),
    s.networkRates ? ownerOrderNetworks(s) : Promise.resolve({}),
  ]);
  const idsOf = type => [...new Set(payments.flatMap(p => p.links.filter(l => l.type === type).map(l => l.id)))];
  const [demands, invoices] = await Promise.all([
    query('SELECT id, order_id FROM ms_demands WHERE id = ANY($1)', [idsOf('demand')]),
    query('SELECT id, order_id FROM ms_invoices_out WHERE id = ANY($1)', [idsOf('invoiceout')]),
  ]);
  const orderOfDoc = {};
  [...demands.rows, ...invoices.rows].forEach(r => { orderOfDoc[r.id] = r.order_id; });
  const VIA = { customerorder: 'Direct', demand: 'Shipment', invoiceout: 'Invoice' };
  const orderIdOf = l => (l.type === 'customerorder' ? l.id : orderOfDoc[l.id] || null);

  const linked = [...new Set(payments.flatMap(p => p.links.map(orderIdOf)).filter(Boolean))];
  const [{ rows: orders }, positions] = await Promise.all([
    query(`
      SELECT o.id, o.name, o.sum_kopecks, COALESCE(cp.name, o.customer_name, '—') AS customer
      FROM ms_orders o
      JOIN ms_employees e ON e.id = o.owner_id
      LEFT JOIN ms_counterparties cp ON cp.id = o.customer_id
      WHERE e.uid = $1 AND o.id = ANY($2)`, [s.ownerUid, linked]),
    s.perPcs && linked.length ? query(`
      SELECT p.order_id, COALESCE(NULLIF(p.base_name, ''), p.product_name) AS base, p.product_name, SUM(p.quantity) AS qty
      FROM ms_order_positions p
      JOIN ms_orders o ON o.id = p.order_id
      JOIN ms_employees e ON e.id = o.owner_id
      WHERE e.uid = $1 AND p.order_id = ANY($2) GROUP BY 1, 2, 3`, [s.ownerUid, linked]) : Promise.resolve({ rows: [] }),
  ]);
  const orderById = Object.fromEntries(orders.map(o => [o.id, o]));

  const pcsByOrder = {};
  positions.rows.forEach(r => {
    if (pcsNames.has(custKey(r.base)) || pcsNames.has(custKey(r.product_name)))
      pcsByOrder[r.order_id] = (pcsByOrder[r.order_id] || 0) + (Number(r.qty) || 0);
  });

  const out = [];
  payments.forEach(p => {
    const perOrder = {};
    p.links.forEach(l => {
      const id = orderIdOf(l);
      if (!orderById[id]) return;
      const e = (perOrder[id] = perOrder[id] || { amount: 0, via: new Set() });
      e.amount += l.sum; e.via.add(VIA[l.type] || l.type);
    });
    Object.entries(perOrder).forEach(([id, e]) => {
      const o = orderById[id];
      const orderSum = (Number(o.sum_kopecks) || 0) / 100;
      const share = orderSum > 0 ? Math.min(e.amount / orderSum, 1) : 0;
      out.push({
        no: p.no, date: p.date, type: p.type, order: o.name, customer: o.customer, comment: [...e.via].join(' + '),
        network: networks[id] || null, amount: e.amount, pcs: (pcsByOrder[id] || 0) * share,
      });
    });
  });
  return out;
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
  const rows = s.basis === 'order_payments' ? await fetchOwnerPayments(s, month)
    : s.basis === 'model_pcs' ? await fetchModelOrders(s, month)
    : (await fetchPaymentsIn(month)).filter(p => p.office === s.office);
  const perPcs = s.perPcs ? s.perPcs.rub : 0;
  const newCustomers = s.newCustomer ? await getNewCustomers(key) : {};
  const isNewCustomer = name => {
    const start = newCustomers[custKey(name)];
    return !!start && month >= start && month < addMonths(start, s.newCustomer.months);
  };
  const restGroup = Object.keys(s.special || {}).length ? 'Other customers' : 'All customers';
  const groups = {};   // 'KHAN' / 'Other customers' → totals
  const payments = rows.map(p => {
    const special = Object.keys(s.special || {}).find(k => custKey(k) === custKey(p.customer));
    let rate = special ? s.special[special] : s.rate, group = special || restGroup, comment = p.comment;
    if (s.networkRates) {
      group = s.networkRates[p.network] != null ? p.network : s.networkDefault;
      rate = s.networkRates[group];
      comment = `${p.comment} · ${p.network || group + ' (not selected)'}`;
      if (isNewCustomer(p.customer)) { group = s.newCustomer.group; rate = s.newCustomer.rate; comment = `${p.comment} · New customer`; }
    }
    const pcs = p.pcs || 0, bonus = pcs * perPcs;
    const commission = p.amount * rate / 100;
    const g = (groups[group] = groups[group] || { group, rate, count: 0, amount: 0, commission: 0 });
    g.count++; g.amount += p.amount; g.commission += commission;
    return { ...p, comment, group, rate, commission, pcs, bonus, total: commission + bonus };
  });
  const order = s.networkRates ? [...Object.keys(s.networkRates), s.newCustomer.group] : [...Object.keys(s.special || {}), restGroup];
  const sum = f => payments.reduce((a, p) => a + p[f], 0);
  const customers = s.newCustomer ? (await ownerCustomers(s)).map(name => {
    const start = newCustomers[custKey(name)] || null;
    return { name, start, until: start && addMonths(start, s.newCustomer.months - 1), active: isNewCustomer(name) };
  }) : null;
  return {
    key, month, employee: s, customers,
    groups: order.filter(g => groups[g]).map(g => groups[g]),
    payments,
    totals: {
      count: payments.length, amount: sum('amount'), commission: sum('commission'),
      pcs: sum('pcs'), bonus: sum('bonus'), total: sum('total'),
    },
  };
}

// Keeps the MoySklad data behind the commission pages loaded, so opening them
// doesn't wait on the API: purchase orders, the per-pc product folders, and
// this and last month's payments. Each call only reloads what's out of date.
function warmCaches() {
  const now = new Date();
  const ym = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const jobs = [
    fetchPurchaseLines(),
    fetchPaymentsIn(ym(now)),
    fetchPaymentsIn(ym(new Date(now.getFullYear(), now.getMonth() - 1, 1))),
    ...Object.values(STAFF).filter(s => s.perPcs && s.perPcs.folder).map(s => folderProductNames(s.perPcs.folder)),
    ...Object.values(STAFF).filter(s => s.networkRates).map(ownerOrderNetworks),
  ];
  return Promise.allSettled(jobs);
}

module.exports = { isMonth, getReport, getShippedSales, STAFF, getStaffReport, setNewCustomer, warmCaches };
