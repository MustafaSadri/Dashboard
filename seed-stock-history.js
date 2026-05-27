/**
 * seed-stock-history.js
 * ─────────────────────
 * One-time script: inserts closing-stock values for every month
 * (May 2024 → Apr 2026) into MongoDB tally_stock_monthly.
 *
 * Source: Tally P&L screenshots verified month-by-month.
 * Each record = closing stock of that month = opening stock of next month.
 *
 * Run once:  node seed-stock-history.js
 */

require('dotenv').config();
const { MongoClient } = require('mongodb');

const MONGO_URI = process.env.MONGODB_URI || '';
const MONGO_DB  = process.env.MONGODB_DB_NAME || 'tally_sync';

// ── Closing stock for each month (from Tally P&L screenshots) ─────────────
// Key   : YYYY-MM  (= month whose closing stock this is)
// Value : closing stock in ₹ (plain number, converted from Indian lakh/crore format)
//
// Cross-check rule: each month's closing = next month's opening ✓ (verified)
const STOCK_DATA = [
  // 2024-04 = "pre-May" opening; May 2024 shows blank opening stock → 0
  ['2024-04',          0.00],   // Opening stock of May 2024 (blank in Tally)

  // ── FY 2024-25 ──────────────────────────────────────────────────────────
  ['2024-05',    3_743_865.00], // May  2024 CS  37,43,865.00
  ['2024-06',    4_741_200.00], // Jun  2024 CS  47,41,200.00
  ['2024-07',   22_929_904.11], // Jul  2024 CS  2,29,29,904.11
  ['2024-08',   20_839_710.15], // Aug  2024 CS  2,08,39,710.15
  ['2024-09',   20_058_344.16], // Sep  2024 CS  2,00,58,344.16
  ['2024-10',   56_987_272.58], // Oct  2024 CS  5,69,87,272.58
  ['2024-11',   34_314_283.75], // Nov  2024 CS  3,43,14,283.75
  ['2024-12',   68_898_034.95], // Dec  2024 CS  6,88,98,034.95
  ['2025-01',   87_567_005.51], // Jan  2025 CS  8,75,67,005.51
  ['2025-02',  166_067_166.99], // Feb  2025 CS  16,60,67,166.99
  ['2025-03',  138_729_248.18], // Mar  2025 CS  13,87,29,248.18

  // ── FY 2025-26 ──────────────────────────────────────────────────────────
  ['2025-04',  177_243_417.80], // Apr  2025 CS  17,72,43,417.80
  ['2025-05',  103_703_787.74], // May  2025 CS  10,37,03,787.74
  ['2025-06',   97_399_665.70], // Jun  2025 CS  9,73,99,665.70
  ['2025-07',  132_178_618.60], // Jul  2025 CS  13,21,78,618.60
  ['2025-08',  151_282_605.15], // Aug  2025 CS  15,12,82,605.15
  ['2025-09',  104_263_175.37], // Sep  2025 CS  10,42,63,175.37
  ['2025-10',  133_877_547.55], // Oct  2025 CS  13,38,77,547.55
  ['2025-11',  266_310_013.53], // Nov  2025 CS  26,63,10,013.53
  ['2025-12',  269_779_913.47], // Dec  2025 CS  26,97,79,913.47
  ['2026-01',  194_737_985.03], // Jan  2026 CS  19,47,37,985.03
  ['2026-02',  190_638_275.08], // Feb  2026 CS  19,06,38,275.08
  ['2026-03',  219_118_332.00], // Mar  2026 CS  21,91,18,332.00
  ['2026-04',  252_393_008.81], // Apr  2026 CS  25,23,93,008.81
];

// Helper: last day of a YYYY-MM month as 'YYYY-MM-DD'
function lastDayOf(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m, 0).toISOString().slice(0, 10);
}

async function seed() {
  if (!MONGO_URI) {
    console.error('❌  MONGODB_URI not set in .env');
    process.exit(1);
  }

  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db  = client.db(MONGO_DB);
  const col = db.collection('tally_stock_monthly');

  console.log(`\n📦  Seeding ${STOCK_DATA.length} monthly stock records into tally_stock_monthly…\n`);
  const now = new Date();
  let inserted = 0, updated = 0;

  for (const [month, stockValue] of STOCK_DATA) {
    const syncDate = lastDayOf(month);
    const existing = await col.findOne({ _id: month });

    await col.replaceOne(
      { _id: month },
      {
        _id:        month,
        month:      month,
        stockValue: stockValue,
        syncDate:   syncDate,
        syncedAt:   now,
        source:     'manual_seed',
        itemCount:  0
      },
      { upsert: true }
    );

    const label = `₹${Math.round(stockValue).toLocaleString('en-IN').padStart(16)}`;
    if (existing) {
      console.log(`  ↻  ${month}  ${label}  (updated)`);
      updated++;
    } else {
      console.log(`  ✓  ${month}  ${label}  (inserted)`);
      inserted++;
    }
  }

  console.log(`\n✅  Done!  ${inserted} inserted, ${updated} updated`);
  console.log(`    tally_stock_monthly now has data from 2024-04 → 2026-04\n`);
  await client.close();
}

seed().catch(e => {
  console.error('❌  Error:', e.message);
  process.exit(1);
});
