'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getPool } = require('./pool');

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const pool = getPool();
  await pool.query(sql);
  console.log('✓ MoySklad Postgres schema is up to date');
}

module.exports = { migrate };

if (require.main === module) {
  migrate()
    .then(() => process.exit(0))
    .catch(e => { console.error('Migration failed:', e.message); process.exit(1); });
}
