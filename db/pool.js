'use strict';
require('dotenv').config();
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL || '';
let _pool = null;

function getPool() {
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set — cannot query Postgres. Set it in .env or use MS_DATA_SOURCE=live.');
  }
  if (!_pool) {
    _pool = new Pool({
      connectionString,
      ssl: connectionString.includes('sslmode=require') || /neon\.tech|supabase|render\.com|railway/.test(connectionString)
        ? { rejectUnauthorized: false }
        : undefined,
      max: 10,
    });
    // Required by node-postgres: an idle client that hits a backend/network error
    // emits 'error' on the pool. Without a listener, that's an unhandled error
    // event and Node kills the whole process — this just logs it instead.
    _pool.on('error', (err) => {
      console.error('[pg pool] unexpected error on idle client:', err.message);
    });
  }
  return _pool;
}

function query(text, params) {
  return getPool().query(text, params);
}

async function withTransaction(fn) {
  const client = await getPool().connect();
  // See the matching comment in sync/moysklad-sync.js's withClient() — a
  // checked-out client's own 'error' event needs a listener or a dropped
  // connection crashes the whole process regardless of this try/catch.
  client.on('error', (e) => console.error('[pg client] connection error:', e.message));
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { getPool, query, withTransaction, hasDatabaseUrl: () => !!connectionString };
