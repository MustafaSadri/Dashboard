'use strict';
require('dotenv').config();
const { MongoClient } = require('mongodb');

const MS_BASE   = 'https://api.moysklad.ru/api/remap/1.2';
const TOKEN     = process.env.TOKEN     || '';
const MONGO_URI = process.env.MONGODB_URI || '';
const MONGO_DB  = process.env.MONGODB_DB_NAME || 'tally_sync';
const SYNC_FROM = '2024-12-01'; // Full sync historical start date

if (!TOKEN)     { console.error('ERROR: TOKEN not set in .env'); process.exit(1); }
if (!MONGO_URI) { console.error('ERROR: MONGODB_URI not set in .env'); process.exit(1); }

const MS_HEADERS = {
  Authorization:     `Bearer ${TOKEN}`,
  'Content-Type':    'application/json',
  'Accept-Encoding': 'gzip'
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Rate-limit-aware GET with exponential backoff ──────────────────────────
async function msGet(path, retries = 6) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    let r;
    try {
      r = await fetch(`${MS_BASE}${path}`, { headers: MS_HEADERS, signal: AbortSignal.timeout(45000) });
    } catch (e) {
      if (attempt === retries) throw e;
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (r.status === 429) {
      const wait = Math.pow(2, attempt) * 2000;
      process.stdout.write(`\n  [rate-limited] waiting ${Math.round(wait / 1000)}s...`);
      await sleep(wait);
      continue;
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

// ── Paginated fetch ────────────────────────────────────────────────────────
async function msAll(endpoint, extra = '', max = 200000) {
  const rows = [];
  let offset = 0;
  const limit = 100;
  while (rows.length < max) {
    const sep  = endpoint.includes('?') ? '&' : '?';
    const data = await msGet(`${endpoint}${sep}limit=${limit}&offset=${offset}${extra}`);
    const batch = data.rows || [];
    rows.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
    await sleep(200);
  }
  return rows;
}

// ── Build product/variant name map: assortment href → display name ─────────
async function buildNameMap() {
  process.stdout.write('  Building name map...');
  const rows = await msAll('/entity/assortment');
  const map  = {};
  rows.forEach(r => {
    if (r.meta?.href) map[r.meta.href] = r.name || '—';
  });
  console.log(` ${Object.keys(map).length} entries`);
  return map;
}

// ── Fetch all positions for one demand ─────────────────────────────────────
async function fetchPositions(demandId, nameMap) {
  const positions = [];
  let offset = 0;
  while (true) {
    const data  = await msGet(`/entity/demand/${demandId}/positions?limit=100&offset=${offset}`);
    const batch = data.rows || [];
    batch.forEach(pos => {
      const href     = pos.assortment?.meta?.href || '';
      const fullName = nameMap[href] || pos.assortment?.name || '—';
      const varM     = fullName.match(/\(([^)]+)\)\s*$/);
      const baseName = fullName.replace(/\s*\([^)]*\)\s*$/, '').trim() || fullName;
      positions.push({
        productHref: href,
        productName: fullName,
        baseName,
        variantName: varM ? varM[1] : '',
        quantity:    pos.quantity || 0,
        priceKop:    pos.price    || 0,
        priceRub:    (pos.price   || 0) / 100,
        discount:    pos.discount || 0,
        amountKop:   pos.sum      || 0,
        amountRub:   (pos.sum     || 0) / 100,
      });
    });
    if (batch.length < 100) break;
    offset += 100;
    await sleep(80);
  }
  return positions;
}

function toDateStr(moment) { return (moment || '').slice(0, 10); }

// ── Sync demands (with embedded positions for SKU analytics) ───────────────
async function syncDemands(db, since, isFirstSync, nameMap) {
  console.log('\nSyncing demands...');
  const col      = db.collection('ms_demands');
  const sinceStr = since.toISOString().replace('T', ' ').slice(0, 19);
  const filter   = isFirstSync
    ? `&filter=moment>=${SYNC_FROM} 00:00:00`
    : `&filter=updatedAt>=${sinceStr}`;

  const demands = await msAll('/entity/demand?order=moment,asc&expand=agent,state', filter);
  console.log(`  Found ${demands.length} demands`);
  if (!demands.length) return 0;

  let synced = 0;
  const BATCH = 8;

  for (let i = 0; i < demands.length; i += BATCH) {
    const batch = demands.slice(i, i + BATCH);
    process.stdout.write(`  [${i + 1}-${Math.min(i + BATCH, demands.length)}/${demands.length}] fetching positions...`);

    const posResults = await Promise.allSettled(
      batch.map(d => fetchPositions(d.id, nameMap))
    );

    const ops = batch.map((d, idx) => {
      const positions = posResults[idx].status === 'fulfilled' ? posResults[idx].value : [];
      return {
        replaceOne: {
          filter:      { _id: d.id },
          replacement: {
            _id:           d.id,
            entityType:    'demand',
            name:          d.name          || '',
            date:          toDateStr(d.moment),
            moment:        (d.moment || '').slice(0, 19),
            amountKop:     d.sum            || 0,
            amountRub:     (d.sum           || 0) / 100,
            customerId:    d.agent?.id      || '',
            customerName:  d.agent?.name    || '',
            stateId:       d.state?.id      || '',
            stateName:     d.state?.name    || '',
            positions,
            positionCount: positions.length,
            updatedAt:     d.updatedAt      || '',
            syncTimestamp: new Date().toISOString(),
          },
          upsert: true,
        },
      };
    });

    await col.bulkWrite(ops);
    synced += ops.length;
    process.stdout.write(' saved\n');
    await sleep(300);
  }

  console.log(`  ✓ ${synced} demands synced`);
  return synced;
}

// ── Sync stock (always full refresh — no updatedAt on stock report) ─────────
async function syncStock(db) {
  console.log('\nSyncing stock...');
  const col  = db.collection('ms_stock');
  const rows = await msAll('/report/stock/all', '&stockMode=all');
  console.log(`  Found ${rows.length} stock items`);
  if (!rows.length) return 0;

  await col.deleteMany({});
  const docs = rows.map(r => ({
    _id:           r.id || r.meta?.href || r.name,
    name:          r.name      || '—',
    code:          r.code      || '',
    quantity:      r.quantity  || 0,
    reserve:       r.reserve   || 0,
    inTransit:     r.inTransit || 0,
    available:     (r.quantity || 0) - (r.reserve || 0),
    price:         (r.price    || 0) / 100,
    status:        (r.quantity || 0) <= 0 ? 'out' : (r.quantity || 0) <= 100 ? 'low' : 'ok',
    syncTimestamp: new Date().toISOString(),
  }));
  await col.insertMany(docs);
  console.log(`  ✓ ${docs.length} stock items synced`);
  return docs.length;
}

// ── Sync counterparties (customers) ───────────────────────────────────────
async function syncCustomers(db, since, isFirstSync) {
  console.log('\nSyncing customers...');
  const col      = db.collection('ms_customers');
  const sinceStr = since.toISOString().replace('T', ' ').slice(0, 19);
  const filter   = isFirstSync ? '' : `&filter=updatedAt>=${sinceStr}`;
  const rows     = await msAll('/entity/counterparty', filter);
  console.log(`  Found ${rows.length} customers`);
  if (!rows.length) return 0;

  const ops = rows.map(r => ({
    replaceOne: {
      filter:      { _id: r.id },
      replacement: {
        _id:          r.id,
        name:         r.name        || '—',
        code:         r.code        || '',
        email:        r.email       || '',
        phone:        r.phone       || '',
        companyType:  r.companyType || '',
        updatedAt:    r.updatedAt   || '',
        syncTimestamp: new Date().toISOString(),
      },
      upsert: true,
    },
  }));
  await col.bulkWrite(ops);
  console.log(`  ✓ ${rows.length} customers synced`);
  return rows.length;
}

// ── Sync customer orders ──────────────────────────────────────────────────
async function syncOrders(db, since, isFirstSync) {
  console.log('\nSyncing customer orders...');
  const col      = db.collection('ms_orders');
  const sinceStr = since.toISOString().replace('T', ' ').slice(0, 19);
  const filter   = isFirstSync
    ? `&filter=moment>=${SYNC_FROM} 00:00:00`
    : `&filter=updatedAt>=${sinceStr}`;

  const rows = await msAll('/entity/customerorder?order=moment,asc&expand=agent,state', filter);
  console.log(`  Found ${rows.length} orders`);
  if (!rows.length) return 0;

  const ops = rows.map(r => ({
    replaceOne: {
      filter:      { _id: r.id },
      replacement: {
        _id:          r.id,
        entityType:   'customerorder',
        name:         r.name          || '',
        date:         toDateStr(r.moment),
        moment:       (r.moment || '').slice(0, 19),
        amountKop:    r.sum            || 0,
        amountRub:    (r.sum           || 0) / 100,
        customerId:   r.agent?.id      || '',
        customerName: r.agent?.name    || '',
        stateId:      r.state?.id      || '',
        stateName:    r.state?.name    || '',
        deliveryDate: toDateStr(r.deliveryPlannedMoment),
        updatedAt:    r.updatedAt      || '',
        syncTimestamp: new Date().toISOString(),
      },
      upsert: true,
    },
  }));
  await col.bulkWrite(ops);
  console.log(`  ✓ ${rows.length} orders synced`);
  return rows.length;
}

// ── Create indexes (first sync only) ─────────────────────────────────────
async function createIndexes(db) {
  process.stdout.write('Creating indexes...');
  await db.collection('ms_demands').createIndexes([
    { key: { date: 1 } },
    { key: { customerName: 1 } },
    { key: { updatedAt: 1 } },
    { key: { 'positions.productName': 1 } },
    { key: { 'positions.baseName': 1 } },
  ]);
  await db.collection('ms_stock').createIndexes([
    { key: { name: 1 } },
    { key: { status: 1 } },
  ]);
  await db.collection('ms_orders').createIndexes([
    { key: { date: 1 } },
    { key: { customerName: 1 } },
    { key: { stateName: 1 } },
  ]);
  await db.collection('ms_customers').createIndex({ name: 1 });
  console.log(' done');
}

// ── Main entry point ───────────────────────────────────────────────────────
async function runSync({ verbose = true } = {}) {
  const log = verbose ? (...a) => console.log(...a) : () => {};
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(MONGO_DB);

  try {
    const meta        = await db.collection('ms_sync_meta').findOne({ _id: 'main' });
    const isFirstSync = !meta?.lastSyncAt;
    const since       = isFirstSync ? new Date(SYNC_FROM) : new Date(meta.lastSyncAt);

    log(`\n${'═'.repeat(55)}`);
    log(`MoySklad Sync — ${isFirstSync ? 'FULL (first run from ' + SYNC_FROM + ')' : 'INCREMENTAL'}`);
    log(`Since: ${since.toISOString().slice(0, 16)}`);
    log(`${'═'.repeat(55)}`);

    const t0 = Date.now();

    if (isFirstSync) await createIndexes(db);

    const nameMap = await buildNameMap();

    const results = {
      demands:   await syncDemands(db, since, isFirstSync, nameMap),
      stock:     await syncStock(db),
      customers: await syncCustomers(db, since, isFirstSync),
      orders:    await syncOrders(db, since, isFirstSync),
    };

    const elapsed = Math.round((Date.now() - t0) / 1000);

    const totals = {
      totalDemands:   await db.collection('ms_demands').countDocuments(),
      totalOrders:    await db.collection('ms_orders').countDocuments(),
      totalCustomers: await db.collection('ms_customers').countDocuments(),
      totalStock:     await db.collection('ms_stock').countDocuments(),
    };

    await db.collection('ms_sync_meta').replaceOne(
      { _id: 'main' },
      { _id: 'main', lastSyncAt: new Date(), lastSyncType: isFirstSync ? 'full' : 'incremental', lastSyncSec: elapsed, ...results, ...totals },
      { upsert: true }
    );

    log(`\n${'═'.repeat(55)}`);
    log(`✓ Sync complete in ${elapsed}s`);
    log(`  Demands: ${results.demands} | Stock: ${results.stock} | Customers: ${results.customers} | Orders: ${results.orders}`);
    log(`  DB totals → Demands: ${totals.totalDemands} | Orders: ${totals.totalOrders} | Customers: ${totals.totalCustomers}`);
    log(`${'═'.repeat(55)}\n`);

    return { ok: true, elapsed, isFirstSync, ...results, ...totals };
  } finally {
    await client.close();
  }
}

module.exports = { runSync };

if (require.main === module) {
  runSync({ verbose: true }).catch(e => {
    console.error('\nSync failed:', e.message);
    process.exit(1);
  });
}
