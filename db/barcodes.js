'use strict';
// Barcode tracking (warehouse module). Reads orders/customers/shipments from
// the MoySklad mirror (ms_* tables, synced from the MoySklad API every
// minute) and writes ONLY to barcode_scans — never to any ms_* table.
const { query } = require('./pool');

const CUTOVER = '2026-09-01 00:00:00';   // current MoySklad account only
const MAX_BARCODE_LEN = 300;
const MAX_BATCH = 500;   // per request — the screen saves big batches in chunks
const MS_BASE = 'https://api.moysklad.ru/api/remap/1.2';

// Scanners can append CR/LF/tab or embed DataMatrix group separators (GS,
// \x1D); strip every control character so one physical code always maps to
// one stored value — otherwise the same label could slip past the
// duplicate check by arriving with a different invisible suffix.
function normalizeBarcode(raw) {
  return String(raw || '').replace(/[\x00-\x1F\x7F]/g, '').trim();
}

// MoySklad line discount is a percentage; this is the per-unit price the
// customer actually pays.
function unitPriceKopecks(priceKopecks, discount) {
  return Math.round(Number(priceKopecks) * (1 - (Number(discount) || 0) / 100));
}
const rub = k => (k == null ? null : Number(k) / 100);

async function listOrders() {
  const { rows } = await query(`
    SELECT o.id, o.name, to_char(o.moment, 'YYYY-MM-DD') AS date,
           o.customer_id, COALESCE(cp.name, o.customer_name) AS customer_name,
           COALESCE(st.name, o.state_name) AS state, o.sum_kopecks,
           (SELECT COUNT(*) FROM barcode_scans b WHERE b.order_id = o.id)::int AS scanned
    FROM ms_orders o
    LEFT JOIN ms_counterparties cp ON cp.id = o.customer_id
    LEFT JOIN ms_states st ON st.id = o.state_id
    WHERE o.moment >= $1
    ORDER BY o.moment DESC
    LIMIT 2000`, [CUTOVER]);
  return rows.map(r => ({
    id: r.id, name: r.name, date: r.date,
    customerId: r.customer_id, customerName: r.customer_name || '—',
    state: r.state || '—', sum: Number(r.sum_kopecks) / 100, scanned: r.scanned,
  }));
}

async function getOrderHeader(orderId) {
  const { rows } = await query(`
    SELECT o.id, o.name, o.moment, to_char(o.moment, 'YYYY-MM-DD HH24:MI') AS moment_s,
           o.customer_id, COALESCE(cp.name, o.customer_name) AS customer_name,
           COALESCE(st.name, o.state_name) AS state, o.sum_kopecks, o.payed_sum_kopecks,
           to_char(o.delivery_planned_moment, 'YYYY-MM-DD') AS delivery_planned,
           s.name AS store_name, e.name AS salesman
    FROM ms_orders o
    LEFT JOIN ms_counterparties cp ON cp.id = o.customer_id
    LEFT JOIN ms_states st ON st.id = o.state_id
    LEFT JOIN ms_stores s ON s.id = o.store_id
    LEFT JOIN ms_employees e ON e.id = o.owner_id
    WHERE o.id = $1`, [orderId]);
  return rows[0] || null;
}

// Order lines in MoySklad's own order. Position ids are "<orderId>_<n>", so
// (length, id) sorts them numerically (…_2 before …_10).
async function getOrderLines(orderId) {
  const { rows } = await query(`
    SELECT assortment_href, product_name, base_name, quantity, price_kopecks, discount
    FROM ms_order_positions WHERE order_id = $1 ORDER BY length(id), id`, [orderId]);
  return rows.map(r => ({
    assortmentHref: r.assortment_href, productName: r.product_name || '—', baseName: r.base_name,
    quantity: Number(r.quantity) || 0, priceKopecks: Number(r.price_kopecks) || 0,
    discount: Number(r.discount) || 0,
    unitPriceKopecks: unitPriceKopecks(r.price_kopecks, r.discount),
  }));
}

// Product barcodes (EAN-13 etc.) straight from the MoySklad API. Those
// identify a product, not one carton — so they're flagged instead of saved.
// Cached 30 min per product; a failure just means no flagging, never a
// failed save.
const _codeCache = new Map();
async function fetchProductCodes(hrefs) {
  const token = process.env.TOKEN;
  const out = {};
  const todo = [];
  for (const h of [...new Set(hrefs.filter(Boolean))]) {
    const hit = _codeCache.get(h);
    if (hit && Date.now() - hit.at < 30 * 60 * 1000) out[h] = hit.codes;
    else if (h.startsWith(MS_BASE + '/entity/')) todo.push(h);
  }
  for (let i = 0; i < todo.length && token; i += 5) {
    await Promise.all(todo.slice(i, i + 5).map(async h => {
      try {
        const r = await fetch(h, {
          headers: { Authorization: 'Bearer ' + token, Accept: 'application/json;charset=utf-8' },
          signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) return;
        const d = await r.json();
        const codes = (d.barcodes || []).flatMap(b => Object.values(b)).map(normalizeBarcode).filter(Boolean);
        _codeCache.set(h, { codes, at: Date.now() });
        out[h] = codes;
      } catch (_) { /* leave this product without codes */ }
    }));
  }
  return out;
}
function productCodeMap(lines, codes) {
  const m = {};
  lines.forEach(l => (codes[l.assortmentHref] || []).forEach(c => { m[c] = l.productName; }));
  return m;
}

async function recentScans({ orderId = null, limit = 30 } = {}) {
  const { rows } = await query(`
    SELECT id, barcode, order_id, order_name, customer_name, product_name,
           unit_price_kopecks, scanned_by, scanned_at
    FROM barcode_scans
    ${orderId ? 'WHERE order_id = $2' : ''}
    ORDER BY scanned_at DESC, id DESC LIMIT $1`, orderId ? [limit, orderId] : [limit]);
  return rows.map(r => ({
    id: Number(r.id), barcode: r.barcode, orderId: r.order_id, orderName: r.order_name,
    customerName: r.customer_name || '—', productName: r.product_name || null,
    unitPrice: rub(r.unit_price_kopecks), scannedBy: r.scanned_by, scannedAt: r.scanned_at,
  }));
}

// Everything the scanning screen needs for one order.
async function getOrderForScanning(orderId) {
  const header = await getOrderHeader(orderId);
  if (!header) return null;
  const [lines, counts, total, scans] = await Promise.all([
    getOrderLines(orderId),
    query(`SELECT assortment_href, unit_price_kopecks, COUNT(*)::int AS n FROM barcode_scans
           WHERE order_id = $1 AND assortment_href IS NOT NULL GROUP BY 1, 2`, [orderId]),
    query('SELECT COUNT(*)::int AS n FROM barcode_scans WHERE order_id = $1', [orderId]),
    recentScans({ orderId, limit: 200 }),
  ]);
  const codes = await fetchProductCodes(lines.map(l => l.assortmentHref));
  const linesOut = lines.map(l => ({ ...l, unitPrice: l.unitPriceKopecks / 100, scanned: 0, codes: codes[l.assortmentHref] || [] }));
  // Product-linked saves are stored per product + unit price, not per line,
  // so an order listing one product on several lines at the same price fills
  // those lines in order; anything past the total lands on the last one.
  const fill = (targets, n) => targets.forEach((l, i) => {
    const take = i === targets.length - 1 ? n : Math.min(n, Math.max(0, l.quantity - l.scanned));
    l.scanned += take; n -= take;
  });
  for (const c of counts.rows) {
    let same = linesOut.filter(l => l.assortmentHref === c.assortment_href && l.unitPriceKopecks === Number(c.unit_price_kopecks));
    if (!same.length) same = linesOut.filter(l => l.assortmentHref === c.assortment_href);
    if (same.length) fill(same, c.n);
  }
  return {
    id: header.id, name: header.name, date: header.moment_s,
    customerId: header.customer_id, customerName: header.customer_name || '—',
    state: header.state || '—', sum: Number(header.sum_kopecks) / 100,
    lines: linesOut, savedCount: total.rows[0].n, savedScans: scans,
  };
}

// Pre-save check for codes in the scanner's batch: which are already in the
// database (and where), and which are a product's own EAN for this order.
async function checkCodes(orderId, rawCodes) {
  const codes = [...new Set((rawCodes || []).map(normalizeBarcode).filter(Boolean))].slice(0, MAX_BATCH);
  const out = { existing: {}, productCodes: {} };
  if (!codes.length) return out;
  const [ex, lines] = await Promise.all([
    query(`SELECT barcode, order_name, customer_name, product_name, scanned_by, scanned_at
           FROM barcode_scans WHERE barcode = ANY($1::text[])`, [codes]),
    orderId ? getOrderLines(orderId) : Promise.resolve([]),
  ]);
  ex.rows.forEach(r => { out.existing[r.barcode] = {
    orderName: r.order_name, customerName: r.customer_name, productName: r.product_name,
    scannedBy: r.scanned_by, scannedAt: r.scanned_at } });
  const pc = productCodeMap(lines, await fetchProductCodes(lines.map(l => l.assortmentHref)));
  codes.forEach(c => { if (pc[c]) out.productCodes[c] = pc[c]; });
  return out;
}

// Saves a whole scanned batch for one order in one statement. Each item is
// { barcode, lineIndex?, assortmentHref? }. Product/price are read from the
// database — never trusted from the browser — and frozen into the row. The
// product is linked when the scanner chose one, or automatically when the
// order has a single product; otherwise the barcode is linked to the order
// as a whole. Returns per-code results so the screen can keep anything that
// wasn't saved for fixing.
async function saveBatch({ orderId, items, username }) {
  if (!Array.isArray(items) || !items.length) return { error: 'Nothing to save.' };
  if (items.length > MAX_BATCH) return { error: `Too many codes in one batch (max ${MAX_BATCH}).` };
  const header = await getOrderHeader(orderId);
  if (!header) return { error: 'This order no longer exists in MoySklad. Reload the order list.' };
  const lines = await getOrderLines(orderId);
  const pc = productCodeMap(lines, await fetchProductCodes(lines.map(l => l.assortmentHref)));

  const results = [];
  const toInsert = [];
  const seen = new Set();
  for (const it of items) {
    const code = normalizeBarcode(it && it.barcode);
    if (!code) { results.push({ barcode: String((it && it.barcode) || ''), status: 'invalid', error: 'Empty barcode.' }); continue; }
    if (code.length > MAX_BARCODE_LEN) { results.push({ barcode: code, status: 'invalid', error: `Too long (max ${MAX_BARCODE_LEN} characters).` }); continue; }
    if (seen.has(code)) { results.push({ barcode: code, status: 'duplicate_in_batch' }); continue; }
    seen.add(code);
    if (pc[code]) { results.push({ barcode: code, status: 'product_code', productName: pc[code] }); continue; }
    let line = null;
    const idx = Number(it.lineIndex);
    if (it.lineIndex != null && it.lineIndex !== '' && Number.isInteger(idx)) {
      line = lines[idx];
      if (!line || line.assortmentHref !== it.assortmentHref) {
        results.push({ barcode: code, status: 'invalid', error: 'The order was changed in MoySklad — pick the product again.' });
        continue;
      }
    } else if (lines.length === 1) {
      line = lines[0];
    }
    toInsert.push({ code, line });
  }

  if (toInsert.length) {
    const cols = ['barcode', 'order_id', 'order_name', 'order_moment', 'customer_id', 'customer_name',
      'assortment_href', 'product_name', 'base_name', 'price_kopecks', 'discount', 'unit_price_kopecks', 'scanned_by'];
    const vals = [];
    const ph = toInsert.map(({ code, line }, i) => {
      vals.push(code, header.id, header.name, header.moment, header.customer_id, header.customer_name,
        line ? line.assortmentHref : null, line ? line.productName : null, line ? line.baseName : null,
        line ? line.priceKopecks : null, line ? line.discount : 0, line ? line.unitPriceKopecks : null, username);
      return '(' + cols.map((_, j) => `$${i * cols.length + j + 1}`).join(',') + ')';
    });
    const { rows } = await query(
      `INSERT INTO barcode_scans (${cols.join(',')}) VALUES ${ph.join(',')}
       ON CONFLICT (barcode) DO NOTHING RETURNING barcode`, vals);
    const saved = new Set(rows.map(r => r.barcode));
    const already = await checkCodes(null, toInsert.filter(x => !saved.has(x.code)).map(x => x.code));
    toInsert.forEach(({ code, line }) => {
      if (saved.has(code)) results.push({ barcode: code, status: 'saved', productName: line ? line.productName : null });
      else results.push({ barcode: code, status: 'already_saved', existing: already.existing[code] || null });
    });
  }
  return { ok: true, saved: results.filter(r => r.status === 'saved').length, results };
}

// Undo a mistaken save. Admin can remove any; a warehouse manager only their
// own, and only within 24 hours.
async function deleteScan(id, { username, isAdmin }) {
  const r = isAdmin
    ? await query('DELETE FROM barcode_scans WHERE id = $1', [id])
    : await query(`DELETE FROM barcode_scans WHERE id = $1 AND scanned_by = $2
                   AND scanned_at > now() - interval '24 hours'`, [id, username]);
  return r.rowCount > 0;
}

// Full picture for one barcode: the frozen saved record plus the order's
// current state, its products and prices, its shipments and its invoices —
// all read live from the MoySklad mirror.
async function lookupBarcode(raw) {
  const code = normalizeBarcode(raw);
  if (!code) return null;
  const { rows } = await query('SELECT * FROM barcode_scans WHERE barcode = $1', [code]);
  const s = rows[0];
  if (!s) return null;

  const [header, lines, shipments, invoices, siblings] = await Promise.all([
    getOrderHeader(s.order_id),
    getOrderLines(s.order_id),
    query(`
      SELECT d.name, to_char(d.moment, 'YYYY-MM-DD HH24:MI') AS moment_s, d.sum_kopecks,
             COALESCE(st.name, d.state_name) AS state, sr.name AS store_name,
             (SELECT COALESCE(SUM(p.quantity), 0) FROM ms_demand_positions p WHERE p.demand_id = d.id) AS total_qty,
             (SELECT COALESCE(SUM(p.quantity), 0) FROM ms_demand_positions p
               WHERE p.demand_id = d.id AND p.assortment_href = $2) AS product_qty
      FROM ms_demands d
      LEFT JOIN ms_states st ON st.id = d.state_id
      LEFT JOIN ms_stores sr ON sr.id = d.store_id
      WHERE d.order_id = $1 ORDER BY d.moment`, [s.order_id, s.assortment_href]),
    query(`SELECT name, to_char(moment, 'YYYY-MM-DD HH24:MI') AS moment_s, sum_kopecks
           FROM ms_invoices_out WHERE order_id = $1 ORDER BY moment`, [s.order_id]),
    query('SELECT COUNT(*)::int AS n FROM barcode_scans WHERE order_id = $1', [s.order_id]),
  ]);

  const frozenUnit = s.unit_price_kopecks == null ? null : Number(s.unit_price_kopecks);
  const sameProduct = s.assortment_href ? lines.filter(l => l.assortmentHref === s.assortment_href) : [];
  const cur = sameProduct.find(l => l.unitPriceKopecks === frozenUnit) || sameProduct[0] || null;

  return {
    scan: {
      id: Number(s.id), barcode: s.barcode,
      productName: s.product_name || null,
      unitPrice: rub(frozenUnit), listPrice: rub(s.price_kopecks), discount: Number(s.discount) || 0,
      scannedBy: s.scanned_by, scannedAt: s.scanned_at,
    },
    order: {
      id: s.order_id, name: s.order_name, customerId: s.customer_id, customerName: s.customer_name || '—',
      existsInMoySklad: !!header,
      date: header ? header.moment_s : null,
      state: header ? header.state : null,
      total: header ? Number(header.sum_kopecks) / 100 : null,
      paid: header ? Number(header.payed_sum_kopecks) / 100 : null,
      deliveryPlanned: header ? header.delivery_planned : null,
      store: header ? header.store_name : null,
      salesman: header ? header.salesman : null,
      orderedQty: sameProduct.length ? sameProduct.reduce((a, l) => a + l.quantity, 0) : null,
      barcodesScanned: siblings.rows[0].n,
    },
    // The order's products and selling prices — what a barcode saved for the
    // order as a whole (no specific product) was sold as part of.
    orderLines: lines.map(l => ({ productName: l.productName, quantity: l.quantity, unitPrice: l.unitPriceKopecks / 100, discount: l.discount })),
    currentUnitPrice: cur ? cur.unitPriceKopecks / 100 : null,
    priceChangedSinceScan: !!cur && frozenUnit != null && cur.unitPriceKopecks !== frozenUnit,
    shipments: shipments.rows.map(d => ({
      name: d.name, date: d.moment_s, total: Number(d.sum_kopecks) / 100, state: d.state || '—',
      store: d.store_name || '—', totalQty: Number(d.total_qty) || 0,
      productQty: s.assortment_href ? Number(d.product_qty) || 0 : null,
    })),
    invoices: invoices.rows.map(i => ({ name: i.name, date: i.moment_s, total: Number(i.sum_kopecks) / 100 })),
  };
}

module.exports = {
  normalizeBarcode, listOrders, getOrderForScanning, checkCodes, saveBatch, deleteScan, lookupBarcode, recentScans,
};
