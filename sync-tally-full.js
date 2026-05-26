// ─────────────────────────────────────────────────────────────
//  PLATINA  Full Tally → MongoDB Sync
//
//  Run once (or whenever you want a full refresh):
//    node sync-tally-full.js
//
//  What it does:
//    1. Drops stale MoySklad collections (ms_*)
//    2. Syncs all ledgers (balances, debtors, creditors)
//    3. Syncs all vouchers from Jan 2024 → today (sales, purchases, receipts…)
//    4. Syncs current stock items (name, qty, value)
//    5. Saves dashboard snapshot for offline mode
//
//  Stock-per-date history is NOT fetched here — it crashes Tally.
//  The Gross Profit modal will say "no stock data" until that is
//  solved separately. Everything else on the dashboard works fully.
// ─────────────────────────────────────────────────────────────
require('dotenv').config();
const { MongoClient } = require('mongodb');

const TALLY_BASE    = process.env.TALLY_URL || process.env.TALLY_BASE || 'http://localhost:9000';
const TALLY_COMPANY = process.env.TALLY_COMPANY || '';
const MONGO_URI     = process.env.MONGODB_URI;
const MONGO_DB      = process.env.MONGODB_DB_NAME || 'tally_sync';

// Only store vouchers from this date onwards
const FROM_DATE = '2024-01-01';

// Collections that belong to MoySklad — will be dropped if found
const MS_COLLECTIONS = ['ms_customers', 'ms_demands', 'ms_orders', 'ms_stock', 'ms_sync_meta'];

// ── XML helpers ───────────────────────────────────────────────
function blocks(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'))].map(m => m[0]);
}
function getTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? m[1] : '';
}
function attr(xml, name) {
  const m = xml.match(new RegExp(`\\b${name}="([^"]*)"`, 'i'));
  return m ? decodeXml(m[1]) : '';
}
function stripXml(s) {
  return decodeXml(String(s || '').replace(/<[^>]+>/g, '').trim());
}
function decodeXml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}
function escapeXml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '>').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function parseTallyAmount(s) {
  const text = stripXml(s).replace(/,/g, '');
  const n = parseFloat(text.replace(/[^0-9.-]/g, '')) || 0;
  return /\bCr\b/i.test(text) ? -Math.abs(n) : Math.abs(n);
}
function formatTallyDate(s) {
  const t = String(s || '').trim();
  if (/^\d{8}$/.test(t)) return `${t.slice(0,4)}-${t.slice(4,6)}-${t.slice(6,8)}`;
  return t.slice(0, 10) || null;
}
function toTallyDate(iso) {
  return String(iso || '').slice(0, 10).replace(/-/g, '');
}
const todayISO = () => new Date().toISOString().slice(0, 10);

// ── Tally HTTP ────────────────────────────────────────────────
async function tallyPost(xml) {
  const r = await fetch(TALLY_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml;charset=utf-8' },
    body: xml,
    signal: AbortSignal.timeout(120000)   // 2 min — enough for full voucher dump
  });
  if (!r.ok) throw new Error(`Tally HTTP ${r.status}`);
  const text = await r.text();
  if (/LINEERROR/i.test(text)) {
    const msg = stripXml(getTag(text, 'LINEERROR'));
    if (!msg.includes('Could not find')) throw new Error(msg || 'Tally XML error');
  }
  return text;
}

function envelope(name, body, fromDate, toDate) {
  const co    = TALLY_COMPANY ? `<SVCURRENTCOMPANY>${escapeXml(TALLY_COMPANY)}</SVCURRENTCOMPANY>` : '';
  const dates = fromDate
    ? `<SVFROMDATE>${toTallyDate(fromDate)}</SVFROMDATE><SVTODATE>${toTallyDate(toDate || todayISO())}</SVTODATE>`
    : '';
  return `<ENVELOPE>
<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>${name}</ID></HEADER>
<BODY><DESC><STATICVARIABLES>${co}${dates}<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
<TDL><TDLMESSAGE>${body}</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

// ── Parse ledgers ─────────────────────────────────────────────
function parseLedgers(xml) {
  const out = [];
  for (const blk of blocks(xml, 'LEDGER')) {
    const name   = attr(blk, 'NAME') || stripXml(getTag(blk, 'NAME'));
    if (!name) continue;
    const parent = stripXml(getTag(blk, 'PARENT'));
    const pLow   = parent.toLowerCase();
    const balStr = stripXml(getTag(blk, 'CLOSINGBALANCE'));
    const absBal = Math.abs(parseTallyAmount(balStr));
    const isCr   = /\bCr\b/i.test(balStr);

    let type = 'other';
    if      (pLow.includes('sundry debtor'))    type = 'debtor';
    else if (pLow.includes('sundry creditor'))  type = 'creditor';
    else if (pLow.includes('sales account'))    type = 'sales';
    else if (pLow.includes('purchase account')) type = 'purchase';
    else if (pLow.includes('indirect expense')) type = 'expense';
    else if (pLow.includes('direct expense'))   type = 'direct_expense';
    else if (pLow.includes('bank account'))     type = 'bank';
    else if (pLow === 'cash-in-hand' || pLow === 'cash in hand') type = 'cash';

    let balance = isCr ? -absBal : absBal;
    if (type === 'creditor') balance = isCr ? absBal : -absBal;

    out.push({ _id: name, name, parent, type, balance, updatedAt: new Date() });
  }
  return out;
}

// ── Gurmeet Ji debit extractor ────────────────────────────────
// For Journal vouchers, collections = sum of ALLLEDGERENTRIES.LIST
// entries where LEDGERNAME matches "gurmeet" AND ISDEEMEDPOSITIVE=Yes
function extractGurmeetDebit(voucherXml) {
  const re = /<ALLLEDGERENTRIES\.LIST[\s\S]*?<\/ALLLEDGERENTRIES\.LIST>/gi;
  let total = 0;
  for (const m of voucherXml.matchAll(re)) {
    const entry = m[0];
    if (!/gurmeet/i.test(stripXml(getTag(entry, 'LEDGERNAME')))) continue;
    if (!/yes/i.test(stripXml(getTag(entry, 'ISDEEMEDPOSITIVE')))) continue;
    total += Math.abs(parseTallyAmount(getTag(entry, 'AMOUNT')));
  }
  return total;
}

// ── Parse vouchers ────────────────────────────────────────────
function parseVouchers(xml, fromFilter) {
  const out = [];
  for (const blk of blocks(xml, 'VOUCHER')) {
    const dateStr = formatTallyDate(stripXml(getTag(blk, 'DATE')));
    if (!dateStr) continue;
    // Filter by date in JS — Tally ignores SVFROMDATE/SVTODATE
    if (fromFilter && dateStr < fromFilter) continue;
    const type = stripXml(getTag(blk, 'VOUCHERTYPENAME')) || attr(blk, 'VCHTYPE');
    if (!type) continue;
    const num   = stripXml(getTag(blk, 'VOUCHERNUMBER'));
    const party = stripXml(getTag(blk, 'PARTYLEDGERNAME'));
    // Journal: use only Gurmeet Ji debit as collection amount
    // All other types: use normal voucher-level amount
    const amount = type.toLowerCase() === 'journal'
      ? extractGurmeetDebit(blk)
      : Math.abs(parseTallyAmount(getTag(blk, 'AMOUNT')));
    const raw = `${dateStr}|${type}|${num}|${party}|${amount}`;
    const _id = raw.replace(/[^a-zA-Z0-9|._-]/g, '_').slice(0, 120);
    out.push({
      _id, dateStr,
      date:          new Date(dateStr),
      month:         dateStr.slice(0, 7),
      type,
      voucherNumber: num,
      party,
      amount,
      narration:     stripXml(getTag(blk, 'NARRATION'))
    });
  }
  return out;
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║   PLATINA  Full Tally → MongoDB Sync   ║');
  console.log(`║   Vouchers from ${FROM_DATE} → today     ║`);
  console.log('╚════════════════════════════════════════╝\n');

  if (!MONGO_URI) { console.error('✗  MONGODB_URI not set in .env'); process.exit(1); }

  // ── Check Tally is reachable ──────────────────────────────
  process.stdout.write(`Connecting to Tally at ${TALLY_BASE} ... `);
  try {
    await tallyPost(
      `<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>` +
      `<BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>List of Companies</REPORTNAME>` +
      `</REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`
    );
  } catch(e) {
    if (!e.message.includes('Could not find') && !e.message.includes('Tally XML')) throw e;
  }
  console.log('✓\n');

  // ── Connect MongoDB ───────────────────────────────────────
  process.stdout.write('Connecting to MongoDB ... ');
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(MONGO_DB);
  console.log('✓\n');

  // ── STEP 0: Drop stale MoySklad collections ───────────────
  process.stdout.write('Cleaning up MoySklad collections ... ');
  const allCols = new Set((await db.listCollections().toArray()).map(c => c.name));
  let dropped = 0;
  for (const col of MS_COLLECTIONS) {
    if (allCols.has(col)) { await db.collection(col).drop(); dropped++; }
  }
  console.log(dropped ? `✓  Dropped ${dropped} collection(s)\n` : '✓  Nothing to clean\n');

  // ── STEP 1: Create indexes ────────────────────────────────
  process.stdout.write('Creating indexes ... ');
  await Promise.all([
    db.collection('tally_ledgers').createIndex({ type: 1 }),
    db.collection('tally_ledgers').createIndex({ balance: -1 }),
    db.collection('tally_vouchers').createIndex({ date: -1 }),
    db.collection('tally_vouchers').createIndex({ month: 1, type: 1 }),
    db.collection('tally_vouchers').createIndex({ party: 1, type: 1 }),
    db.collection('tally_vouchers').createIndex({ dateStr: 1 }),
  ]);
  console.log('✓\n');

  // ── STEP 2: Ledgers ───────────────────────────────────────
  console.log('[ 1 / 4 ]  Syncing ledgers ...');
  process.stdout.write('  Fetching from Tally ... ');
  const ledXml  = await tallyPost(envelope('SyncLedgers', `
<COLLECTION NAME="SyncLedgers" ISMODIFY="No">
  <TYPE>Ledger</TYPE>
  <FETCH>Name,Parent,ClosingBalance</FETCH>
</COLLECTION>`));
  const ledgers = parseLedgers(ledXml);
  console.log(`${ledgers.length} ledgers`);
  if (ledgers.length > 0) {
    const ops = ledgers.map(l => ({ replaceOne: { filter: { _id: l._id }, replacement: l, upsert: true } }));
    const r   = await db.collection('tally_ledgers').bulkWrite(ops, { ordered: false });
    console.log(`           ✓  ${r.upsertedCount} new · ${r.modifiedCount} updated\n`);
  }

  // ── STEP 3: Vouchers (Jan 2024 → today) ──────────────────
  console.log('[ 2 / 4 ]  Syncing vouchers (Jan 2024 → today) ...');
  console.log('           Note: Tally ignores date filters — filtering in JS after fetch.');
  process.stdout.write('  Fetching all vouchers from Tally ... ');
  const vXml    = await tallyPost(envelope('SyncVouchers', `
<COLLECTION NAME="SyncVouchers" ISMODIFY="No">
  <TYPE>Voucher</TYPE>
  <FETCH>Date,VoucherNumber,VoucherTypeName,PartyLedgerName,Amount,Narration,ALLLEDGERENTRIES.LIST</FETCH>
</COLLECTION>`));
  const vouchers = parseVouchers(vXml, FROM_DATE);   // JS date filter applied here
  console.log(`${vouchers.length} vouchers from ${FROM_DATE} onwards`);

  if (vouchers.length > 0) {
    // Clear and re-insert so deleted vouchers are removed too
    await db.collection('tally_vouchers').deleteMany({});
    const BATCH = 500;
    const ops = vouchers.map(v => ({ replaceOne: { filter: { _id: v._id }, replacement: v, upsert: true } }));
    for (let i = 0; i < ops.length; i += BATCH) {
      await db.collection('tally_vouchers').bulkWrite(ops.slice(i, i + BATCH), { ordered: false });
    }
  }

  // Show month breakdown
  const byMonth = {};
  vouchers.forEach(v => { byMonth[v.month] = (byMonth[v.month] || 0) + 1; });
  Object.keys(byMonth).sort().forEach(m => console.log(`           ${m}: ${byMonth[m]} vouchers`));
  console.log(`           ✓  ${vouchers.length} total vouchers saved\n`);

  // ── STEP 3b: Last payment & purchase dates ────────────────
  console.log('           Computing last payment / purchase dates ...');
  const [receiptAgg, purchaseAgg] = await Promise.all([
    db.collection('tally_vouchers').aggregate([
      { $match: { type: { $in: ['Receipt', 'Journal'] }, party: { $gt: '' } } },
      { $sort:  { date: -1 } },
      { $group: { _id: '$party', lastPaymentDate: { $first: '$dateStr' }, lastPaymentAmt: { $first: '$amount' } } }
    ]).toArray(),
    db.collection('tally_vouchers').aggregate([
      { $match: { type: { $regex: /purchase/i } } },
      { $sort:  { date: -1 } },
      { $group: { _id: '$party', lastPurchaseDate: { $first: '$dateStr' }, lastPurchaseAmt: { $first: '$amount' } } }
    ]).toArray()
  ]);
  await Promise.all([
    ...receiptAgg.filter(r => r._id).map(r =>
      db.collection('tally_ledgers').updateOne({ _id: r._id },
        { $set: { lastPaymentDate: r.lastPaymentDate, lastPaymentAmt: r.lastPaymentAmt } })),
    ...purchaseAgg.filter(p => p._id).map(p =>
      db.collection('tally_ledgers').updateOne({ _id: p._id },
        { $set: { lastPurchaseDate: p.lastPurchaseDate, lastPurchaseAmt: p.lastPurchaseAmt } }))
  ]);
  console.log(`           ✓  ${receiptAgg.length} customer · ${purchaseAgg.length} supplier dates updated\n`);

  // ── STEP 4: Current stock items ───────────────────────────
  console.log('[ 3 / 4 ]  Syncing current stock ...');
  process.stdout.write('  Fetching stock items from Tally ... ');
  const sXml = await tallyPost(envelope('StockItems', `
<COLLECTION NAME="StockItems" ISMODIFY="No">
  <TYPE>Stock Item</TYPE>
  <FETCH>Name,Parent,ClosingBalance,ClosingValue</FETCH>
</COLLECTION>`));
  const stockItems = [];
  for (const blk of blocks(sXml, 'STOCKITEM')) {
    const name  = attr(blk, 'NAME') || stripXml(getTag(blk, 'NAME'));
    if (!name) continue;
    const qty   = Math.abs(parseTallyAmount(stripXml(getTag(blk, 'CLOSINGBALANCE'))));
    const value = Math.abs(parseTallyAmount(stripXml(getTag(blk, 'CLOSINGVALUE'))));
    if (qty > 0 || value > 0)
      stockItems.push({ _id: name, name, parent: stripXml(getTag(blk, 'PARENT')), qty, value, updatedAt: new Date() });
  }
  console.log(`${stockItems.length} items`);
  if (stockItems.length > 0) {
    const ops = stockItems.map(s => ({ replaceOne: { filter: { _id: s._id }, replacement: s, upsert: true } }));
    await db.collection('tally_stock').bulkWrite(ops, { ordered: false });
    const totalVal = stockItems.reduce((s, i) => s + (i.value || 0), 0);
    // Save today's stock snapshot (used by Gross Profit modal)
    const today = todayISO();
    await db.collection('tally_stock_history').replaceOne(
      { _id: today },
      { _id: today, date: new Date(), month: today.slice(0, 7), totalValue: totalVal, itemCount: stockItems.length, source: 'sync' },
      { upsert: true }
    );
    console.log(`           ✓  ${stockItems.length} items · ₹${Math.round(totalVal).toLocaleString('en-IN')} total value\n`);
  }

  // ── STEP 5: Dashboard snapshot ────────────────────────────
  console.log('[ 4 / 4 ]  Saving dashboard snapshot ...');
  const debtors   = ledgers.filter(l => l.type === 'debtor'   && l.balance > 0).sort((a,b) => b.balance - a.balance);
  const creditors = ledgers.filter(l => l.type === 'creditor' && l.balance > 0).sort((a,b) => b.balance - a.balance);
  const snap = {
    connected:        true,
    company:          TALLY_COMPANY,
    tallyUrl:         TALLY_BASE,
    totalSales:       ledgers.filter(l => l.type === 'sales').reduce((s,l) => s + Math.abs(l.balance), 0),
    totalPurchases:   ledgers.filter(l => l.type === 'purchase').reduce((s,l) => s + Math.abs(l.balance), 0),
    totalExpenses:    ledgers.filter(l => l.type === 'expense').reduce((s,l) => s + Math.abs(l.balance), 0),
    cashBalance:      ledgers.filter(l => l.type === 'cash').reduce((s,l) => s + Math.abs(l.balance), 0),
    bankBalance:      ledgers.filter(l => l.type === 'bank').reduce((s,l) => s + Math.abs(l.balance), 0),
    totalOutstanding: debtors.reduce((s,l)  => s + l.balance, 0),
    supplierDues:     creditors.reduce((s,l) => s + l.balance, 0),
    debtors:          debtors.slice(0, 15).map(d => ({ name: d.name, balance: d.balance })),
    creditors:        creditors.slice(0, 15).map(c => ({ name: c.name, balance: c.balance })),
    recentVouchers:   []
  };
  const now     = new Date();
  const dateKey = now.toISOString().slice(0, 10);
  await Promise.all([
    db.collection('tally_snapshots').replaceOne({ _id: 'main' },    { _id: 'main',    ...snap, syncedAt: now }, { upsert: true }),
    db.collection('tally_snapshots').replaceOne({ _id: dateKey }, { _id: dateKey, date: dateKey, ...snap, syncedAt: now }, { upsert: true }),
  ]);
  console.log('           ✓  Snapshot saved\n');

  // ── Summary ───────────────────────────────────────────────
  const typeCounts = await db.collection('tally_vouchers').aggregate([
    { $group: { _id: '$type', n: { $sum: 1 } } }, { $sort: { n: -1 } }
  ]).toArray();

  console.log('╔════════════════════════════════════════╗');
  console.log('║          SYNC  COMPLETE                ║');
  console.log('╠════════════════════════════════════════╣');
  console.log(`║  Ledgers     : ${String(ledgers.length).padEnd(24)}║`);
  console.log(`║  Vouchers    : ${String(vouchers.length).padEnd(24)}║`);
  console.log(`║  Stock items : ${String(stockItems.length).padEnd(24)}║`);
  console.log('║  By type:                              ║');
  typeCounts.forEach(v => console.log(`║    ${(v._id + ' : ' + v.n).padEnd(36)}║`));
  console.log('╚════════════════════════════════════════╝');
  console.log('\n✓  Dashboard ready. All Tally data stored in MongoDB.');
  console.log('   Use "Sync to DB" button daily to keep it current.\n');

  await client.close();
}

main().catch(e => {
  console.error('\n✗  Error:', e.message);
  if (e.message.includes('ECONNREFUSED') || e.message.includes('ECONNRESET')) {
    console.error('   TallyPrime is not running or HTTP server is disabled.');
    console.error('   Open TallyPrime → F12 → Advanced Config → Enable HTTP on port 9000');
  }
  process.exit(1);
});
