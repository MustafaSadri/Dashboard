'use strict';
// Postgres-backed stand-in for the live MoySklad JSON API.
//
// server.js's `ms(path)` helper is the single choke point every MoySklad fetch in
// this app goes through (directly, or via msAll()/the shared cached() helpers).
// When MS_DATA_SOURCE=postgres, ms() delegates here instead of doing a live HTTP
// fetch. shimRequest(path) parses the same endpoint+querystring MoySklad would
// have received and returns a JSON object shaped exactly like the real API
// response (same field names/nesting), computed from the synced Postgres tables.
// This means every route/helper in server.js keeps working unmodified — they
// have no idea whether the data came from the network or the database.
const { query } = require('./pool');
const { getMinDate } = require('../lib/request-context');

const MS_BASE = 'https://api.moysklad.ru/api/remap/1.2';

// ── href builders (mimic MoySklad's meta.href so downstream code that does
//    `href.split('/').pop()` to recover an ID keeps working unchanged) ──────
const cpHref    = id => id ? `${MS_BASE}/entity/counterparty/${id}` : undefined;
const empHref   = id => id ? `${MS_BASE}/entity/employee/${id}` : undefined;
const ordHref   = id => id ? `${MS_BASE}/entity/customerorder/${id}` : undefined;
const storeHref = id => id ? `${MS_BASE}/entity/store/${id}` : undefined;
const stateHref = id => `${MS_BASE}/entity/customerorder/metadata/states/${id || ''}`;

// ── path/query parsing ──────────────────────────────────────────────────────
function routePath(path) {
  const i = path.indexOf('?');
  return i === -1 ? path : path.slice(0, i);
}
function parseQS(path) {
  const i = path.indexOf('?');
  return new URLSearchParams(i === -1 ? '' : path.slice(i + 1));
}
function hrefTail(href) {
  return (href || '').split('/').pop().split('?')[0];
}
// MoySklad filter syntax: clauses joined by ';', each "field<op>value" (op = >=, <=, >, <, =)
function parseFilterClauses(filterStr) {
  const out = [];
  if (!filterStr) return out;
  filterStr.split(';').forEach(part => {
    const m = part.match(/^([A-Za-z]+)(>=|<=|>|<|=)(.*)$/);
    if (m) out.push({ field: m[1], op: m[2], value: m[3] });
  });
  return out;
}
function buildWhere(clauses, fieldMap) {
  const conds = [];
  const vals = [];
  clauses.forEach(c => {
    const target = fieldMap[c.field];
    if (!target) return;
    if (target.type === 'timestamp') {
      vals.push(c.value);
      conds.push(`${target.col} ${c.op} $${vals.length}::timestamp`);
    } else if (target.type === 'href_id') {
      vals.push(hrefTail(c.value));
      conds.push(`${target.col} = $${vals.length}`);
    }
  });
  return { where: conds.length ? 'WHERE ' + conds.join(' AND ') : '', vals };
}
// ANDs a role-based `<momentCol> >= $N` floor onto a WHERE clause already
// built by buildWhere() (or hand-built, for the profit handlers) — the single
// point every date-scoped handler goes through so a Sales Director login can
// never see pre-cutover data, regardless of which route/filter reached it.
// See lib/request-context.js for the role -> date mapping.
function applyMinDateFloor(where, vals, momentCol) {
  const minDate = getMinDate();
  if (!minDate) return { where, vals };
  const newVals = vals.slice();
  newVals.push(minDate);
  const clause = `${momentCol} >= $${newVals.length}::timestamp`;
  return { where: where ? `${where} AND ${clause}` : `WHERE ${clause}`, vals: newVals };
}
function pageParams(qs, defaultLimit = 1000) {
  return {
    limit: parseInt(qs.get('limit'), 10) || defaultLimit,
    offset: parseInt(qs.get('offset'), 10) || 0,
  };
}
function orderDirection(qs) {
  const [, dirRaw] = (qs.get('order') || 'moment,asc').split(',');
  return dirRaw === 'desc' ? 'DESC' : 'ASC';
}

// ── row → MoySklad-shaped object mappers ────────────────────────────────────
function rowToDemand(r) {
  return {
    id: r.id,
    name: r.name || '',
    moment: r.moment_s,
    sum: Number(r.sum_kopecks) || 0,
    agent: { name: r.customer_name || '—', meta: r.customer_id ? { href: cpHref(r.customer_id) } : {} },
    owner: { meta: r.owner_id ? { href: empHref(r.owner_id) } : {} },
    customerOrder: r.order_id ? { meta: { href: ordHref(r.order_id) } } : null,
    // MoySklad's own expand=state silently drops .name at large page sizes even
    // though the href/id stays — always keep the href so resolveState()'s
    // stateMap fallback (matching the live-API code path) still works.
    state: r.state_id ? { name: r.state_name || undefined, meta: { href: stateHref(r.state_id) } } : null,
    store: r.store_id ? { meta: { href: storeHref(r.store_id) } } : null,
    updatedAt: r.updated_s,
  };
}
function rowToOrder(r) {
  return {
    id: r.id,
    name: r.name || '',
    moment: r.moment_s,
    sum: Number(r.sum_kopecks) || 0,
    payedSum: Number(r.payed_sum_kopecks) || 0,
    agent: { name: r.customer_name || '—', meta: r.customer_id ? { href: cpHref(r.customer_id) } : {} },
    owner: { meta: r.owner_id ? { href: empHref(r.owner_id) } : {} },
    // MoySklad's own expand=state silently drops .name at large page sizes even
    // though the href/id stays — always keep the href so resolveState()'s
    // stateMap fallback (matching the live-API code path) still works.
    state: r.state_id ? { name: r.state_name || undefined, meta: { href: stateHref(r.state_id) } } : null,
    deliveryPlannedMoment: r.delivery_s || null,
    store: r.store_id ? { name: r.store_name || '—', meta: { href: storeHref(r.store_id) } } : null,
    updatedAt: r.updated_s,
  };
}
function rowToPosition(r) {
  return {
    quantity: Number(r.quantity) || 0,
    price: Number(r.price_kopecks) || 0,
    discount: Number(r.discount) || 0,
    sum: Number(r.amount_kopecks) || 0,
    assortment: { name: r.product_name || '—', meta: { href: r.assortment_href, type: 'product' } },
  };
}

const MOMENT_SQL   = `to_char(moment,'YYYY-MM-DD HH24:MI:SS')||'.000'`;
const UPDATED_SQL  = `to_char(updated_at,'YYYY-MM-DD HH24:MI:SS')||'.000'`;

// ── /context/employee ────────────────────────────────────────────────────
function contextEmployeeHandler() {
  return { name: 'Platina Sync', fullName: 'Platina Sync (Postgres)', position: 'MoySklad (synced)', accountId: 'postgres-sync' };
}

// ── /report/stock/all ────────────────────────────────────────────────────
async function stockAllHandler(qs) {
  const { limit, offset } = pageParams(qs);
  const { rows } = await query(
    `SELECT assortment_href, name, code, quantity, price_kopecks, folder_name,
            COUNT(*) OVER() AS total_count
     FROM ms_stock ORDER BY name ASC LIMIT $1 OFFSET $2`, [limit, offset]);
  const total = rows.length ? Number(rows[0].total_count) : 0;
  return {
    rows: rows.map(r => ({
      name: r.name,
      code: r.code,
      quantity: Number(r.quantity) || 0,
      price: Number(r.price_kopecks) || 0,
      assortment: { name: r.name, meta: { href: r.assortment_href, type: 'product' } },
      folder: r.folder_name ? { name: r.folder_name } : null,
    })),
    meta: { size: total },
  };
}

// ── /entity/customerorder/metadata ───────────────────────────────────────
async function statesMetadataHandler() {
  const { rows } = await query(`SELECT id, name FROM ms_states WHERE entity_type='customerorder'`);
  return { states: { rows: rows.map(r => ({ id: r.id, name: r.name, meta: { href: stateHref(r.id) } })) } };
}

// ── /entity/demand ────────────────────────────────────────────────────────
const DEMAND_FIELD_MAP = {
  moment:    { col: 'dm.moment', type: 'timestamp' },
  updatedAt: { col: 'dm.updated_at', type: 'timestamp' },
  agent:     { col: 'dm.customer_id', type: 'href_id' },
};
async function demandListHandler(qs) {
  const clauses = parseFilterClauses(qs.get('filter'));
  let { where, vals } = buildWhere(clauses, DEMAND_FIELD_MAP);
  ({ where, vals } = applyMinDateFloor(where, vals, 'dm.moment'));
  const dir = orderDirection(qs);
  const { limit, offset } = pageParams(qs);
  vals.push(limit, offset);
  const sql = `
    SELECT dm.id, dm.name, dm.sum_kopecks, dm.customer_id,
           COALESCE(cp.name, dm.customer_name) AS customer_name,
           dm.owner_id, dm.order_id, dm.state_id,
           COALESCE(mst.name, dm.state_name) AS state_name, dm.store_id,
           to_char(dm.moment,'YYYY-MM-DD HH24:MI:SS')||'.000' AS moment_s,
           to_char(dm.updated_at,'YYYY-MM-DD HH24:MI:SS')||'.000' AS updated_s,
           COUNT(*) OVER() AS total_count
    FROM ms_demands dm
    LEFT JOIN ms_counterparties cp ON cp.id = dm.customer_id
    LEFT JOIN ms_states mst ON mst.id = dm.state_id
    ${where}
    ORDER BY dm.moment ${dir} NULLS LAST
    LIMIT $${vals.length - 1} OFFSET $${vals.length}`;
  const { rows } = await query(sql, vals);
  const total = rows.length ? Number(rows[0].total_count) : 0;
  return { rows: rows.map(rowToDemand), meta: { size: total } };
}

// ── /entity/customerorder ────────────────────────────────────────────────
const ORDER_FIELD_MAP = {
  moment:    { col: 'o.moment', type: 'timestamp' },
  updatedAt: { col: 'o.updated_at', type: 'timestamp' },
  agent:     { col: 'o.customer_id', type: 'href_id' },
};
async function orderListHandler(qs) {
  const clauses = parseFilterClauses(qs.get('filter'));
  let { where, vals } = buildWhere(clauses, ORDER_FIELD_MAP);
  ({ where, vals } = applyMinDateFloor(where, vals, 'o.moment'));
  const dir = orderDirection(qs);
  const { limit, offset } = pageParams(qs);
  vals.push(limit, offset);
  const sql = `
    SELECT o.id, o.name, o.sum_kopecks, o.payed_sum_kopecks, o.customer_id,
           COALESCE(cp.name, o.customer_name) AS customer_name,
           o.owner_id, o.state_id, COALESCE(mst.name, o.state_name) AS state_name,
           o.store_id, st.name AS store_name,
           to_char(o.moment,'YYYY-MM-DD HH24:MI:SS')||'.000' AS moment_s,
           to_char(o.delivery_planned_moment,'YYYY-MM-DD HH24:MI:SS')||'.000' AS delivery_s,
           to_char(o.updated_at,'YYYY-MM-DD HH24:MI:SS')||'.000' AS updated_s,
           COUNT(*) OVER() AS total_count
    FROM ms_orders o
    LEFT JOIN ms_stores st ON st.id = o.store_id
    LEFT JOIN ms_counterparties cp ON cp.id = o.customer_id
    LEFT JOIN ms_states mst ON mst.id = o.state_id
    ${where}
    ORDER BY o.moment ${dir} NULLS LAST
    LIMIT $${vals.length - 1} OFFSET $${vals.length}`;
  const { rows } = await query(sql, vals);
  const total = rows.length ? Number(rows[0].total_count) : 0;
  return { rows: rows.map(rowToOrder), meta: { size: total } };
}
async function orderSingleHandler(id) {
  const { rows } = await query(
    `SELECT o.id, o.name, o.sum_kopecks, o.payed_sum_kopecks, o.customer_id,
            COALESCE(cp.name, o.customer_name) AS customer_name,
            o.owner_id, o.state_id, COALESCE(mst.name, o.state_name) AS state_name,
            o.store_id, st.name AS store_name,
            to_char(o.moment,'YYYY-MM-DD HH24:MI:SS')||'.000' AS moment_s,
            to_char(o.delivery_planned_moment,'YYYY-MM-DD HH24:MI:SS')||'.000' AS delivery_s,
            to_char(o.updated_at,'YYYY-MM-DD HH24:MI:SS')||'.000' AS updated_s
     FROM ms_orders o
     LEFT JOIN ms_stores st ON st.id = o.store_id
     LEFT JOIN ms_counterparties cp ON cp.id = o.customer_id
     LEFT JOIN ms_states mst ON mst.id = o.state_id
     WHERE o.id = $1`, [id]);
  if (!rows.length) throw new Error('MS API 404 /entity/customerorder/' + id);
  return rowToOrder(rows[0]);
}

// ── positions sub-resources ──────────────────────────────────────────────
async function demandPositionsHandler(demandId, qs) {
  const { limit, offset } = pageParams(qs);
  const { rows } = await query(
    `SELECT assortment_href, product_name, quantity, price_kopecks, discount, amount_kopecks,
            COUNT(*) OVER() AS total_count
     FROM ms_demand_positions WHERE demand_id=$1 ORDER BY id LIMIT $2 OFFSET $3`,
    [demandId, limit, offset]);
  const total = rows.length ? Number(rows[0].total_count) : 0;
  return { rows: rows.map(rowToPosition), meta: { size: total } };
}
async function orderPositionsHandler(orderId, qs) {
  const { limit, offset } = pageParams(qs);
  const { rows } = await query(
    `SELECT assortment_href, product_name, quantity, price_kopecks, discount, amount_kopecks,
            COUNT(*) OVER() AS total_count
     FROM ms_order_positions WHERE order_id=$1 ORDER BY id LIMIT $2 OFFSET $3`,
    [orderId, limit, offset]);
  const total = rows.length ? Number(rows[0].total_count) : 0;
  return { rows: rows.map(rowToPosition), meta: { size: total } };
}

// ── counterparties ────────────────────────────────────────────────────────
async function counterpartyListHandler(qs) {
  const { limit, offset } = pageParams(qs);
  const { rows } = await query(
    `SELECT id, name, code, email, phone, COUNT(*) OVER() AS total_count
     FROM ms_counterparties ORDER BY name ASC LIMIT $1 OFFSET $2`, [limit, offset]);
  const total = rows.length ? Number(rows[0].total_count) : 0;
  return {
    rows: rows.map(r => ({ id: r.id, name: r.name, code: r.code, email: r.email, phone: r.phone, meta: { href: cpHref(r.id) } })),
    meta: { size: total },
  };
}
async function counterpartySingleHandler(id) {
  const { rows } = await query(`SELECT id, name, code, email, phone FROM ms_counterparties WHERE id=$1`, [id]);
  if (!rows.length) throw new Error('MS API 404 /entity/counterparty/' + id);
  const r = rows[0];
  return { id: r.id, name: r.name, code: r.code, email: r.email, phone: r.phone, meta: { href: cpHref(r.id) } };
}

// ── employees ─────────────────────────────────────────────────────────────
async function employeeListHandler(qs) {
  const { limit, offset } = pageParams(qs);
  const { rows } = await query(
    `SELECT id, name, short_fio, uid, position, COUNT(*) OVER() AS total_count
     FROM ms_employees ORDER BY name ASC LIMIT $1 OFFSET $2`, [limit, offset]);
  const total = rows.length ? Number(rows[0].total_count) : 0;
  return {
    rows: rows.map(r => ({ id: r.id, name: r.name, shortFio: r.short_fio, uid: r.uid, position: r.position, meta: { href: empHref(r.id) } })),
    meta: { size: total },
  };
}
async function employeeSingleHandler(id) {
  const { rows } = await query(`SELECT id, name, short_fio, uid, position FROM ms_employees WHERE id=$1`, [id]);
  if (!rows.length) throw new Error('MS API 404 /entity/employee/' + id);
  const r = rows[0];
  return { id: r.id, name: r.name, shortFio: r.short_fio, uid: r.uid, position: r.position, meta: { href: empHref(r.id) } };
}

// ── stores ────────────────────────────────────────────────────────────────
async function storeListHandler(qs) {
  const { limit, offset } = pageParams(qs, 100);
  const { rows } = await query(
    `SELECT id, name, COUNT(*) OVER() AS total_count
     FROM ms_stores ORDER BY name ASC LIMIT $1 OFFSET $2`, [limit, offset]);
  const total = rows.length ? Number(rows[0].total_count) : 0;
  return { rows: rows.map(r => ({ id: r.id, name: r.name, meta: { href: storeHref(r.id) } })), meta: { size: total } };
}

// ── assortment (products/variants name map) ─────────────────────────────
async function assortmentListHandler(qs) {
  const { limit, offset } = pageParams(qs);
  const { rows } = await query(
    `SELECT id, name, href, type, COUNT(*) OVER() AS total_count
     FROM ms_assortment ORDER BY name ASC LIMIT $1 OFFSET $2`, [limit, offset]);
  const total = rows.length ? Number(rows[0].total_count) : 0;
  return { rows: rows.map(r => ({ id: r.id, name: r.name, meta: { href: r.href, type: r.type } })), meta: { size: total } };
}
async function assortmentSingleHandler(id) {
  const { rows } = await query(`SELECT id, name, href, type FROM ms_assortment WHERE id=$1`, [id]);
  if (!rows.length) throw new Error('MS API 404 assortment ' + id);
  const r = rows[0];
  return { id: r.id, name: r.name, meta: { href: r.href, type: r.type } };
}

// ── /report/profit/byproduct — reconstructed from synced shipment line items.
//    Only sellSum/sellQuantity are ever consumed by this app (never the
//    margin/profit field), so a SUM() over ms_demand_positions is exact. ─────
async function profitByProductHandler(qs) {
  const momentFrom = qs.get('momentFrom');
  const momentTo   = qs.get('momentTo');
  const limit       = parseInt(qs.get('limit'), 10) || 1000;
  const cpClause    = parseFilterClauses(qs.get('filter')).find(c => c.field === 'counterparty');

  const conds = [];
  let vals = [];
  if (momentFrom) { vals.push(momentFrom); conds.push(`d.moment >= $${vals.length}::timestamp`); }
  if (momentTo)   { vals.push(momentTo);   conds.push(`d.moment <= $${vals.length}::timestamp`); }
  if (cpClause)   { vals.push(hrefTail(cpClause.value)); conds.push(`d.customer_id = $${vals.length}`); }
  let where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  ({ where, vals } = applyMinDateFloor(where, vals, 'd.moment'));
  vals.push(limit);

  // Group by assortment_href (the stable product id) rather than the raw
  // dp.product_name snapshot: product_name is frozen at the time each position
  // was synced, so a product renamed in MoySklad after some of its sales were
  // already synced ends up with two different name strings for the same
  // physical product, splitting it into separate rows here. Using the
  // current ms_assortment.name (falling back to the snapshot for hrefs no
  // longer present there) keeps every sale of one product under one row.
  const sql = `
    WITH agg AS (
      SELECT dp.assortment_href, COALESCE(a.name, dp.product_name) AS product_name,
             SUM(dp.amount_kopecks) AS sell_sum,
             SUM(dp.quantity) AS sell_qty
      FROM ms_demand_positions dp
      JOIN ms_demands d ON d.id = dp.demand_id
      LEFT JOIN ms_assortment a ON a.href = dp.assortment_href
      ${where}
      GROUP BY dp.assortment_href, COALESCE(a.name, dp.product_name)
    )
    SELECT *, COUNT(*) OVER() AS total_count FROM agg ORDER BY sell_sum DESC LIMIT $${vals.length}`;
  const { rows } = await query(sql, vals);
  return {
    rows: rows.map(r => ({
      assortment: { name: r.product_name || '—', meta: { href: r.assortment_href, type: 'product' } },
      sellSum: Number(r.sell_sum) || 0,
      sellQuantity: Number(r.sell_qty) || 0,
    })),
    meta: { size: rows.length ? Number(rows[0].total_count) : 0 },
  };
}

// A product renamed between MoySklad accounts (e.g. the old account's
// "ELFBAR GH23000 Disposable 850mAh Planet Edition" became the new account's
// "ELFBAR GH23000") keeps the same article/code — MoySklad's own SKU number —
// even though its name changed. Maps each parent product's base_name to that
// code, so name-based model grouping (server.js's baseNameOf) can be given a
// stable cross-rename key: two different base_names sharing one code are the
// same real product line. Only 'product'-type rows carry the parent's own
// code (variants have their own per-flavor code, not the model's).
async function getProductFamilyMap() {
  const { rows } = await query(
    `SELECT base_name, code FROM ms_assortment WHERE type = 'product' AND code IS NOT NULL AND code != ''`);
  return new Map(rows.map(r => [r.base_name, r.code]));
}

// ── /report/profit/bycounterparty — SUM(demand.sum) grouped by customer ────
async function profitByCounterpartyHandler(qs) {
  const momentFrom = qs.get('momentFrom');
  const momentTo   = qs.get('momentTo');
  const limit       = parseInt(qs.get('limit'), 10) || 1000;

  const conds = [];
  let vals = [];
  if (momentFrom) { vals.push(momentFrom); conds.push(`moment >= $${vals.length}::timestamp`); }
  if (momentTo)   { vals.push(momentTo);   conds.push(`moment <= $${vals.length}::timestamp`); }
  let where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  ({ where, vals } = applyMinDateFloor(where, vals, 'moment'));
  vals.push(limit);

  const sql = `
    WITH agg AS (
      SELECT customer_id,
             SUM(sum_kopecks) AS sell_sum,
             COUNT(*) AS sales_count
      FROM ms_demands
      ${where}
      GROUP BY customer_id
    )
    SELECT agg.*, COALESCE(cp.name, 'Unknown') AS customer_name, COUNT(*) OVER() AS total_count
    FROM agg LEFT JOIN ms_counterparties cp ON cp.id = agg.customer_id
    ORDER BY sell_sum DESC LIMIT $${vals.length}`;
  const { rows } = await query(sql, vals);
  return {
    rows: rows.map(r => ({
      counterparty: { name: r.customer_name || '—', meta: { href: cpHref(r.customer_id) } },
      sellSum: Number(r.sell_sum) || 0,
      salesCount: Number(r.sales_count) || 0,
    })),
    meta: { size: rows.length ? Number(rows[0].total_count) : 0 },
  };
}

// ── dispatcher ────────────────────────────────────────────────────────────
async function shimRequest(path) {
  const rp = routePath(path);
  const qs = parseQS(path);

  if (rp === '/context/employee')              return contextEmployeeHandler();
  if (rp === '/report/stock/all')               return stockAllHandler(qs);
  if (rp === '/entity/customerorder/metadata')  return statesMetadataHandler();
  if (rp === '/entity/demand')                  return demandListHandler(qs);
  if (rp === '/entity/customerorder')           return orderListHandler(qs);
  if (rp === '/entity/counterparty')            return counterpartyListHandler(qs);
  if (rp === '/entity/employee')                return employeeListHandler(qs);
  if (rp === '/entity/assortment')              return assortmentListHandler(qs);
  if (rp === '/entity/store')                   return storeListHandler(qs);
  if (rp === '/report/profit/byproduct')        return profitByProductHandler(qs);
  if (rp === '/report/profit/bycounterparty')   return profitByCounterpartyHandler(qs);

  let m;
  if ((m = rp.match(/^\/entity\/demand\/([^/]+)\/positions$/)))        return demandPositionsHandler(m[1], qs);
  if ((m = rp.match(/^\/entity\/customerorder\/([^/]+)\/positions$/))) return orderPositionsHandler(m[1], qs);
  if ((m = rp.match(/^\/entity\/customerorder\/([^/]+)$/)))            return orderSingleHandler(m[1]);
  if ((m = rp.match(/^\/entity\/counterparty\/([^/]+)$/)))             return counterpartySingleHandler(m[1]);
  if ((m = rp.match(/^\/entity\/employee\/([^/]+)$/)))                 return employeeSingleHandler(m[1]);
  if ((m = rp.match(/^\/entity\/(?:product|variant)\/([^/]+)$/)))      return assortmentSingleHandler(m[1]);

  throw new Error('MS Postgres shim: unhandled endpoint ' + rp);
}

// ── Batch PCS helpers ────────────────────────────────────────────────────
// getPendingPCS/getTodayPCS/getPCSByStore in server.js normally loop calling
// ms() once per order/demand id — fine against the live API, but against a
// remote Postgres each iteration becomes its own network round trip. These
// give server.js a single-query equivalent when MS_DATA_SOURCE=postgres.
async function sumOrderPositionsPCS(orderIds) {
  if (!orderIds.length) return 0;
  const { rows } = await query(
    `SELECT COALESCE(SUM(quantity), 0) AS total FROM ms_order_positions WHERE order_id = ANY($1::text[])`,
    [orderIds]);
  return Math.round(Number(rows[0].total) || 0);
}
async function sumDemandPositionsPCS(demandIds) {
  if (!demandIds.length) return 0;
  const { rows } = await query(
    `SELECT COALESCE(SUM(quantity), 0) AS total FROM ms_demand_positions WHERE demand_id = ANY($1::text[])`,
    [demandIds]);
  return Math.round(Number(rows[0].total) || 0);
}
async function sumDemandPCSByStore(demandIds) {
  if (!demandIds.length) return { total: 0, byStore: [] };
  const { rows } = await query(
    `SELECT COALESCE(st.name, 'Unknown') AS store, SUM(dp.quantity) AS pcs
     FROM ms_demand_positions dp
     JOIN ms_demands d ON d.id = dp.demand_id
     LEFT JOIN ms_stores st ON st.id = d.store_id
     WHERE dp.demand_id = ANY($1::text[])
     GROUP BY st.name
     ORDER BY pcs DESC`,
    [demandIds]);
  const byStore = rows.map(r => ({ store: r.store, pcs: Math.round(Number(r.pcs) || 0) }));
  const total = byStore.reduce((a, r) => a + r.pcs, 0);
  return { total, byStore };
}
// Batch order-owner resolution (orders-status resolves each unique owner href
// individually) and batch parent-order lookup (salesman resolves each demand's
// parent order individually) — same round-trip-count problem as above.
async function employeesByIds(ids) {
  if (!ids.length) return [];
  const { rows } = await query(`SELECT id, name, short_fio, uid, position FROM ms_employees WHERE id = ANY($1::text[])`, [ids]);
  return rows.map(r => ({ id: r.id, name: r.name, shortFio: r.short_fio, uid: r.uid, position: r.position, meta: { href: empHref(r.id) } }));
}
async function ordersByIds(ids) {
  if (!ids.length) return [];
  const { rows } = await query(
    `SELECT o.id, o.name, o.sum_kopecks, o.customer_id, COALESCE(cp.name, o.customer_name) AS customer_name, o.owner_id
     FROM ms_orders o LEFT JOIN ms_counterparties cp ON cp.id = o.customer_id
     WHERE o.id = ANY($1::text[])`, [ids]);
  return rows.map(r => ({
    id: r.id, name: r.name || '',
    sum: Number(r.sum_kopecks) || 0,
    agent: { name: r.customer_name || '—', meta: r.customer_id ? { href: cpHref(r.customer_id) } : {} },
    owner: { meta: r.owner_id ? { href: empHref(r.owner_id) } : {} },
  }));
}
async function orderPositionsPCSByOrder(orderIds) {
  if (!orderIds.length) return {};
  const { rows } = await query(
    `SELECT order_id, COALESCE(SUM(quantity), 0) AS pcs FROM ms_order_positions WHERE order_id = ANY($1::text[]) GROUP BY order_id`,
    [orderIds]);
  const map = {};
  rows.forEach(r => { map[r.order_id] = Math.round(Number(r.pcs) || 0); });
  return map;
}

// ── Sync health — powers the "data may be stale / token blocked" banner ────
// Checks the two entities that actually drive what's on screen (orders/demands).
async function getSyncHealth() {
  const { rows } = await query(
    `SELECT entity, last_status, last_error,
            EXTRACT(EPOCH FROM (now() - last_incremental_sync_at)) AS seconds_since
     FROM ms_sync_meta WHERE entity IN ('orders','demands')`);
  return rows;
}

module.exports = {
  shimRequest, MS_BASE,
  sumOrderPositionsPCS, sumDemandPositionsPCS, sumDemandPCSByStore,
  employeesByIds, ordersByIds, orderPositionsPCSByOrder,
  getSyncHealth, getProductFamilyMap,
};
