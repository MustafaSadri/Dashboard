'use strict';
require('dotenv').config();
// MoySklad → Postgres background sync. Mirrors the retry/backoff/pagination
// patterns already proven in sync-ms-data.js (the prior, now-superseded,
// MS → Mongo sync), but targets the ms_* Postgres tables instead. Every
// entity step is independently try/caught and recorded in ms_sync_meta, so
// one entity's failure never blocks the others, and the next tick retries it.
//
// Incremental watermarks are derived from the MAX `updated` seen in each
// entity's own fetched rows (MoySklad's clock), never from local server time —
// this sidesteps any TZ mismatch between this process and MoySklad's servers.
const { getPool } = require('../db/pool');

const MS_BASE     = 'https://api.moysklad.ru/api/remap/1.2';
const TOKEN       = process.env.TOKEN || '';
const MS_SYNC_FROM = process.env.MS_SYNC_FROM || '2024-12-01';
const MS_HEADERS  = { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json;charset=utf-8' };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const hrefTail = href => (href || '').split('/').pop().split('?')[0];
const baseNameOf = name => (name || '').replace(/\s*\([^)]*\)\s*$/, '').trim() || (name || '');

// ── Live MoySklad fetch (rate-limit-aware, paginated) ───────────────────────
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
    // 401/403/412 are auth/access errors (blocked or expired token) — retrying
    // won't fix them and just sends more requests at an already-throttled
    // token, making the underlying problem worse. Fail fast on these instead.
    if (r.status === 401 || r.status === 403 || r.status === 412) {
      throw new Error(`MS API ${r.status} on ${path}`);
    }
    if (!r.ok) {
      if (attempt === retries) throw new Error(`MS API ${r.status} on ${path}`);
      await sleep(1500 * (attempt + 1));
      continue;
    }
    return r.json();
  }
  throw new Error(`MS API failed after ${retries} retries: ${path}`);
}
async function msAll(endpoint, extra = '', max = 500000) {
  const rows = [];
  let offset = 0;
  const limit = 1000;
  while (rows.length < max) {
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

// ── Generic batched upsert ───────────────────────────────────────────────
async function batchUpsert(client, table, cols, conflictCols, rows, batchSize = 200) {
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
    await client.query(
      `INSERT INTO ${table} (${cols.join(', ')}) VALUES ${placeholders}
       ON CONFLICT (${conflictCols.join(', ')}) DO UPDATE SET ${updateSet}`, values);
  }
  return rows.length;
}

// ── Sync meta (per-entity watermark/status) ─────────────────────────────
async function getSyncState(client, entity) {
  const { rows } = await client.query(
    `SELECT last_full_sync_at, to_char(watermark,'YYYY-MM-DD HH24:MI:SS') AS watermark_s
     FROM ms_sync_meta WHERE entity=$1`, [entity]);
  return rows[0] || null;
}
async function upsertMeta(client, entity, fields) {
  const cols = ['entity', ...Object.keys(fields)];
  const vals = [entity, ...Object.values(fields)];
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const updateSet = Object.keys(fields).map(k => `${k}=EXCLUDED.${k}`).join(', ');
  await client.query(
    `INSERT INTO ms_sync_meta (${cols.join(', ')}) VALUES (${placeholders})
     ON CONFLICT (entity) DO UPDATE SET ${updateSet}`, vals);
}
// Never repeat a full (expensive: paginated list + per-record positions)
// resync more often than this, even if we still have no usable watermark.
// This is a hard circuit breaker against the exact runaway pattern that can
// get a MoySklad token rate-limited/blocked: full-resyncing on every 5-minute
// tick forever because a watermark never got captured.
const FULL_SYNC_COOLDOWN_HOURS = 6;
function coolingDown(state) {
  if (!state?.last_full_sync_at) return false;
  const hoursSince = (Date.now() - new Date(state.last_full_sync_at).getTime()) / 3600000;
  return hoursSince < FULL_SYNC_COOLDOWN_HOURS;
}
// If MoySklad never gave us a real updated on any row of a sync batch, fall
// back to our own clock (minus a safety margin) as the watermark. This is
// less precise than a true server-provided high-water mark, but it guarantees
// the NEXT tick goes incremental instead of repeating a full resync forever.
function fallbackWatermark() {
  return new Date(Date.now() - 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

async function loadAssortmentMap(client) {
  const { rows } = await client.query('SELECT href, name, base_name FROM ms_assortment');
  const map = new Map();
  rows.forEach(r => map.set(r.href, { name: r.name, baseName: r.base_name }));
  return map;
}

// ── Reference/small tables — full refresh every tick (cheap) ────────────
async function syncStates(client) {
  try {
    const meta = await msGet('/entity/customerorder/metadata');
    const statesArr = Array.isArray(meta.states) ? meta.states : (meta.states?.rows || []);
    const rows = statesArr.filter(s => s.id && s.name).map(s => ({ id: s.id, entity_type: 'customerorder', name: s.name }));
    await batchUpsert(client, 'ms_states', ['id', 'entity_type', 'name'], ['id'], rows);
    await upsertMeta(client, 'states', { last_full_sync_at: new Date(), last_incremental_sync_at: new Date(), last_status: 'ok', last_error: null, last_rows: rows.length });
  } catch (e) {
    await upsertMeta(client, 'states', { last_status: 'error', last_error: e.message.slice(0, 500) }).catch(() => {});
    console.error('[ms-sync] states failed:', e.message);
  }
}
async function syncEmployees(client) {
  try {
    const rows = (await msAll('/entity/employee', '')).map(e => ({
      id: e.id, name: e.name || e.shortFio || e.uid || '—',
      short_fio: e.shortFio || null, uid: e.uid || null, position: e.position || null,
      updated_at: (e.updated || '').slice(0, 19) || null,
    }));
    await batchUpsert(client, 'ms_employees', ['id', 'name', 'short_fio', 'uid', 'position', 'updated_at'], ['id'], rows);
    await upsertMeta(client, 'employees', { last_full_sync_at: new Date(), last_incremental_sync_at: new Date(), last_status: 'ok', last_error: null, last_rows: rows.length });
  } catch (e) {
    await upsertMeta(client, 'employees', { last_status: 'error', last_error: e.message.slice(0, 500) }).catch(() => {});
    console.error('[ms-sync] employees failed:', e.message);
  }
}
async function syncStores(client) {
  try {
    const rows = (await msAll('/entity/store', '')).map(s => ({ id: s.id, name: s.name || '—' }));
    await batchUpsert(client, 'ms_stores', ['id', 'name'], ['id'], rows);
    await upsertMeta(client, 'stores', { last_full_sync_at: new Date(), last_incremental_sync_at: new Date(), last_status: 'ok', last_error: null, last_rows: rows.length });
  } catch (e) {
    await upsertMeta(client, 'stores', { last_status: 'error', last_error: e.message.slice(0, 500) }).catch(() => {});
    console.error('[ms-sync] stores failed:', e.message);
  }
}
async function syncAssortment(client) {
  try {
    const rows = (await msAll('/entity/assortment', ''))
      .map(a => {
        const name = a.name || '—';
        return {
          href: a.meta?.href, id: a.id, name, base_name: baseNameOf(name),
          type: a.meta?.type || 'product', code: a.code || null, article: a.article || null,
        };
      })
      .filter(r => r.href);
    await batchUpsert(client, 'ms_assortment', ['href', 'id', 'name', 'base_name', 'type', 'code', 'article'], ['href'], rows);
    await upsertMeta(client, 'assortment', { last_full_sync_at: new Date(), last_incremental_sync_at: new Date(), last_status: 'ok', last_error: null, last_rows: rows.length });
  } catch (e) {
    await upsertMeta(client, 'assortment', { last_status: 'error', last_error: e.message.slice(0, 500) }).catch(() => {});
    console.error('[ms-sync] assortment failed:', e.message);
  }
}
async function syncStock(client) {
  try {
    const rows = (await msAll('/report/stock/all', ''))
      .map(r => ({
        assortment_href: r.assortment?.meta?.href || r.meta?.href || r.id || r.name,
        name: r.name || '—', code: r.code || null, article: r.article || null,
        quantity: r.quantity || 0, reserve: r.reserve || 0,
        price_kopecks: Math.round(r.price || 0), folder_name: r.folder?.name || null,
        status: (r.quantity || 0) <= 0 ? 'out' : (r.quantity || 0) <= 100 ? 'low' : 'ok',
      }))
      .filter(r => r.assortment_href);
    // Full replace, but atomic — a mid-batch failure must not leave the table empty.
    await client.query('BEGIN');
    try {
      await client.query('DELETE FROM ms_stock');
      await batchUpsert(client, 'ms_stock',
        ['assortment_href', 'name', 'code', 'article', 'quantity', 'reserve', 'price_kopecks', 'folder_name', 'status'],
        ['assortment_href'], rows);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
    await upsertMeta(client, 'stock', { last_full_sync_at: new Date(), last_incremental_sync_at: new Date(), last_status: 'ok', last_error: null, last_rows: rows.length });
  } catch (e) {
    await upsertMeta(client, 'stock', { last_status: 'error', last_error: e.message.slice(0, 500) }).catch(() => {});
    console.error('[ms-sync] stock failed:', e.message);
  }
}
async function syncCounterparties(client) {
  const entity = 'counterparties';
  try {
    const state = await getSyncState(client, entity);
    const isFirst = !state?.last_full_sync_at;
    const needsFull = isFirst || !state.watermark_s;

    if (needsFull && !isFirst && coolingDown(state)) {
      console.warn(`[ms-sync] counterparties: no watermark yet, but a full resync already ran within the last ${FULL_SYNC_COOLDOWN_HOURS}h — skipping this tick`);
      await upsertMeta(client, entity, { last_status: 'skipped_cooldown', last_error: null });
      return;
    }

    const filter = !needsFull ? `&filter=${encodeURIComponent(`updated>=${state.watermark_s}`)}` : '';
    const rawRows = await msAll('/entity/counterparty', filter);
    let maxUpdated = state?.watermark_s || null;
    const rows = rawRows.map(r => {
      if (r.updated && (!maxUpdated || r.updated > maxUpdated)) maxUpdated = r.updated;
      return {
        id: r.id, name: r.name || '—', code: r.code || null, email: r.email || null,
        phone: r.phone || null, company_type: r.companyType || null,
        updated_at: (r.updated || '').slice(0, 19) || null,
      };
    });
    if (!maxUpdated && rawRows.length) {
      maxUpdated = fallbackWatermark();
      console.warn(`[ms-sync] counterparties: no updated on any row — using clock-based fallback watermark ${maxUpdated}`);
    }
    await batchUpsert(client, 'ms_counterparties', ['id', 'name', 'code', 'email', 'phone', 'company_type', 'updated_at'], ['id'], rows);
    await upsertMeta(client, entity, {
      last_full_sync_at: needsFull ? new Date() : state.last_full_sync_at,
      last_incremental_sync_at: new Date(), watermark: maxUpdated,
      last_status: 'ok', last_error: null, last_rows: rows.length,
    });
  } catch (e) {
    await upsertMeta(client, entity, { last_status: 'error', last_error: e.message.slice(0, 500) }).catch(() => {});
    console.error('[ms-sync] counterparties failed:', e.message);
  }
}

// ── Positions: only re-fetched for parents that were just synced ────────
async function syncPositionsFor(client, kind, parents, assortmentMap) {
  const table = kind === 'demand' ? 'ms_demand_positions' : 'ms_order_positions';
  const parentCol = kind === 'demand' ? 'demand_id' : 'order_id';
  const BATCH = 8;
  for (let i = 0; i < parents.length; i += BATCH) {
    const slice = parents.slice(i, i + BATCH);
    const results = await Promise.allSettled(slice.map(p => fetchAllPositions(kind, p.id)));
    for (let j = 0; j < slice.length; j++) {
      const parent = slice[j];
      if (results[j].status !== 'fulfilled') continue;
      const positions = results[j].value;
      await client.query(`DELETE FROM ${table} WHERE ${parentCol}=$1`, [parent.id]);
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
      await batchUpsert(client, table, cols, ['id'], rows);
    }
    await sleep(150);
  }
}

// ── Orders / Demands (the transactional core) ────────────────────────────
async function syncOrders(client) {
  const entity = 'orders';
  try {
    const state = await getSyncState(client, entity);
    const isFirst = !state?.last_full_sync_at;
    const needsFull = isFirst || !state.watermark_s;

    if (needsFull && !isFirst && coolingDown(state)) {
      console.warn(`[ms-sync] orders: no watermark yet, but a full resync already ran within the last ${FULL_SYNC_COOLDOWN_HOURS}h — skipping this tick to avoid hammering the API`);
      await upsertMeta(client, entity, { last_status: 'skipped_cooldown', last_error: null });
      return;
    }

    const filterField = needsFull ? 'moment' : 'updated';
    const since = needsFull ? `${MS_SYNC_FROM} 00:00:00` : state.watermark_s;
    const filter = since ? `&filter=${encodeURIComponent(`${filterField}>=${since}`)}` : '';
    const rawRows = await msAll('/entity/customerorder', `${filter}&expand=agent,state&order=moment,asc`);

    let maxUpdated = state?.watermark_s || null;
    const rows = rawRows.map(r => {
      if (r.updated && (!maxUpdated || r.updated > maxUpdated)) maxUpdated = r.updated;
      return {
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
      };
    });
    if (!maxUpdated && rawRows.length) {
      maxUpdated = fallbackWatermark();
      console.warn(`[ms-sync] orders: no updated on any row — using clock-based fallback watermark ${maxUpdated}`);
    }

    const cols = ['id', 'name', 'moment', 'date', 'sum_kopecks', 'payed_sum_kopecks', 'customer_id', 'customer_name',
                  'owner_id', 'state_id', 'state_name', 'delivery_planned_moment', 'store_id', 'updated_at'];
    await batchUpsert(client, 'ms_orders', cols, ['id'], rows);

    const assortmentMap = await loadAssortmentMap(client);
    await syncPositionsFor(client, 'customerorder', rows.map(r => ({ id: r.id })), assortmentMap);

    await upsertMeta(client, entity, {
      last_full_sync_at: needsFull ? new Date() : state.last_full_sync_at,
      last_incremental_sync_at: new Date(), watermark: maxUpdated,
      last_status: 'ok', last_error: null, last_rows: rows.length,
    });
    console.log(`[ms-sync] orders: ${rows.length} synced (${needsFull ? 'full' : 'incremental'})`);
  } catch (e) {
    await upsertMeta(client, entity, { last_status: 'error', last_error: e.message.slice(0, 500) }).catch(() => {});
    console.error('[ms-sync] orders failed:', e.message);
  }
}
async function syncDemands(client) {
  const entity = 'demands';
  try {
    const state = await getSyncState(client, entity);
    const isFirst = !state?.last_full_sync_at;
    const needsFull = isFirst || !state.watermark_s;

    if (needsFull && !isFirst && coolingDown(state)) {
      console.warn(`[ms-sync] demands: no watermark yet, but a full resync already ran within the last ${FULL_SYNC_COOLDOWN_HOURS}h — skipping this tick to avoid hammering the API`);
      await upsertMeta(client, entity, { last_status: 'skipped_cooldown', last_error: null });
      return;
    }

    const filterField = needsFull ? 'moment' : 'updated';
    const since = needsFull ? `${MS_SYNC_FROM} 00:00:00` : state.watermark_s;
    const filter = since ? `&filter=${encodeURIComponent(`${filterField}>=${since}`)}` : '';
    const rawRows = await msAll('/entity/demand', `${filter}&expand=agent,state&order=moment,asc`);

    let maxUpdated = state?.watermark_s || null;
    const rows = rawRows.map(r => {
      if (r.updated && (!maxUpdated || r.updated > maxUpdated)) maxUpdated = r.updated;
      return {
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
      };
    });
    if (!maxUpdated && rawRows.length) {
      maxUpdated = fallbackWatermark();
      console.warn(`[ms-sync] demands: no updated on any row — using clock-based fallback watermark ${maxUpdated}`);
    }

    const cols = ['id', 'name', 'moment', 'date', 'sum_kopecks', 'customer_id', 'customer_name',
                  'owner_id', 'order_id', 'state_id', 'state_name', 'store_id', 'updated_at'];
    await batchUpsert(client, 'ms_demands', cols, ['id'], rows);

    const assortmentMap = await loadAssortmentMap(client);
    await syncPositionsFor(client, 'demand', rows.map(r => ({ id: r.id, date: r.date })), assortmentMap);

    await upsertMeta(client, entity, {
      last_full_sync_at: needsFull ? new Date() : state.last_full_sync_at,
      last_incremental_sync_at: new Date(), watermark: maxUpdated,
      last_status: 'ok', last_error: null, last_rows: rows.length,
    });
    console.log(`[ms-sync] demands: ${rows.length} synced (${needsFull ? 'full' : 'incremental'})`);
  } catch (e) {
    await upsertMeta(client, entity, { last_status: 'error', last_error: e.message.slice(0, 500) }).catch(() => {});
    console.error('[ms-sync] demands failed:', e.message);
  }
}

// Incremental sync (filter=updated>=watermark) can only ever ADD or UPDATE
// rows — a record deleted on MoySklad simply stops appearing in results,
// generating no event to catch, so it lingers in our DB forever unless we
// separately check for it. This does a lightweight "which IDs still exist"
// reconciliation over a recent rolling window (deletions of old historical
// records are rare/low-value to chase, so we don't scan the full history).
// Throttled to once/hour (via ms_sync_meta) since it's extra API load on
// top of the regular incremental ticks.
const RECONCILE_WINDOW_DAYS = 30;
const RECONCILE_INTERVAL_HOURS = 1;

async function reconcileRecentDeletions(client) {
  const entity = 'reconcile';
  try {
    const state = await getSyncState(client, entity);
    if (state?.last_full_sync_at) {
      const hoursSince = (Date.now() - new Date(state.last_full_sync_at).getTime()) / 3600000;
      if (hoursSince < RECONCILE_INTERVAL_HOURS) return;
    }

    const sinceStr = new Date(Date.now() - RECONCILE_WINDOW_DAYS * 24 * 3600 * 1000)
      .toISOString().slice(0, 10) + ' 00:00:00';
    const filter = `&filter=${encodeURIComponent('moment>=' + sinceStr)}&order=moment,asc`;

    let removed = 0;

    const liveOrders = await msAll('/entity/customerorder', filter);
    const liveOrderIds = new Set(liveOrders.map(r => r.id));
    const { rows: localOrders } = await client.query('SELECT id FROM ms_orders WHERE moment >= $1::timestamp', [sinceStr]);
    const staleOrderIds = localOrders.map(r => r.id).filter(id => !liveOrderIds.has(id));
    if (staleOrderIds.length) {
      await client.query('DELETE FROM ms_orders WHERE id = ANY($1::text[])', [staleOrderIds]);
      removed += staleOrderIds.length;
    }

    const liveDemands = await msAll('/entity/demand', filter);
    const liveDemandIds = new Set(liveDemands.map(r => r.id));
    const { rows: localDemands } = await client.query('SELECT id FROM ms_demands WHERE moment >= $1::timestamp', [sinceStr]);
    const staleDemandIds = localDemands.map(r => r.id).filter(id => !liveDemandIds.has(id));
    if (staleDemandIds.length) {
      await client.query('DELETE FROM ms_demands WHERE id = ANY($1::text[])', [staleDemandIds]);
      removed += staleDemandIds.length;
    }

    await upsertMeta(client, entity, {
      last_full_sync_at: new Date(), last_incremental_sync_at: new Date(),
      last_status: 'ok', last_error: null, last_rows: removed,
    });
    if (removed) console.log(`[ms-sync] reconcile: removed ${removed} record(s) deleted upstream on MoySklad`);
  } catch (e) {
    await upsertMeta(client, entity, { last_status: 'error', last_error: e.message.slice(0, 500) }).catch(() => {});
    console.error('[ms-sync] reconcile failed:', e.message);
  }
}

// Each entity gets its own short-lived connection rather than one client held
// for the whole run — a multi-minute single session (orders/demands positions
// can take a while) risks getting dropped by a pooled endpoint (e.g. Neon's
// PgBouncer-style pooler) mid-sync, which would otherwise abort every step
// after it. Bounding each checkout to one entity keeps that blast radius small.
async function withClient(pool, fn) {
  const client = await pool.connect();
  // A checked-out client can emit its own async 'error' event on an
  // unexpected connection drop, independent of any query's promise
  // rejection. Without a listener here, that's an unhandled error and
  // it takes the whole process down — this converts it into a log line.
  client.on('error', (e) => console.error('[ms-sync] client connection error:', e.message));
  try {
    await fn(client);
  } catch (e) {
    console.error('[ms-sync] step failed outside its own try/catch:', e.message);
  } finally {
    client.release();
  }
}

async function runSync() {
  if (!TOKEN) throw new Error('TOKEN is not set — cannot sync MoySklad');
  const pool = getPool();
  await withClient(pool, syncStates);
  await withClient(pool, syncEmployees);
  await withClient(pool, syncStores);
  await withClient(pool, syncAssortment);
  await withClient(pool, syncStock);
  await withClient(pool, syncCounterparties);
  await withClient(pool, syncOrders);
  await withClient(pool, syncDemands);
  await withClient(pool, reconcileRecentDeletions);
}

async function getSyncStatus() {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT entity, last_full_sync_at, last_incremental_sync_at, last_status, last_error, last_rows FROM ms_sync_meta ORDER BY entity`);
  return rows;
}

module.exports = { runSync, getSyncStatus };

if (require.main === module) {
  runSync()
    .then(() => { console.log('[ms-sync] done'); process.exit(0); })
    .catch(e => { console.error('[ms-sync] fatal:', e.message); process.exit(1); });
}
