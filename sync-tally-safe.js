// ─────────────────────────────────────────────────────────────
//  PLATINA  Safe Tally → MongoDB Sync  (accounts team laptops)
//
//  Syncs ledgers + stock only — no voucher dump so Tally never crashes.
//  Voucher history is already in MongoDB from the main laptop sync.
//
//  Run:  node sync-tally-safe.js
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
function stripXml(s)  { return decodeXml(String(s || '').replace(/<[^>]+>/g, '').trim()); }
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
const todayISO = () => new Date().toISOString().slice(0, 10);

// ── Tally HTTP ────────────────────────────────────────────────
async function tallyPost(xml) {
  const r = await fetch(TALLY_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml;charset=utf-8' },
    body: xml,
    signal: AbortSignal.timeout(60000)
  });
  if (!r.ok) throw new Error(`Tally HTTP ${r.status}`);
  const text = await r.text();
  if (/LINEERROR/i.test(text)) {
    const msg = stripXml(getTag(text, 'LINEERROR'));
    if (!msg.includes('Could not find')) throw new Error(msg || 'Tally XML error');
  }
  return text;
}

function envelope(name, body) {
  const co = TALLY_COMPANY ? `<SVCURRENTCOMPANY>${escapeXml(TALLY_COMPANY)}</SVCURRENTCOMPANY>` : '';
  return `<ENVELOPE>
<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>${name}</ID></HEADER>
<BODY><DESC><STATICVARIABLES>${co}<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
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

// ── Main ──────────────────────────────────────────────────────
async function main() {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║  PLATINA  Safe Tally → MongoDB Sync    ║');
  console.log('║  Ledgers + Stock only (no vouchers)    ║');
  console.log('╚════════════════════════════════════════╝\n');

  if (!MONGO_URI) { console.error('✗  MONGODB_URI not set in .env'); process.exit(1); }

  // ── Check Tally ───────────────────────────────────────────
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

  // ── STEP 1: Ledgers ───────────────────────────────────────
  console.log('[ 1 / 3 ]  Syncing ledgers ...');
  process.stdout.write('  Fetching from Tally ... ');
  const ledXml = await tallyPost(envelope('SyncLedgers', `
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

  // ── STEP 2: Vouchers — last 2 days only ──────────────────
  console.log('[ 2 / 4 ]  Syncing recent vouchers (last 2 days) ...');
  try {
    const today    = todayISO();
    const twoDaysAgo = new Date(); twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    const fromDate = `${twoDaysAgo.getFullYear()}-${String(twoDaysAgo.getMonth()+1).padStart(2,'0')}-${String(twoDaysAgo.getDate()).padStart(2,'0')}`;
    process.stdout.write(`  Fetching ${fromDate} → ${today} ... `);

    const co   = TALLY_COMPANY ? `<SVCURRENTCOMPANY>${escapeXml(TALLY_COMPANY)}</SVCURRENTCOMPANY>` : '';
    const vXml = await tallyPost(`<ENVELOPE>
<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>RecentVouchers</ID></HEADER>
<BODY><DESC>
<STATICVARIABLES>
  ${co}
  <SVFROMDATE>${fromDate.replace(/-/g,'')}</SVFROMDATE>
  <SVTODATE>${today.replace(/-/g,'')}</SVTODATE>
  <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
</STATICVARIABLES>
<TDL><TDLMESSAGE>
<COLLECTION NAME="RecentVouchers" ISMODIFY="No">
  <TYPE>Voucher</TYPE>
  <FETCH>Date,VoucherNumber,VoucherTypeName,PartyLedgerName,Amount,Narration,ALLLEDGERENTRIES.LIST</FETCH>
</COLLECTION>
</TDLMESSAGE></TDL>
</DESC></BODY></ENVELOPE>`);

    // Parse and filter strictly to last 2 days in JS (backup if Tally ignores dates)
    const recentVouchers = [];
    for (const blk of blocks(vXml, 'VOUCHER')) {
      const dateStr = (() => { const t = String(stripXml(getTag(blk,'DATE'))||'').trim(); return /^\d{8}$/.test(t)?`${t.slice(0,4)}-${t.slice(4,6)}-${t.slice(6,8)}`:t.slice(0,10)||null; })();
      if (!dateStr || dateStr < fromDate || dateStr > today) continue;
      const type = stripXml(getTag(blk,'VOUCHERTYPENAME')) || attr(blk,'VCHTYPE');
      if (!type) continue;
      const num   = stripXml(getTag(blk,'VOUCHERNUMBER'));
      const party = stripXml(getTag(blk,'PARTYLEDGERNAME'));
      let amount  = Math.abs(parseTallyAmount(getTag(blk,'AMOUNT')));
      if (type.toLowerCase() === 'journal') {
        const re = /<ALLLEDGERENTRIES\.LIST[\s\S]*?<\/ALLLEDGERENTRIES\.LIST>/gi;
        let jTotal = 0;
        for (const m of vXml.matchAll(re)) {
          const e = m[0];
          if (!/gurmeet/i.test(stripXml(getTag(e,'LEDGERNAME')))) continue;
          if (!/yes/i.test(stripXml(getTag(e,'ISDEEMEDPOSITIVE')))) continue;
          jTotal += Math.abs(parseTallyAmount(getTag(e,'AMOUNT')));
        }
        amount = jTotal;
      }
      const raw = `${dateStr}|${type}|${num}|${party}|${amount}`;
      const _id = raw.replace(/[^a-zA-Z0-9|._-]/g,'_').slice(0,120);
      recentVouchers.push({ _id, dateStr, date: new Date(dateStr), month: dateStr.slice(0,7), type, voucherNumber: num, party, amount, narration: stripXml(getTag(blk,'NARRATION')) });
    }

    console.log(`${recentVouchers.length} vouchers`);
    if (recentVouchers.length > 0) {
      const ops = recentVouchers.map(v => ({ replaceOne: { filter: { _id: v._id }, replacement: v, upsert: true } }));
      await db.collection('tally_vouchers').bulkWrite(ops, { ordered: false });
      console.log(`           ✓  ${recentVouchers.length} vouchers upserted (history untouched)\n`);
    } else {
      console.log('           ✓  No new vouchers in last 2 days\n');
    }
  } catch(e) {
    console.log(`           ⚠  Skipped — ${e.message}`);
    console.log('           Ledgers + stock will still be updated.\n');
  }

  // ── STEP 3: Stock ─────────────────────────────────────────
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
    const today    = todayISO();
    await db.collection('tally_stock_history').replaceOne(
      { _id: today },
      { _id: today, date: new Date(), month: today.slice(0, 7), totalValue: totalVal, itemCount: stockItems.length, source: 'sync' },
      { upsert: true }
    );
    console.log(`           ✓  ${stockItems.length} items · ₹${Math.round(totalVal).toLocaleString('en-IN')} total value\n`);
  }

  // ── STEP 3: Dashboard snapshot ────────────────────────────
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
    db.collection('tally_snapshots').replaceOne({ _id: 'main' },  { _id: 'main',  ...snap, syncedAt: now }, { upsert: true }),
    db.collection('tally_snapshots').replaceOne({ _id: dateKey }, { _id: dateKey, date: dateKey, ...snap, syncedAt: now }, { upsert: true }),
  ]);
  console.log('           ✓  Snapshot saved\n');

  // ── Summary ───────────────────────────────────────────────
  console.log('╔════════════════════════════════════════╗');
  console.log('║          SYNC  COMPLETE                ║');
  console.log('╠════════════════════════════════════════╣');
  console.log(`║  Ledgers     : ${String(ledgers.length).padEnd(24)}║`);
  console.log(`║  Stock items : ${String(stockItems.length).padEnd(24)}║`);
  console.log(`║  Vouchers    : last 2 days (upserted)  ║`);
  console.log('╚════════════════════════════════════════╝');
  console.log('\n✓  Ledger balances and stock updated in MongoDB.');
  console.log('   Run sync-tally-full.js from main laptop for voucher history.\n');

  await client.close();
}

main().catch(e => {
  console.error('\n❌  Error:', e.message);
  process.exit(1);
});
