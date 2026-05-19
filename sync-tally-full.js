// ─────────────────────────────────────────────────────────────
//  PLATINA  Full Tally → MongoDB Sync
//  Run once:  node sync-tally-full.js
//  After that use the "Sync to DB" button daily.
// ─────────────────────────────────────────────────────────────
require('dotenv').config();
const { MongoClient } = require('mongodb');

const TALLY_BASE    = process.env.TALLY_URL || process.env.TALLY_BASE || 'http://localhost:9000';
const TALLY_COMPANY = process.env.TALLY_COMPANY || '';
const MONGO_URI     = process.env.MONGODB_URI;
const MONGO_DB      = process.env.MONGODB_DB_NAME || 'tally_sync';

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
  return String(s || '').replace(/&amp;/g,'&').replace(/&lt;/g,'<')
    .replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'");
}
function escapeXml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'>').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
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
    signal: AbortSignal.timeout(120000)
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
    const bal    = parseTallyAmount(balStr);
    const absBal = Math.abs(bal);
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

    // Debtors: Dr balance = they owe us = stored positive
    // Creditors: Cr balance = we owe them = stored positive
    let balance = isCr ? -absBal : absBal;
    if (type === 'creditor') balance = isCr ? absBal : -absBal;

    out.push({ _id: name, name, parent, type, balance, updatedAt: new Date() });
  }
  return out;
}

// ── Parse vouchers ────────────────────────────────────────────
function parseVouchers(xml) {
  const out = [];
  for (const blk of blocks(xml, 'VOUCHER')) {
    const dateStr = formatTallyDate(stripXml(getTag(blk, 'DATE')));
    if (!dateStr) continue;
    const type   = stripXml(getTag(blk, 'VOUCHERTYPENAME')) || attr(blk, 'VCHTYPE');
    if (!type)    continue;
    const num    = stripXml(getTag(blk, 'VOUCHERNUMBER'));
    const party  = stripXml(getTag(blk, 'PARTYLEDGERNAME'));
    const amount = Math.abs(parseTallyAmount(getTag(blk, 'AMOUNT')));
    const raw    = `${dateStr}|${type}|${num || (party + '|' + amount)}`;
    const _id    = raw.replace(/[^a-zA-Z0-9|._-]/g, '_').slice(0, 120);
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

// ── Fetch helpers ─────────────────────────────────────────────
async function fetchLedgers() {
  process.stdout.write('  Fetching ledgers ... ');
  const xml = await tallyPost(envelope('SyncLedgers', `
<COLLECTION NAME="SyncLedgers" ISMODIFY="No">
  <TYPE>Ledger</TYPE>
  <FETCH>Name,Parent,ClosingBalance</FETCH>
</COLLECTION>`));
  const rows = parseLedgers(xml);
  console.log(`${rows.length} ledgers`);
  return rows;
}

async function fetchVouchers() {
  process.stdout.write(`  Fetching all vouchers ... `);
  // Note: SVFROMDATE/SVTODATE is ignored by this TallyPrime instance — fetch all and let
  // MongoDB upsert handle deduplication across runs.
  const xml = await tallyPost(envelope('SyncVouchers', `
<COLLECTION NAME="SyncVouchers" ISMODIFY="No">
  <TYPE>Voucher</TYPE>
  <FETCH>Date,VoucherNumber,VoucherTypeName,PartyLedgerName,Amount,Narration</FETCH>
</COLLECTION>`));
  const rows = parseVouchers(xml);
  console.log(`${rows.length} vouchers`);
  return rows;
}

// ── Fetch stock items ─────────────────────────────────────────
async function fetchStock() {
  process.stdout.write('  Fetching stock items ... ');
  const xml = await tallyPost(envelope('StockItems', `
<COLLECTION NAME="StockItems" ISMODIFY="No">
  <TYPE>Stock Item</TYPE>
  <FETCH>Name,Parent,ClosingBalance,ClosingValue</FETCH>
</COLLECTION>`));
  const rows = [];
  for (const blk of blocks(xml, 'STOCKITEM')) {
    const name  = attr(blk, 'NAME') || stripXml(getTag(blk, 'NAME'));
    if (!name) continue;
    const qty   = Math.abs(parseTallyAmount(stripXml(getTag(blk, 'CLOSINGBALANCE'))));
    const value = Math.abs(parseTallyAmount(stripXml(getTag(blk, 'CLOSINGVALUE'))));
    if (qty > 0 || value > 0)
      rows.push({ _id: name, name, parent: stripXml(getTag(blk, 'PARENT')), qty, value, updatedAt: new Date() });
  }
  console.log(`${rows.length} items`);
  return rows;
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║   PLATINA  Full Tally → MongoDB Sync   ║');
  console.log('╚════════════════════════════════════════╝\n');

  if (!MONGO_URI) { console.error('✗  MONGODB_URI not set in .env'); process.exit(1); }

  // 1. Verify Tally is reachable
  process.stdout.write(`Connecting to Tally at ${TALLY_BASE} ... `);
  try {
    await tallyPost(`<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>` +
      `<BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>List of Companies</REPORTNAME>` +
      `</REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`);
  } catch(e) {
    if (!e.message.includes('Could not find') && !e.message.includes('Tally XML')) throw e;
  }
  console.log('✓\n');

  // 2. Connect MongoDB
  process.stdout.write('Connecting to MongoDB ... ');
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(MONGO_DB);
  console.log('✓\n');

  // 3. Create indexes
  process.stdout.write('Creating indexes ... ');
  await db.collection('tally_ledgers').createIndex({ type: 1 });
  await db.collection('tally_ledgers').createIndex({ balance: -1 });
  await db.collection('tally_vouchers').createIndex({ date: -1 });
  await db.collection('tally_vouchers').createIndex({ month: 1, type: 1 });
  await db.collection('tally_vouchers').createIndex({ party: 1, type: 1 });
  console.log('✓\n');

  // 4. Sync ledgers
  console.log('[ 1 / 4 ]  Syncing ledgers ...');
  const ledgers = await fetchLedgers();
  if (ledgers.length > 0) {
    const ops = ledgers.map(l => ({ replaceOne: { filter: { _id: l._id }, replacement: l, upsert: true } }));
    const r   = await db.collection('tally_ledgers').bulkWrite(ops, { ordered: false });
    console.log(`           ✓  ${r.upsertedCount} new · ${r.modifiedCount} updated\n`);
  }

  // 5. Sync vouchers — fetch all at once (SVFROMDATE/SVTODATE ignored by this TallyPrime)
  console.log('[ 2 / 4 ]  Syncing vouchers ...');
  const vouchers = await fetchVouchers();
  if (vouchers.length > 0) {
    const ops = vouchers.map(v => ({ replaceOne: { filter: { _id: v._id }, replacement: v, upsert: true } }));
    const BATCH = 500;
    for (let i = 0; i < ops.length; i += BATCH) {
      await db.collection('tally_vouchers').bulkWrite(ops.slice(i, i + BATCH), { ordered: false });
    }
  }
  const totalV = vouchers.length;
  // Show breakdown by month
  const byMonth = {};
  vouchers.forEach(v => { byMonth[v.month] = (byMonth[v.month] || 0) + 1; });
  Object.keys(byMonth).sort().forEach(m => console.log(`           ${m}: ${byMonth[m]} vouchers`));
  console.log(`           ✓  ${totalV} total vouchers saved\n`);

  // 6. Compute last payment / purchase dates from vouchers
  console.log('[ 3 / 4 ]  Computing last payment dates ...');

  const receiptAgg = await db.collection('tally_vouchers').aggregate([
    { $match: { type: { $in: ['Receipt', 'Journal'] }, party: { $gt: '' } } },
    { $sort:  { date: -1 } },
    { $group: { _id: '$party', lastPaymentDate: { $first: '$dateStr' }, lastPaymentAmt: { $first: '$amount' } } }
  ]).toArray();
  for (const r of receiptAgg) {
    if (r._id) await db.collection('tally_ledgers').updateOne(
      { _id: r._id }, { $set: { lastPaymentDate: r.lastPaymentDate, lastPaymentAmt: r.lastPaymentAmt } }
    );
  }

  const purchaseAgg = await db.collection('tally_vouchers').aggregate([
    { $match: { type: { $regex: /purchase/i } } },
    { $sort:  { date: -1 } },
    { $group: { _id: '$party', lastPurchaseDate: { $first: '$dateStr' }, lastPurchaseAmt: { $first: '$amount' } } }
  ]).toArray();
  for (const p of purchaseAgg) {
    if (p._id) await db.collection('tally_ledgers').updateOne(
      { _id: p._id }, { $set: { lastPurchaseDate: p.lastPurchaseDate, lastPurchaseAmt: p.lastPurchaseAmt } }
    );
  }
  console.log(`           ✓  ${receiptAgg.length} customer · ${purchaseAgg.length} supplier dates updated\n`);

  // 7. Sync stock items
  console.log('[ 4 / 5 ]  Syncing stock items ...');
  const stockItems = await fetchStock();
  if (stockItems.length > 0) {
    const ops = stockItems.map(s => ({ replaceOne: { filter: { _id: s._id }, replacement: s, upsert: true } }));
    await db.collection('tally_stock').bulkWrite(ops, { ordered: false });
  }
  console.log(`           ✓  ${stockItems.length} stock items saved\n`);

  // 8. Save summary snapshot
  console.log('[ 5 / 5 ]  Saving snapshot ...');
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
    totalOutstanding: debtors.reduce((s,l) => s + l.balance, 0),
    supplierDues:     creditors.reduce((s,l) => s + l.balance, 0),
    debtors:          debtors.slice(0,15).map(d => ({ name: d.name, balance: d.balance })),
    creditors:        creditors.slice(0,15).map(c => ({ name: c.name, balance: c.balance })),
    recentVouchers:   []
  };
  const now     = new Date();
  const dateKey = now.toISOString().slice(0, 10);
  await db.collection('tally_snapshots').replaceOne({ _id: 'main' },    { _id: 'main',    ...snap, syncedAt: now }, { upsert: true });
  await db.collection('tally_snapshots').replaceOne({ _id: dateKey }, { _id: dateKey, date: dateKey, ...snap, syncedAt: now }, { upsert: true });
  console.log('           ✓  Snapshot saved\n');

  // ── Final summary ────────────────────────────────────────────
  const typeCounts = await db.collection('tally_vouchers').aggregate([
    { $group: { _id: '$type', n: { $sum: 1 } } }, { $sort: { n: -1 } }
  ]).toArray();

  console.log('╔════════════════════════════════════════╗');
  console.log('║          SYNC  COMPLETE                ║');
  console.log('╠════════════════════════════════════════╣');
  console.log(`║  Ledgers  : ${String(ledgers.length).padEnd(27)}║`);
  console.log(`║  Vouchers : ${String(totalV).padEnd(27)}║`);
  console.log(`║  Stock    : ${String(stockItems.length).padEnd(27)}║`);
  console.log('║  Breakdown:                            ║');
  typeCounts.forEach(v => {
    const line = `    ${v._id} : ${v.n}`;
    console.log(`║  ${line.padEnd(38)}║`);
  });
  console.log('╚════════════════════════════════════════╝');
  console.log('\nDatabase ready.');
  console.log('Use the "Sync to DB" button daily to keep data current.\n');

  await client.close();
}

main().catch(e => {
  console.error('\n✗  Error:', e.message);
  if (e.message.includes('ECONNREFUSED') || e.message.includes('ECONNRESET')) {
    console.error('   → Check: MongoDB Atlas IP whitelist or Tally HTTP server at', TALLY_BASE);
  }
  process.exit(1);
});
