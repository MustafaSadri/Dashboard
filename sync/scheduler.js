'use strict';
const cron = require('node-cron');
const { runSync } = require('./moysklad-sync');

let running = false;
let task = null;

async function tick() {
  if (running) { console.log('[ms-sync] previous tick still running, skipping'); return; }
  running = true;
  try {
    await runSync();
  } catch (e) {
    console.error('[ms-sync] tick failed:', e.message);
  } finally {
    running = false;
  }
}

// Starts the recurring MoySklad → Postgres sync. Safe to call once at boot;
// no-op if DATABASE_URL isn't configured (nothing to sync into).
function start() {
  if (task) return task;
  if (!process.env.DATABASE_URL) {
    console.log('[ms-sync] DATABASE_URL not set — background sync disabled');
    return null;
  }
  const minutes = Math.max(1, parseInt(process.env.MS_SYNC_INTERVAL_MINUTES, 10) || 5);
  const expr = `*/${minutes} * * * *`;
  console.log(`[ms-sync] scheduling MoySklad sync every ${minutes} minute(s)`);
  task = cron.schedule(expr, tick);
  // Kick off an initial tick shortly after boot so the DB starts warming immediately.
  setTimeout(tick, 10 * 1000);
  return task;
}

function stop() {
  if (task) { task.stop(); task = null; }
}

module.exports = { start, stop, tick };
