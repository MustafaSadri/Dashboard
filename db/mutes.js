'use strict';
// Per-model "stop alerting me about this" list — first-party app state, not
// mirrored MoySklad data, so it lives separately from db/moysklad-queries.js.
// Degrades to "nothing muted" if DATABASE_URL isn't configured, rather than
// breaking the stock-alert surfaces that read it.
const { query, hasDatabaseUrl } = require('./pool');

async function getMutedModelSet() {
  if (!hasDatabaseUrl()) return new Set();
  const { rows } = await query('SELECT base_name FROM ms_muted_models');
  return new Set(rows.map(r => r.base_name));
}

async function setModelMuted(baseName, muted) {
  if (!hasDatabaseUrl()) return;
  if (muted) {
    await query(
      'INSERT INTO ms_muted_models (base_name) VALUES ($1) ON CONFLICT (base_name) DO NOTHING',
      [baseName]);
  } else {
    await query('DELETE FROM ms_muted_models WHERE base_name = $1', [baseName]);
  }
}

module.exports = { getMutedModelSet, setModelMuted };
