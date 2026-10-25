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

module.exports = { isMonth, getReport };
