'use strict';
require('dotenv').config();
// One-time historical merge: copies the retired MoySklad account's data from
// its own (frozen) Neon database into the new/active database, so admin and
// partner logins can see continuous history across the Sept 1 cutover while
// the sales director role (date-floored at read time, see
// db/moysklad-queries.js) never sees it. Safe to re-run — every insert is
// ON CONFLICT DO NOTHING, so a second run just no-ops on already-copied rows.
//
// Deliberately does NOT touch ms_stock (must stay new-account-only — it's a
// live snapshot, not history) or ms_sync_meta (per-database sync bookkeeping).
//
// Usage: OLD_DATABASE_URL=... node sync/merge-old-account.js
// (reads OLD_DATABASE_URL from env; NEW/active DB comes from DATABASE_URL as usual)
const { Pool } = require('pg');

const oldUrl = process.env.OLD_DATABASE_URL || '';
const newUrl = process.env.DATABASE_URL || '';

if (!oldUrl) { console.error('OLD_DATABASE_URL is not set — nothing to merge from.'); process.exit(1); }
if (!newUrl) { console.error('DATABASE_URL is not set — nowhere to merge into.'); process.exit(1); }

function makePool(connectionString) {
  const pool = new Pool({
    connectionString,
    ssl: connectionString.includes('sslmode=require') || /neon\.tech/.test(connectionString)
      ? { rejectUnauthorized: false } : undefined,
    max: 5,
  });
  pool.on('error', (e) => console.error('[merge] pool error:', e.message));
  return pool;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Both Neon computes here are on tiers that suspend when idle and can drop
// the first few connections while waking back up — retry with backoff rather
// than making the whole (long, many-batch) run fail on one blip.
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

// Table copy order matters: parents before children (FK constraints).
const TABLES = [
  { name: 'ms_counterparties',  pk: ['id'] },
  { name: 'ms_employees',       pk: ['id'] },
  { name: 'ms_stores',          pk: ['id'] },
  { name: 'ms_states',          pk: ['id'] },
  { name: 'ms_assortment',      pk: ['href'] },
  { name: 'ms_orders',          pk: ['id'] },
  { name: 'ms_order_positions', pk: ['id'] },
  { name: 'ms_demands',         pk: ['id'] },
  { name: 'ms_demand_positions',pk: ['id'] },
  { name: 'ms_muted_models',    pk: ['base_name'] },
];

async function copyTable(oldPool, newPool, table) {
  const { rows, fields } = await queryWithRetry(oldPool, `SELECT * FROM ${table.name}`);
  if (!rows.length) { console.log(`  ${table.name}: 0 rows in old DB, skipping`); return { source: 0, inserted: 0 }; }

  // Only copy columns that exist in both databases — the two schemas can
  // drift slightly (e.g. a column added to one and never the other during
  // earlier experiments), so intersect rather than assuming they match.
  const oldCols = fields.map(f => f.name);
  const newColsResult = await queryWithRetry(newPool,
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [table.name]);
  const newCols = new Set(newColsResult.rows.map(r => r.column_name));
  const cols = oldCols.filter(c => newCols.has(c));
  const skipped = oldCols.filter(c => !newCols.has(c));
  if (skipped.length) console.log(`  ${table.name}: skipping column(s) not present in new DB: ${skipped.join(', ')}`);
  const batchSize = 100;
  let inserted = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const values = [];
    const placeholders = batch.map((row, ri) => {
      const base = ri * cols.length;
      const ph = cols.map((c, ci) => `$${base + ci + 1}`).join(', ');
      cols.forEach(c => values.push(row[c] === undefined ? null : row[c]));
      return `(${ph})`;
    }).join(', ');
    const result = await queryWithRetry(newPool,
      `INSERT INTO ${table.name} (${cols.join(', ')}) VALUES ${placeholders}
       ON CONFLICT (${table.pk.join(', ')}) DO NOTHING`,
      values);
    inserted += result.rowCount;
    if ((i / batchSize) % 20 === 0 && i > 0) console.log(`  ${table.name}: ${i}/${rows.length} processed...`);
  }
  console.log(`  ${table.name}: ${rows.length} rows in old DB, ${inserted} newly inserted (rest already present)`);
  return { source: rows.length, inserted };
}

async function main() {
  console.log('== Merging old MoySklad account data into the active database ==');
  const oldPool = makePool(oldUrl);
  const newPool = makePool(newUrl);
  try {
    for (const table of TABLES) {
      await copyTable(oldPool, newPool, table);
    }
    console.log('\n✓ Merge complete. ms_stock and ms_sync_meta were intentionally left untouched.');
  } finally {
    await oldPool.end();
    await newPool.end();
  }
}

main().catch(e => { console.error('Merge failed:', e.message); process.exit(1); });
