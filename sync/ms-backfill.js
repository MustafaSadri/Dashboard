'use strict';
require('dotenv').config();
// One-time entry point: applies the schema, then runs a full MoySklad sync.
// Usage: node sync/ms-backfill.js
const { migrate } = require('../db/migrate');
const { runSync } = require('./moysklad-sync');

(async () => {
  console.log('== MoySklad Postgres backfill ==');
  await migrate();
  console.log('Starting full sync from', process.env.MS_SYNC_FROM || '2024-12-01', '...');
  const t0 = Date.now();
  await runSync();
  console.log(`\n✓ Backfill complete in ${Math.round((Date.now() - t0) / 1000)}s`);
  process.exit(0);
})().catch(e => {
  console.error('Backfill failed:', e.message);
  process.exit(1);
});
