'use strict';
require('dotenv').config();
// One-time targeted backfill: the old MoySklad account's sync stopped
// capturing data after 2026-08-03 (a historical sync bug, since fixed) and
// was retired before it caught back up, so Aug 4-31 2026 never made it into
// the old database — and therefore never made it into the merge either.
// This fetches just that missing window LIVE from the old account (its
// token still works even though we've moved off it) and writes it straight
// into the current active database, alongside the already-merged history.
//
// Independent of the regular sync (sync/moysklad-sync.js) — does not touch
// ms_sync_meta, does not run on a schedule, only ever needs running once.
//
// Usage: node sync/backfill-old-account-gap.js
const { getPool } = require('../db/pool');

const OLD_TOKEN = 'f91625566e4e88a6cec8dd55734077180a27659d';
const MS_BASE = 'https://api.moysklad.ru/api/remap/1.2';
const MS_HEADERS = { Authorization: `Bearer ${OLD_TOKEN}`, Accept: 'application/json;charset=utf-8' };
const GAP_FROM = '2026-08-04 00:00:00';
const GAP_TO   = '2026-08-31 23:59:59';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const hrefTail = href => (href || '').split('/').pop().split('?')[0];
const baseNameOf = name => (name || '').replace(/\s*\([^)]*\)\s*$/, '').trim() || (name || '');

async function msGet(path, retries = 6) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    let r;
    try {
      r = await fetch(MS_BASE + path, { headers: MS_HEADERS, signal: AbortSignal.timeout(45000) });
    } catch (e) {
      if (attempt === retries) throw e;
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (r.status === 429) { await sleep(Math.pow(2, attempt) * 2000); continue; }
    if (!r.ok) {
      if (attempt === retries) throw new Error(`MS API ${r.status} on ${path}`);
      await sleep(1500 * (attempt + 1));
      continue;
    }
    return r.json();
  }
}
async function msAll(endpoint, extra = '') {
  const rows = [];
  let offset = 0;
  const limit = 1000;
  while (true) {
    const sep = endpoint.includes('?') ? '&' : '?';
    const data = await msGet(`${endpoint}${sep}limit=${limit}&offset=${offset}${extra}`);
    const batch = data.rows || [];
    rows.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
    await sleep(150);
  }
  return rows;
}
async function fetchAllPositions(kind, id) {
  const path = kind === 'demand' ? `/entity/demand/${id}/positions` : `/entity/customerorder/${id}/positions`;
  const first = await msGet(`${path}?limit=1000`);
  let rows = first.rows || [];
  const total = first.meta?.size || 0;
  if (rows.length < total) {
    const pages = [];
    for (let off = rows.length; off < total; off += 1000) pages.push(msGet(`${path}?limit=1000&offset=${off}`));
    const settled = await Promise.allSettled(pages);
    settled.forEach(r => { if (r.status === 'fulfilled') rows = rows.concat(r.value.rows || []); });
  }
  return rows;
}

// This Neon compute drops the odd connection mid-run (observed repeatedly
// during the earlier historical merge too) — retry with backoff rather than
// losing a whole long-running batch to one blip.
// Uses pool.query() (not a single checked-out client) so every retry gets a
// fresh connection — a client that's hit a fatal connection error is dead
// forever, so retrying *on it* just fails identically every time.
async function queryWithRetry(pool, sql, params, retries = 6) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await pool.query(sql, params);
    } catch (e) {
      if (attempt === retries) throw e;
      const wait = 1500 * (attempt + 1);
      console.log(`  [retry ${attempt + 1}/${retries}] ${e.message} — waiting ${wait}ms`);
      await sleep(wait);
    }
  }
}

async function batchUpsert(pool, table, cols, conflictCols, rows, batchSize = 100) {
  if (!rows.length) return 0;
  const updateCols = cols.filter(c => !conflictCols.includes(c));
  const updateSet = updateCols.map(c => `${c} = EXCLUDED.${c}`).join(', ');
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const values = [];
    const placeholders = batch.map((row, ri) => {
      const base = ri * cols.length;
      const ph = cols.map((c, ci) => `$${base + ci + 1}`).join(', ');
      cols.forEach(c => values.push(row[c] === undefined ? null : row[c]));
      return `(${ph})`;
    }).join(', ');
    await queryWithRetry(pool,
      `INSERT INTO ${table} (${cols.join(', ')}) VALUES ${placeholders}
       ON CONFLICT (${conflictCols.join(', ')}) DO UPDATE SET ${updateSet}`, values);
  }
  return rows.length;
}

async function loadAssortmentMap(pool) {
  const { rows } = await queryWithRetry(pool, 'SELECT href, name, base_name FROM ms_assortment');
  const map = new Map();
  rows.forEach(r => map.set(r.href, { name: r.name, baseName: r.base_name }));
  return map;
}

async function syncPositionsFor(pool, kind, parents, assortmentMap) {
  const table = kind === 'demand' ? 'ms_demand_positions' : 'ms_order_positions';
  const parentCol = kind === 'demand' ? 'demand_id' : 'order_id';
  const BATCH = 8;
  for (let i = 0; i < parents.length; i += BATCH) {
    const slice = parents.slice(i, i + BATCH);
    const results = await Promise.allSettled(slice.map(p => fetchAllPositions(kind, p.id)));
    for (let j = 0; j < slice.length; j++) {
      const parent = slice[j];
      if (results[j].status !== 'fulfilled') { console.error(`  positions failed for ${parent.id}:`, results[j].reason?.message); continue; }
      const positions = results[j].value;
      await queryWithRetry(pool, `DELETE FROM ${table} WHERE ${parentCol}=$1`, [parent.id]);
      if (!positions.length) continue;
      const rows = positions.map((p, idx) => {
        const href = p.assortment?.meta?.href || '';
        const info = assortmentMap.get(href);
        const fullName = info?.name || p.assortment?.name || '—';
        const baseName = info?.baseName || baseNameOf(fullName);
        const row = {
          id: `${parent.id}_${idx}`,
          assortment_href: href || null,
          product_name: fullName,
          base_name: baseName,
          quantity: p.quantity || 0,
          price_kopecks: Math.round(p.price || 0),
          discount: p.discount || 0,
          amount_kopecks: Math.round(p.sum != null ? p.sum : (p.quantity || 0) * (p.price || 0) * (1 - (p.discount || 0) / 100)),
        };
        row[parentCol] = parent.id;
        if (kind === 'demand') row.demand_date = parent.date || null;
        return row;
      });
      const cols = kind === 'demand'
        ? ['id', 'demand_id', 'demand_date', 'assortment_href', 'product_name', 'base_name', 'quantity', 'price_kopecks', 'discount', 'amount_kopecks']
        : ['id', 'order_id', 'assortment_href', 'product_name', 'base_name', 'quantity', 'price_kopecks', 'discount', 'amount_kopecks'];
      await batchUpsert(pool, table, cols, ['id'], rows);
    }
    await sleep(150);
  }
}

async function backfillOrders(pool) {
  const filter = `&filter=${encodeURIComponent(`moment>=${GAP_FROM};moment<=${GAP_TO}`)}`;
  const rawRows = await msAll('/entity/customerorder', `${filter}&expand=agent,state&order=moment,asc`);
  console.log(`  fetched ${rawRows.length} orders from old account for the gap window`);

  const rows = rawRows.map(r => ({
    id: r.id, name: r.name || '',
    moment: (r.moment || '').slice(0, 19) || null,
    date: (r.moment || '').slice(0, 10) || null,
    sum_kopecks: Math.round(r.sum || 0), payed_sum_kopecks: Math.round(r.payedSum || 0),
    customer_id: hrefTail(r.agent?.meta?.href) || null, customer_name: r.agent?.name || null,
    owner_id: hrefTail(r.owner?.meta?.href) || null,
    state_id: hrefTail(r.state?.meta?.href) || null, state_name: r.state?.name || null,
    delivery_planned_moment: (r.deliveryPlannedMoment || '').slice(0, 19) || null,
    store_id: hrefTail(r.store?.meta?.href) || null,
    updated_at: (r.updated || '').slice(0, 19) || null,
  }));
  const cols = ['id', 'name', 'moment', 'date', 'sum_kopecks', 'payed_sum_kopecks', 'customer_id', 'customer_name',
                'owner_id', 'state_id', 'state_name', 'delivery_planned_moment', 'store_id', 'updated_at'];
  await batchUpsert(pool, 'ms_orders', cols, ['id'], rows);
  console.log(`  ms_orders: ${rows.length} upserted`);

  const assortmentMap = await loadAssortmentMap(pool);
  await syncPositionsFor(pool, 'customerorder', rows.map(r => ({ id: r.id })), assortmentMap);
  console.log(`  ms_order_positions: synced for ${rows.length} orders`);
  return rows.length;
}

async function backfillDemands(pool) {
  const filter = `&filter=${encodeURIComponent(`moment>=${GAP_FROM};moment<=${GAP_TO}`)}`;
  const rawRows = await msAll('/entity/demand', `${filter}&expand=agent,state&order=moment,asc`);
  console.log(`  fetched ${rawRows.length} demands from old account for the gap window`);

  const rows = rawRows.map(r => ({
    id: r.id, name: r.name || '',
    moment: (r.moment || '').slice(0, 19) || null,
    date: (r.moment || '').slice(0, 10) || null,
    sum_kopecks: Math.round(r.sum || 0),
    customer_id: hrefTail(r.agent?.meta?.href) || null, customer_name: r.agent?.name || null,
    owner_id: hrefTail(r.owner?.meta?.href) || null,
    order_id: hrefTail(r.customerOrder?.meta?.href) || null,
    state_id: hrefTail(r.state?.meta?.href) || null, state_name: r.state?.name || null,
    store_id: hrefTail(r.store?.meta?.href) || null,
    updated_at: (r.updated || '').slice(0, 19) || null,
  }));
  const cols = ['id', 'name', 'moment', 'date', 'sum_kopecks', 'customer_id', 'customer_name',
                'owner_id', 'order_id', 'state_id', 'state_name', 'store_id', 'updated_at'];
  await batchUpsert(pool, 'ms_demands', cols, ['id'], rows);
  console.log(`  ms_demands: ${rows.length} upserted`);

  const assortmentMap = await loadAssortmentMap(pool);
  await syncPositionsFor(pool, 'demand', rows.map(r => ({ id: r.id, date: r.date })), assortmentMap);
  console.log(`  ms_demand_positions: synced for ${rows.length} demands`);
  return rows.length;
}

async function main() {
  console.log(`== Backfilling old-account gap: ${GAP_FROM} .. ${GAP_TO} ==`);
  const pool = getPool();
  console.log('Orders:');
  await backfillOrders(pool);
  console.log('Demands:');
  await backfillDemands(pool);
  console.log('\n✓ Gap backfill complete.');
}

main().catch(e => { console.error('Gap backfill failed:', e.message); process.exit(1); });
