require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path    = require('path');
const { MongoClient } = require('mongodb');
const app     = express();

// ── MongoDB ───────────────────────────────────────────────
const MONGO_URI = process.env.MONGODB_URI || '';
const MONGO_DB  = process.env.MONGODB_DB_NAME || 'tally_sync';
let _mongoClient = null;
async function getMongoDb() {
  if (!MONGO_URI) return null;
  if (!_mongoClient) {
    _mongoClient = new MongoClient(MONGO_URI);
    await _mongoClient.connect();
  }
  return _mongoClient.db(MONGO_DB);
}
async function saveTallySnapshot(data) {
  try {
    const db = await getMongoDb();
    if (!db) return;
    const now = new Date();
    const dateKey = now.toISOString().slice(0, 10); // 'YYYY-MM-DD'
    const doc = { ...data, syncedAt: now };
    // Keep 'main' for fallback reads
    await db.collection('tally_snapshots').replaceOne(
      { _id: 'main' },
      { _id: 'main', ...doc },
      { upsert: true }
    );
    // Save a dated daily record so history builds up
    await db.collection('tally_snapshots').replaceOne(
      { _id: dateKey },
      { _id: dateKey, date: dateKey, ...doc },
      { upsert: true }
    );
  } catch(e) { console.error('Mongo save error:', e.message); }
}
async function loadTallySnapshot() {
  try {
    const db = await getMongoDb();
    if (!db) return null;
    return await db.collection('tally_snapshots').findOne({ _id: 'main' });
  } catch(e) { console.error('Mongo load error:', e.message); return null; }
}

// ── Tally DB helpers (used by sync endpoint + /tally route) ──
function parseLedgersFromXml(xml) {
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
    let balance = isCr ? -absBal : absBal;
    if (type === 'creditor') balance = isCr ? absBal : -absBal;
    out.push({ _id: name, name, parent, type, balance });
  }
  return out;
}

function parseVouchersFromXml(xml) {
  const out = [];
  for (const blk of blocks(xml, 'VOUCHER')) {
    const dateStr = formatTallyDate(stripXml(getTag(blk, 'DATE')));
    if (!dateStr) continue;
    const type   = stripXml(getTag(blk, 'VOUCHERTYPENAME')) || attr(blk, 'VCHTYPE');
    if (!type)    continue;
    const num    = stripXml(getTag(blk, 'VOUCHERNUMBER'));
    const party  = stripXml(getTag(blk, 'PARTYLEDGERNAME'));
    const amount = Math.abs(parseTallyAmount(getTag(blk, 'AMOUNT')));
    const raw    = `${dateStr}|${type}|${num}|${party}|${amount}`;
    const _id    = raw.replace(/[^a-zA-Z0-9|._-]/g, '_').slice(0, 120);
    out.push({ _id, dateStr, date: new Date(dateStr), month: dateStr.slice(0,7),
               type, voucherNumber: num, party, amount,
               narration: stripXml(getTag(blk, 'NARRATION')) });
  }
  return out;
}

async function updateLastPaymentDates(db) {
  // Journal = money received in this business (no Receipt voucher type used)
  const receipts = await db.collection('tally_vouchers').aggregate([
    { $match: { type: { $in: ['Receipt', 'Journal'] }, party: { $gt: '' } } },
    { $sort:  { date: -1 } },
    { $group: { _id: '$party', lastPaymentDate: { $first: '$dateStr' }, lastPaymentAmt: { $first: '$amount' } } }
  ]).toArray();
  for (const r of receipts) {
    if (r._id) await db.collection('tally_ledgers').updateOne(
      { _id: r._id }, { $set: { lastPaymentDate: r.lastPaymentDate, lastPaymentAmt: r.lastPaymentAmt } }
    );
  }
  const purchases = await db.collection('tally_vouchers').aggregate([
    { $match: { type: { $regex: /purchase/i } } },
    { $sort:  { date: -1 } },
    { $group: { _id: '$party', lastPurchaseDate: { $first: '$dateStr' }, lastPurchaseAmt: { $first: '$amount' } } }
  ]).toArray();
  for (const p of purchases) {
    if (p._id) await db.collection('tally_ledgers').updateOne(
      { _id: p._id }, { $set: { lastPurchaseDate: p.lastPurchaseDate, lastPurchaseAmt: p.lastPurchaseAmt } }
    );
  }
}

async function fetchTallyStock() {
  const xml = await tallyCollection('StockItems', `
<COLLECTION NAME="StockItems" ISMODIFY="No">
  <TYPE>Stock Item</TYPE>
  <FETCH>Name,Parent,ClosingBalance,ClosingValue</FETCH>
</COLLECTION>`);
  const items = [];
  for (const blk of blocks(xml, 'STOCKITEM')) {
    const name  = attr(blk, 'NAME') || stripXml(getTag(blk, 'NAME'));
    if (!name) continue;
    const qty   = Math.abs(parseTallyAmount(stripXml(getTag(blk, 'CLOSINGBALANCE'))));
    const value = Math.abs(parseTallyAmount(stripXml(getTag(blk, 'CLOSINGVALUE'))));
    if (qty > 0 || value > 0)
      items.push({ _id: name, name, parent: stripXml(getTag(blk, 'PARENT')), qty, value, updatedAt: new Date() });
  }
  return items;
}

// Fetch total stock value from Tally AS OF a specific date.
// Tally respects SVTODATE for ClosingValue (balance-type field) — gives stock as of that day.
// Returns total rupee value, or null if Tally is unreachable.
async function fetchTallyStockTotal(asOfDate) {
  // fromDate far in past so Tally computes full opening; toDate = the date we want
  const xml = await tallyCollection('StockAsOf', `
<COLLECTION NAME="StockAsOf" ISMODIFY="No">
  <TYPE>Stock Item</TYPE>
  <FETCH>Name,ClosingValue</FETCH>
</COLLECTION>`, { fromDate: '2020-01-01', toDate: asOfDate });
  let total = 0;
  for (const blk of blocks(xml, 'STOCKITEM')) {
    total += Math.abs(parseTallyAmount(stripXml(getTag(blk, 'CLOSINGVALUE'))));
  }
  return total;
}

// ── Auth credentials ─────────────────────────────────────
const PASSCODE         = process.env.PASSCODE || '1990';
const PASSCODE_LIMITED = '1122';

const TOKEN   = process.env.TOKEN || '';
const MS_BASE = 'https://api.moysklad.ru/api/remap/1.2';
const TALLY_BASE    = process.env.TALLY_URL || process.env.TALLY_BASE || 'http://localhost:9000';
const TALLY_COMPANY = process.env.TALLY_COMPANY || '';
const PORT = process.env.PORT || 3000;
const CUR     = '₽';

// ── Express setup ────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('view cache', true);
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d', etag: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'platina_secret_key_2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 } // 8-hour session
}));

// ── Auth routes ───────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session.loggedIn) return res.redirect('/');
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  if (req.body.passcode === PASSCODE) {
    req.session.loggedIn = true;
    req.session.role = 'admin';
    return res.redirect('/loading');
  }
  if (PASSCODE_LIMITED && req.body.passcode === PASSCODE_LIMITED) {
    req.session.loggedIn = true;
    req.session.role = 'limited';
    return res.redirect('/loading');
  }
  res.render('login', { error: 'Incorrect passcode. Try again.' });
});

app.get('/loading', (req, res) => {
  if (!req.session.loggedIn) return res.redirect('/login');
  res.render('loading');
});

// Pre-warm all caches so the dashboard loads instantly after login
app.get('/api/warm', async (req, res) => {
  if (!req.session.loggedIn) return res.status(401).json({ ok: false });
  try {
    const warmed = await Promise.allSettled([
      common(),                              // 0
      getStock(),                            // 1
      getAllOrders(),                         // 2
      getRecentDemands(),                    // 3
      getOrderStateMap(),                    // 4
      getProfitByProduct(monthStart()),      // 5
      getProfitByCounterparty(monthStart()), // 6
      getDemandsFromDec25(),                 // 7
    ]);
    // Also pre-warm pending PCS (needs orders + stateMap already cached above)
    const ordersVal   = warmed[2].status === 'fulfilled' ? warmed[2].value : [];
    const stateMapVal = warmed[4].status === 'fulfilled' ? warmed[4].value : {};
    const pendingIds  = ordersVal
      .filter(r => {
        if (!r.state) return false;
        const s = resolveState(r, stateMapVal).toLowerCase();
        if (!s || /^draft$|черновик/.test(s)) return false;
        return !/dispatched|отгруж|declin|cancel|отмен|отклон|аннул/.test(s);
      })
      .map(o => o.id);
    if (pendingIds.length) await getPendingPCS(pendingIds).catch(() => {});
    // Pre-warm today's PCS from recent demands (warmed[3])
    const demandsVal = warmed[3].status === 'fulfilled' ? warmed[3].value : [];
    const todayWarm  = todayStr();
    const todayIds   = demandsVal.filter(d => (d.moment||'').startsWith(todayWarm)).map(d => d.id);
    if (todayIds.length) await getTodayPCS(todayIds).catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: true, warn: e.message });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ── Auth guard — protects all routes below ────────────────
app.use((req, res, next) => {
  if (req.session.loggedIn) return next();
  res.redirect('/login');
});

// ── Format helpers available in all EJS templates ────────
app.use((req, res, next) => {
  res.locals.active       = '';
  res.locals.canViewTally = req.session.role !== 'limited';
  res.locals.empName   = 'Admin';
  res.locals.empLetter = 'A';
  res.locals.empRole   = 'System';
  res.locals.date      = new Date().toLocaleDateString('en-IN', { day:'2-digit', month:'long', year:'numeric' });
  res.locals.time      = new Date().toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' });
  res.locals.fmt = (n) =>
    (n == null || isNaN(n)) ? '—' : CUR + Math.round(n).toLocaleString('en-US');
  res.locals.fmtShort = (n) => {
    if (n == null || isNaN(n)) return '—';
    const a = Math.abs(n);
    if (a >= 1e9) return CUR + (n/1e9).toFixed(2) + ' B';
    if (a >= 1e6) return CUR + (n/1e6).toFixed(2) + ' M';
    if (a >= 1e3) return CUR + Math.round(n/1e3) + 'K';
    return CUR + Math.round(n);
  };
  res.locals.fmtDate = (s) => s ? s.slice(0,10) : '—';
  res.locals.CUR = CUR;
  next();
});

// ── Moysklad API helper ──────────────────────────────────
async function ms(path, _retries = 3) {
  for (let attempt = 0; attempt <= _retries; attempt++) {
    const r = await fetch(MS_BASE + path, {
      headers: {
        'Authorization': 'Bearer ' + TOKEN,
        'Accept': 'application/json;charset=utf-8'
      }
    });
    if (r.status === 429 && attempt < _retries) {
      await new Promise(res => setTimeout(res, Math.pow(2, attempt) * 1000));
      continue;
    }
    if (!r.ok) throw new Error('MS API ' + r.status + ' ' + path);
    return r.json();
  }
}

// Fetch all pages from a Moysklad list endpoint (handles pagination automatically)
async function msAll(endpoint, maxRecords = 10000) {
  const sep = endpoint.includes('?') ? '&' : '?';
  const first = await ms(`${endpoint}${sep}limit=1000&offset=0`);
  const total = first.meta?.size || 0;
  let rows = first.rows || [];

  if (total > 1000) {
    const toFetch = Math.min(total, maxRecords);
    const pagePromises = [];
    for (let offset = 1000; offset < toFetch; offset += 1000)
      pagePromises.push(ms(`${endpoint}${sep}limit=1000&offset=${offset}`));
    const settled = await Promise.allSettled(pagePromises);
    settled.forEach(r => { if (r.status === 'fulfilled') rows = rows.concat(r.value.rows || []); });
  }
  return { rows, total };
}

// Pre-fetch all assortment names into a href→name map (cached 30 min).
// Used by fetchAllPos callers so we don't need expand=assortment on positions,
// which causes MoySklad to silently cap page size to ~25 regardless of the limit param.
async function getNameMap() {
  return cached('assortment_name_map', 30*60*1000, async () => {
    const { rows } = await msAll('/entity/assortment');
    const map = {};
    rows.forEach(a => { if (a.meta?.href && a.name) map[a.meta.href] = a.name; });
    return map;
  });
}

// Fetch ALL positions for one demand without expand=assortment (avoids MoySklad's
// secret ~25-row cap that applies when expand is used).  Names are resolved via
// the pre-fetched assortment map instead.
async function fetchAllPos(demandId) {
  const first = await ms(`/entity/demand/${demandId}/positions?limit=1000`);
  const total = first.meta?.size || 0;
  let rows = first.rows || [];
  if (rows.length < total) {
    const pages = [];
    for (let off = rows.length; off < total; off += 1000)
      pages.push(ms(`/entity/demand/${demandId}/positions?limit=1000&offset=${off}`));
    const settled = await Promise.allSettled(pages);
    settled.forEach(r => { if (r.status === 'fulfilled') rows = rows.concat(r.value.rows || []); });
  }
  return rows;
}

// TallyPrime XML helper. Start Tally and enable its HTTP server on port 9000.
async function tallyXml(xml, timeoutMs = 30000) {
  const signal = AbortSignal.timeout(timeoutMs);
  const r = await fetch(TALLY_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml;charset=utf-8' },
    body: xml,
    signal
  });
  if (!r.ok) throw new Error('Tally API ' + r.status);
  const text = await r.text();
  if (/LINEERROR/i.test(text)) throw new Error(stripXml(getTag(text, 'LINEERROR')) || 'Tally XML error');
  return text;
}

function tallyEnvelope(collectionName, collectionBody, fromDate, toDate) {
  const company = TALLY_COMPANY ? `<SVCURRENTCOMPANY>${escapeXml(TALLY_COMPANY)}</SVCURRENTCOMPANY>` : '';
  const dates = fromDate || toDate
    ? `<SVFROMDATE>${tallyDate(fromDate || monthStart())}</SVFROMDATE><SVTODATE>${tallyDate(toDate || todayStr())}</SVTODATE>`
    : '';
  return `<ENVELOPE>
<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>${collectionName}</ID></HEADER>
<BODY><DESC>
<STATICVARIABLES>${company}${dates}<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
<TDL><TDLMESSAGE>${collectionBody}</TDLMESSAGE></TDL>
</DESC></BODY>
</ENVELOPE>`;
}

async function tallyCollection(collectionName, collectionBody, options = {}) {
  return tallyXml(tallyEnvelope(collectionName, collectionBody, options.fromDate, options.toDate));
}

async function tallyReceiptVouchers(page, limit) {
  const xml = await tallyCollection('RemoteReceiptVouchers', `
<COLLECTION NAME="RemoteReceiptVouchers" ISMODIFY="No">
  <TYPE>Voucher</TYPE>
  <FETCH>Date,VoucherNumber,VoucherTypeName,PartyLedgerName,Amount,Narration</FETCH>
  <FILTER>OnlyReceipts</FILTER>
</COLLECTION>
<SYSTEM TYPE="Formulae" NAME="OnlyReceipts">$VoucherTypeName = "Receipt"</SYSTEM>`);
  return paginate(parseVouchers(xml), page, limit);
}

async function tallyPurchaseVouchers(page, limit) {
  const xml = await tallyCollection('RemotePurchaseVouchers', `
<COLLECTION NAME="RemotePurchaseVouchers" ISMODIFY="No">
  <TYPE>Voucher</TYPE>
  <FETCH>Date,VoucherNumber,VoucherTypeName,PartyLedgerName,Amount,Narration</FETCH>
  <FILTER>OnlyPurchases</FILTER>
</COLLECTION>
<SYSTEM TYPE="Formulae" NAME="OnlyPurchases">$VoucherTypeName = "Purchase"</SYSTEM>`);
  return paginate(parseVouchers(xml), page, limit);
}

async function tallyCustomers() {
  const xml = await tallyCollection('RemoteCustomerLedgers', `
<COLLECTION NAME="RemoteCustomerLedgers" ISMODIFY="No">
  <TYPE>Ledger</TYPE>
  <FETCH>Name,Parent,ClosingBalance,LedgerContact,LedgerMobile,PhoneNumber,Email</FETCH>
  <FILTER>OnlyDebtors</FILTER>
</COLLECTION>
<SYSTEM TYPE="Formulae" NAME="OnlyDebtors">$Parent = "Sundry Debtors"</SYSTEM>`);
  return parseLedgers(xml);
}

function parseVouchers(xml) {
  return blocks(xml, 'VOUCHER').map(v => {
    const amount = Math.abs(parseTallyAmount(getTag(v, 'AMOUNT')));
    return {
      name: attr(v, 'NAME') || stripXml(getTag(v, 'VOUCHERNUMBER')) || '—',
      date: formatTallyDate(stripXml(getTag(v, 'DATE'))),
      agent: stripXml(getTag(v, 'PARTYLEDGERNAME')) || '—',
      sum: amount,
      paid: amount,
      outstanding: 0,
      state: stripXml(getTag(v, 'VOUCHERTYPENAME')) || '—',
      status: 'Paid'
    };
  }).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

function parseLedgers(xml) {
  return blocks(xml, 'LEDGER').map(l => {
    const closing = parseTallyAmount(getTag(l, 'CLOSINGBALANCE'));
    return {
      name: attr(l, 'NAME') || stripXml(getTag(l, 'NAME')) || '—',
      phone: stripXml(getTag(l, 'LEDGERMOBILE')) || stripXml(getTag(l, 'PHONENUMBER')) || stripXml(getTag(l, 'LEDGERCONTACT')) || '—',
      email: stripXml(getTag(l, 'EMAIL')) || '—',
      type: stripXml(getTag(l, 'PARENT')) || 'Sundry Debtors',
      city: '—',
      sales: 'â€”',
      val: 0,
      profit: 0,
      outstanding: Math.max(closing, 0)
    };
  }).sort((a, b) => b.outstanding - a.outstanding);
}

function paginate(rows, page, limit) {
  const total = rows.length;
  const start = (page - 1) * limit;
  return { rows: rows.slice(start, start + limit), total };
}

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
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function escapeXml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function parseTallyAmount(s) {
  const text = stripXml(s).replace(/,/g, '');
  const n = parseFloat(text.replace(/[^0-9.-]/g, '')) || 0;
  if (/\bCr\b/i.test(text)) return -Math.abs(n);
  return Math.abs(n);
}

function formatTallyDate(s) {
  const text = String(s || '').trim();
  if (/^\d{8}$/.test(text)) return `${text.slice(0,4)}-${text.slice(4,6)}-${text.slice(6,8)}`;
  return text ? text.slice(0, 10) : '—';
}

function tallyDate(s) {
  const d = String(s || '').slice(0, 10).replace(/-/g, '');
  return /^\d{8}$/.test(d) ? d : todayStr().replace(/-/g, '');
}

// ── In-memory TTL cache ───────────────────────────────────
const _cache = new Map();
const _inflight = new Map();
function cached(key, ttlMs, fn) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return Promise.resolve(hit.v);
  if (_inflight.has(key)) return _inflight.get(key);
  const p = fn()
    .then(v => { _cache.set(key, { v, t: Date.now() }); _inflight.delete(key); return v; })
    .catch(e => { _inflight.delete(key); throw e; });
  _inflight.set(key, p);
  return p;
}

// ── Common data (employee, date, global stock alerts) ────
async function common() {
  const { empName, empLetter, empRole, stockAlerts, stockAlertCount } =
    await cached('common', 3 * 60 * 1000, async () => {
      let empName = 'Admin', empLetter = 'A', empRole = 'Moysklad';
      let stockAlerts = [], stockAlertCount = 0;

      const [empRes, stkRes] = await Promise.allSettled([
        ms('/context/employee'),
        ms('/report/stock/all?limit=1000')
      ]);

      if (empRes.status === 'fulfilled') {
        const emp = empRes.value;
        empName   = emp.name || 'Admin';
        empLetter = empName[0].toUpperCase();
        empRole   = emp.position || 'Moysklad';
      }

      if (stkRes.status === 'fulfilled') {
        const below = (stkRes.value.rows || [])
          .filter(r => (r.quantity || 0) < 100)
          .sort((a, b) => (a.quantity || 0) - (b.quantity || 0));
        stockAlertCount = below.length;
        stockAlerts = below.slice(0, 60).map(r => ({ name: r.name || '—', qty: r.quantity || 0 }));
      }

      return { empName, empLetter, empRole, stockAlerts, stockAlertCount };
    });

  return {
    empName, empLetter, empRole,
    date: new Date().toLocaleDateString('en-IN', { day:'2-digit', month:'long', year:'numeric' }),
    time: new Date().toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' }),
    stockAlerts, stockAlertCount
  };
}

// ── Shared cached data helpers ───────────────────────────
// These are called from multiple routes — caching avoids duplicate API calls.
const getStock = () =>
  cached('stock_all', 3*60*1000, () => ms('/report/stock/all?limit=1000').then(r => r.rows || []));

const getRecentDemands = () =>
  cached('demands_200', 90*1000, () => ms('/entity/demand?limit=200&order=moment,desc').then(r => r.rows || []));

const getAllOrders = () =>
  cached('orders_all_v3', 2*60*1000, () => ms('/entity/customerorder?limit=1000&order=moment,desc&expand=state').then(r => r.rows || []));

const getOrdersFromDec25 = () =>
  cached('orders_dec25', 5*60*1000, () =>
    msAll(`/entity/customerorder?filter=${enc('moment>=2025-12-01 00:00:00')}&order=moment,asc`)
      .then(r => r.rows || []));

const getDemandsFromDec25 = () =>
  cached('demands_dec25', 5*60*1000, () =>
    msAll(`/entity/demand?filter=${enc('moment>=2025-12-01 00:00:00')}&order=moment,asc`)
      .then(r => r.rows || []));

const getProfitByProduct = (from, to) => {
  const key = `prof_prod_${from}_${to||''}`;
  const url  = to
    ? `/report/profit/byproduct?momentFrom=${enc(from)}&momentTo=${enc(to)}&limit=10`
    : `/report/profit/byproduct?momentFrom=${enc(from)}&limit=10`;
  return cached(key, 5*60*1000, () => ms(url).then(r => r.rows || []));
};

const getProfitByCounterparty = (from, to) => {
  const key = `prof_cust_${from}_${to||''}`;
  const url  = to
    ? `/report/profit/bycounterparty?momentFrom=${enc(from)}&momentTo=${enc(to)}&limit=10`
    : `/report/profit/bycounterparty?momentFrom=${enc(from)}&limit=10`;
  return cached(key, 5*60*1000, () => ms(url).then(r => r.rows || []));
};

// Fetch total PCS (units) for a list of pending order IDs — batch of 20 parallel calls
// Cache key uses count + first ID as a lightweight signature (busts when orders change)
async function getPendingPCS(orderIds) {
  if (!orderIds.length) return 0;
  const cacheKey = `pending_pcs_${orderIds.length}_${orderIds[0] || ''}`;
  return cached(cacheKey, 3 * 60 * 1000, async () => {
    const BATCH = 20;
    let total = 0;
    for (let i = 0; i < orderIds.length; i += BATCH) {
      const results = await Promise.allSettled(
        orderIds.slice(i, i + BATCH).map(id => ms(`/entity/customerorder/${id}/positions?limit=200`))
      );
      results.forEach(r => {
        if (r.status === 'fulfilled')
          (r.value.rows || []).forEach(pos => { total += Math.round(pos.quantity || 0); });
      });
    }
    return total;
  });
}

// Fetch total PCS (units) for today's shipped demands — all in parallel (small number)
// TTL matches getRecentDemands (90s) since both are based on today's data
async function getTodayPCS(demandIds) {
  if (!demandIds.length) return 0;
  const cacheKey = `today_pcs_${todayStr()}_${demandIds.length}`;
  return cached(cacheKey, 90 * 1000, async () => {
    const results = await Promise.allSettled(
      demandIds.map(id => ms(`/entity/demand/${id}/positions?limit=200`))
    );
    let total = 0;
    results.forEach(r => {
      if (r.status === 'fulfilled')
        (r.value.rows || []).forEach(pos => { total += Math.round(pos.quantity || 0); });
    });
    return total;
  });
}

// ── Helpers ──────────────────────────────────────────────
const todayStr   = () => localDateStr(new Date());
const localDateStr = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const monthStart  = () => { const n=new Date(); return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-01 00:00:00`; };
const enc         = s => encodeURIComponent(s);
const stateName   = r => (r.state?.name || '—');
const agentName   = r => (r.agent?.name || r.counterparty?.name || '—');

// Fetch customerorder state metadata → map of { id → name }
async function getOrderStateMap() {
  // cache key bumped to v2 to bust any previously cached empty map
  return cached('stateMap_v2', 15 * 60 * 1000, async () => {
    try {
      const meta = await ms('/entity/customerorder/metadata');
      const map = {};
      // MoySklad returns states as a collection {rows:[]} not a plain array
      const statesArr = Array.isArray(meta.states) ? meta.states : (meta.states?.rows || []);
      statesArr.forEach(s => { if (s.id && s.name) map[s.id] = s.name; });
      return map;
    } catch(_) { return {}; }
  });
}

// Resolve state name: prefer expanded .name, fall back to stateMap by ID from href
function resolveState(r, stateMap) {
  if (!r.state) return '';
  if (r.state.name) return r.state.name;
  const id = (r.state.meta?.href || '').split('/').pop().split('?')[0];
  return stateMap[id] || '';
}


// ════════════════════════════════════════════════════════
//  ROUTES
// ════════════════════════════════════════════════════════

// ── Order-Shipment Value Mismatch API ────────────────────
// Returns orders where total shipped value ≠ order value.
// Happens when a sales order is edited after its shipment is created.
app.get('/api/order-shipment-mismatch', async (req, res) => {
  try {
    const filterStr = `moment>=2025-12-01 00:00:00`;
    const [orders, demands] = await Promise.all([
      cached('mismatch_orders', 5*60*1000, () =>
        msAll(`/entity/customerorder?filter=${enc(filterStr)}&expand=agent&order=moment,desc`).then(r => r.rows || [])),
      cached('mismatch_demands', 5*60*1000, () =>
        msAll(`/entity/demand?filter=${enc(filterStr)}&order=moment,desc`).then(r => r.rows || []))
    ]);

    // Sum all shipments per order
    const shippedSum  = {};   // orderId → total shipped (kopecks)
    const shippedList = {};   // orderId → [{name, sum, date}]
    demands.forEach(d => {
      const href = d.customerOrder?.meta?.href || '';
      if (!href) return;
      const oid = href.split('/').pop().split('?')[0];
      shippedSum[oid]  = (shippedSum[oid] || 0) + (d.sum || 0);
      if (!shippedList[oid]) shippedList[oid] = [];
      shippedList[oid].push({ name: d.name, sum: Math.round((d.sum || 0) / 100), date: (d.moment || '').slice(0, 10) });
    });

    const mismatches = [];
    orders.forEach(o => {
      if (!shippedSum[o.id]) return;                        // no shipment yet — skip
      const diff = (o.sum || 0) - shippedSum[o.id];
      if (Math.abs(diff) < 100) return;                     // within ₹1 — ignore rounding
      mismatches.push({
        id:          o.id,
        name:        o.name,
        customer:    o.agent?.name || '—',
        date:        (o.moment || '').slice(0, 10),
        orderSum:    Math.round((o.sum || 0) / 100),
        shippedSum:  Math.round(shippedSum[o.id] / 100),
        difference:  Math.round(diff / 100),
        shipments:   shippedList[o.id] || []
      });
    });

    mismatches.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));
    res.json({ ok: true, count: mismatches.length, mismatches });
  } catch(e) {
    console.error('/api/order-shipment-mismatch:', e.message);
    res.json({ ok: false, error: e.message, count: 0, mismatches: [] });
  }
});

// ── DASHBOARD ────────────────────────────────────────────
app.get('/', async (req, res) => {
  try {
    const c = await common();
    const from = monthStart();

    const [shipments, orders, stock, products, customers, stateMap] = await Promise.all([
      getRecentDemands(),
      getAllOrders(),
      getStock(),
      getProfitByProduct(from),
      getProfitByCounterparty(from),
      getOrderStateMap(),
    ]).then(r => [
      r[0],
      r[1],
      r[2],
      (r[3] || []).sort((a,b)=>(b.sellSum||0)-(a.sellSum||0)),
      (r[4] || []).sort((a,b)=>(b.sellSum||0)-(a.sellSum||0)),
      r[5],
    ]);

    // Today's shipments (Sales Today)
    const today = todayStr();
    const todayShipments = shipments.filter(r => (r.moment||'').startsWith(today));
    const salesToday     = todayShipments.reduce((a, r) => a + (r.sum||0), 0);
    const shipmentsToday = todayShipments.length;
    const todayPCS       = await getTodayPCS(todayShipments.map(d => d.id));

    // Pending = has a named state AND is NOT dispatched / declined / cancelled / draft.
    // Draft orders (no state, or state named "Draft"/"Черновик") are excluded entirely.
    const pendingOrders = orders.filter(r => {
      if (!r.state) return false;                                      // no state = draft
      const s = resolveState(r, stateMap).toLowerCase();
      if (!s) return false;                                            // unresolved state = draft
      if (/^draft$|черновик/.test(s)) return false;                   // state named "Draft"
      return !/dispatched|отгруж|declin|cancel|отмен|отклон|аннул/.test(s);
    });
    const pending = pendingOrders.length;

    // Count by actual state name for card sub-label
    const stateCountMap = {};
    pendingOrders.forEach(r => {
      const s = resolveState(r, stateMap);
      if (s) stateCountMap[s] = (stateCountMap[s] || 0) + 1;
    });
    const pendingStates = Object.entries(stateCountMap)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }));
    const pendingValue = pendingOrders.reduce((a, r) => a + (r.sum || 0), 0) / 100;
    // Total pieces across all pending orders (fetched in batches, cached)
    const pendingPCS   = await getPendingPCS(pendingOrders.map(o => o.id));

    // Stock stats
    let lowStock=0, inStock=0, outStock=0, totalQty=0, totalVal=0;
    const folders = new Set();
    stock.forEach(r => {
      const q=r.quantity||0; totalQty+=q; totalVal+=q*(r.price||0);
      if (r.folder?.name) folders.add(r.folder.name);
      if (q<=0) outStock++; else if (q<100) { lowStock++; inStock++; } else inStock++;
    });

    const totalSell     = products.reduce((a,r)=>a+(r.sellSum||0),0);
    const weeklyOrders  = buildDailyCounts(shipments, 15);
    const allDemands    = await getDemandsFromDec25();
    const monthlyOrders = buildMonthlyCounts(allDemands);

    // Pro-rata growth: compare current month (day 1 → today) vs SAME day range last month
    // so an incomplete month never shows fake negative growth vs a full previous month
    const nowD         = new Date();
    const dayOfMonth   = nowD.getDate();
    const prevD        = new Date(nowD.getFullYear(), nowD.getMonth() - 1, 1);
    const prevMonthKey = `${prevD.getFullYear()}-${String(prevD.getMonth()+1).padStart(2,'0')}`;
    const prevMonthProRata = allDemands
      .filter(d => {
        const date = (d.moment || '').slice(0, 10);
        return date.startsWith(prevMonthKey) && parseInt(date.slice(8, 10), 10) <= dayOfMonth;
      })
      .reduce((a, d) => a + Math.round((d.sum || 0) / 100), 0);

    res.render('dashboard', {
      ...c, active: 'dashboard',
      salesToday: salesToday/100, shipmentsToday, todayPCS,
      pending, pendingStates, pendingValue, pendingPCS,
      totalOrders: orders.length,
      products: products.slice(0,10).map(r=>({
        name: r.assortment?.name||'—',
        id:   (r.assortment?.meta?.href||'').split('/').pop(),
        type: r.assortment?.meta?.type||'product',
        qty: Math.round(r.sellQuantity||0),
        val: r.sellSum/100
      })),
      customers: customers.slice(0,10).map(r=>({
        name: r.counterparty?.name||'—',
        id:   (r.counterparty?.meta?.href||'').split('/').pop(),
        orders: r.salesCount||0,
        val: r.sellSum/100
      })),
      totalSell: totalSell/100, productCount: products.length,
      lowStock, inStock, outStock,
      totalSKU: stock.length, totalVal: totalVal/100,
      totalQty, categories: folders.size,
      weeklyData:        JSON.stringify(weeklyOrders),
      monthlyData:       JSON.stringify(monthlyOrders),
      dayOfMonth,
      prevMonthProRata
    });
  } catch (e) { res.status(500).render('error', { message: e.message }); }
});

// ── ORDERS STATUS ────────────────────────────────────────
app.get('/orders-status', async (req, res) => {
  try {
    const c      = await common();
    const now    = new Date();
    const sixAgo = new Date(now); sixAgo.setMonth(sixAgo.getMonth() - 6);
    const df     = `moment>=${localDateStr(sixAgo)} 00:00:00`;

    // Fetch orders, demands, state map — orders/demands cached 2 min per date filter
    const ordKey = `orders_6mo_${localDateStr(sixAgo)}`;
    const demKey = `demands_6mo_${localDateStr(sixAgo)}`;
    const [rawOrders, demands, stateMap] = await Promise.all([
      cached(ordKey, 2*60*1000, () => msAll(`/entity/customerorder?filter=${enc(df)}&order=moment,desc&expand=agent,store`).then(r => r.rows || [])),
      cached(demKey, 2*60*1000, () => msAll(`/entity/demand?filter=${enc(df)}&order=moment,desc`).then(r => r.rows || [])),
      getOrderStateMap(),
    ]);

    // Collect unique owner hrefs from all orders, then fetch each employee directly.
    // This is more reliable than expand=owner or /entity/employee (both have permission issues).
    const ownerHrefs = [...new Set(
      rawOrders.map(r => r.owner?.meta?.href).filter(Boolean)
    )];
    const ownerFetches = await Promise.allSettled(
      ownerHrefs.map(href => ms(href.replace(MS_BASE, '')))
    );
    const ownerMap = {}; // full href → employee display name
    ownerFetches.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        const e = result.value;
        ownerMap[ownerHrefs[i]] = e.name || e.shortFio || e.uid || '—';
      }
    });

    // demand map: orderId → { name, moment }
    const demandMap = {};
    demands.forEach(d => {
      const href = d.customerOrder?.meta?.href || '';
      if (!href) return;
      const oid = href.split('/').pop().split('?')[0];
      if (!demandMap[oid]) demandMap[oid] = { name: d.name || '—', moment: (d.moment || '').slice(0, 10) };
    });

    const orders = rawOrders.map(r => {
      const state       = resolveState(r, stateMap) || '';
      const stateL      = state.toLowerCase();
      const createdDate = (r.moment || '').slice(0, 10);
      const expDate     = r.deliveryPlannedMoment ? r.deliveryPlannedMoment.slice(0, 10) : null;
      const demand      = demandMap[r.id] || null;
      const dispatched  = demand !== null;
      const daysSince   = Math.floor((now - new Date(createdDate || now)) / 86400000);

      // Resolve salesman: look up the owner's full href in ownerMap (fetched individually)
      const ownerHref = r.owner?.meta?.href || '';
      const salesman  = ownerMap[ownerHref] || '—';

      let delayDays = 0;
      if (expDate && !dispatched) {
        const diff = Math.floor((now - new Date(expDate)) / 86400000);
        if (diff > 0) delayDays = diff;
      }
      let dispatchTime = null;
      if (demand?.moment && createdDate) {
        const diff = Math.round((new Date(demand.moment) - new Date(createdDate)) / 3600000 * 10) / 10;
        if (diff >= 0) dispatchTime = diff;
      }

      return {
        id: r.id, name: r.name || '—',
        customer: r.agent?.name || '—',
        salesman,
        state: state || (r.state ? '—' : 'Draft'), stateL,
        hasState: !!r.state,
        dispatched, daysSince,
        sum: (r.sum || 0) / 100,
        createdDate, expDate,
        delayDays, dispatchTime,
        store: r.store?.name || '—',
        demandName: demand?.name || null
      };
    });

    // Summary counts
    const total      = orders.length;
    const newCount   = orders.filter(o => /new|нов/i.test(o.stateL)).length;
    const accCount   = orders.filter(o => /accept|принят|подтверж/i.test(o.stateL)).length;
    const readyCount = orders.filter(o => /ready|готов/i.test(o.stateL)).length;
    const dispCount  = orders.filter(o => o.dispatched || /dispatch|отгруз/i.test(o.stateL)).length;
    const draftCount = orders.filter(o => !o.hasState || /^draft$|черновик/i.test(o.stateL)).length;
    const delayCount = orders.filter(o => o.delayDays > 0).length;
    const withTime   = orders.filter(o => o.dispatchTime !== null);
    const avgDispatch = withTime.length > 0
      ? (withTime.reduce((a, o) => a + o.dispatchTime, 0) / withTime.length).toFixed(1) : '—';

    // Salesman performance — all stats derived from resolved owner names
    const smMap = {};
    orders.forEach(o => {
      const nm = o.salesman;
      if (!smMap[nm]) smMap[nm] = { name: nm, total: 0, value: 0, dispatched: 0, pending: 0, times: [] };
      const sm = smMap[nm];
      sm.total++; sm.value += o.sum;
      if (o.dispatched) { sm.dispatched++; if (o.dispatchTime !== null) sm.times.push(o.dispatchTime); }
      else sm.pending++;
    });
    const salesmen = Object.values(smMap).map(sm => ({
      name: sm.name, total: sm.total, value: sm.value,
      dispatched: sm.dispatched, pending: sm.pending,
      avgDispatch: sm.times.length > 0 ? (sm.times.reduce((a,v)=>a+v,0)/sm.times.length).toFixed(1) : '—',
      completion:  sm.total > 0 ? Math.round((sm.dispatched / sm.total) * 100) : 0
    })).sort((a, b) => b.total - a.total);

    res.render('orders-status', {
      ...c, active: 'orders-status',
      total, newCount, accCount, readyCount, dispCount, draftCount, delayCount, avgDispatch,
      salesmen,
      ordersJSON: JSON.stringify(orders)
    });
  } catch(e) { res.status(500).render('error', { message: e.message }); }
});

// ── INVENTORY ────────────────────────────────────────────
app.get('/inventory', async (req, res) => {
  try {
    const c    = await common();
    const rows = await getStock();

    let low = 0, outStk = 0, totalVal = 0, totalQty = 0;
    rows.forEach(r => {
      const q = r.quantity || 0;
      totalQty += q; totalVal += q * (r.price || 0);
      if (q <= 0) outStk++; else if (q <= 100) low++;
    });

    // Group variants by base model name (strip trailing "(Flavor)" suffix)
    const modelMap = {};
    rows.forEach(r => {
      const fullName  = r.name || '—';
      const baseName  = fullName.replace(/\s*\([^)]*\)\s*$/, '').trim() || fullName;
      const flavorM   = fullName.match(/\(([^)]+)\)\s*$/);
      const flavor    = flavorM ? flavorM[1] : null;
      const qty       = r.quantity || 0;
      const status    = qty <= 0 ? 'Out of Stock' : qty <= 100 ? 'Low Stock' : 'In Stock';

      if (!modelMap[baseName]) modelMap[baseName] = { name: baseName, totalQty: 0, variants: [] };
      modelMap[baseName].totalQty += qty;
      modelMap[baseName].variants.push({ name: flavor || fullName, qty, status });
    });

    const models = Object.values(modelMap).map(m => {
      const hasOut = m.variants.some(v => v.status === 'Out of Stock');
      const hasLow = m.variants.some(v => v.status === 'Low Stock');
      return {
        name:         m.name,
        totalQty:     m.totalQty,
        variantCount: m.variants.length,
        status:       hasOut ? 'Out of Stock' : hasLow ? 'Low Stock' : 'In Stock',
        variants:     m.variants.sort((a, b) => a.name.localeCompare(b.name))
      };
    }).sort((a, b) => a.name.localeCompare(b.name));

    // Detail lists for modal buttons on stat cards
    const outItems = rows
      .filter(r => (r.quantity || 0) <= 0)
      .map(r => ({ name: r.name || '—', qty: 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const lowItems = rows
      .filter(r => (r.quantity || 0) > 0 && (r.quantity || 0) <= 100)
      .map(r => ({ name: r.name || '—', qty: r.quantity }))
      .sort((a, b) => a.qty - b.qty);

    res.render('inventory', {
      ...c, active: 'inventory',
      models, totalSKU: rows.length, low, outStk,
      totalVal: totalVal / 100, totalQty,
      outJSON: JSON.stringify(outItems),
      lowJSON: JSON.stringify(lowItems)
    });
  } catch(e) { res.status(500).render('error', { message: e.message }); }
});

// ── PURCHASES ────────────────────────────────────────────
app.get('/purchases', (req, res) => res.redirect('/'));


// ── SALESMAN PERFORMANCE ─────────────────────────────────
app.get('/salesman', async (req, res) => {
  try {
    const c = await common();
    const period = req.query.period || 'current';

    // Build last 12 months for filter
    const months = [];
    for (let i = 0; i < 12; i++) {
      const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
      const key   = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      const label = d.toLocaleString('en', { month: 'long', year: 'numeric' });
      months.push({ key, label });
    }

    // Date range
    let momentFrom = null, momentTo = null;
    if (period === 'current') {
      momentFrom = monthStart();
    } else if (/^\d{4}-\d{2}$/.test(period)) {
      const [yr, mo] = period.split('-').map(Number);
      momentFrom = `${yr}-${String(mo).padStart(2,'0')}-01 00:00:00`;
      const nd = new Date(yr, mo, 1);
      momentTo = `${nd.getFullYear()}-${String(nd.getMonth()+1).padStart(2,'0')}-01 00:00:00`;
    }

    const filterParts = [];
    if (momentFrom) filterParts.push(`moment>${momentFrom}`);
    if (momentTo)   filterParts.push(`moment<${momentTo}`);
    const filterStr = filterParts.join(';');

    // Get ALL employees in one call (cached 15 min) — keyed by UUID.
    const empMap = await cached('employees_map', 15*60*1000, async () => {
      const r = await ms('/entity/employee?limit=1000');
      const map = {};
      (r.rows || []).forEach(e => {
        const uuid = (e.meta?.href || '').split('/').pop().split('?')[0];
        if (uuid) map[uuid] = e.name || e.shortFio || e.uid || '—';
      });
      return map;
    });

    // ── KEY LOGIC: aggregate by SHIPMENT (demand) date, not order date ─────────
    // This means an April order shipped in May counts in May's salesman report.
    // An order placed this month but not yet shipped is NOT counted (shown in unshipped modal).

    // 1. Fetch all shipments (demands) whose shipment date falls in the selected period
    const demUrl = `/entity/demand?${filterStr ? 'filter='+enc(filterStr)+'&' : ''}expand=agent&order=moment,desc`;
    const { rows: demands } = await msAll(demUrl);

    // 2. Fetch orders placed in the period — used ONLY for the unshipped modal
    const ordUrl = `/entity/customerorder?${filterStr ? 'filter='+enc(filterStr)+'&' : ''}expand=agent&order=moment,desc`;
    const { rows: ordersInPeriod } = await msAll(ordUrl);

    // 3. Build set of customerOrder IDs that have at least one shipment in this period
    const shippedOrderIds = new Set();
    demands.forEach(d => {
      const href = d.customerOrder?.meta?.href || '';
      if (href) shippedOrderIds.add(href.split('/').pop().split('?')[0]);
    });

    // 4. Batch-fetch the parent customer orders for each demand so we can read
    //    their `owner` (salesman). These orders may be from any previous period.
    const parentOrderIds = [...new Set(demands.map(d => {
      const href = d.customerOrder?.meta?.href || '';
      return href ? href.split('/').pop().split('?')[0] : null;
    }).filter(Boolean))];

    const POBATCH = 30;
    const parentOrderMap = {}; // orderId → order object
    for (let i = 0; i < parentOrderIds.length; i += POBATCH) {
      const results = await Promise.allSettled(
        parentOrderIds.slice(i, i + POBATCH).map(id => ms(`/entity/customerorder/${id}`))
      );
      results.forEach((r, j) => {
        if (r.status === 'fulfilled') parentOrderMap[parentOrderIds[i + j]] = r.value;
      });
    }

    // 5. Aggregate demands by salesman (owner of parent order)
    //    Revenue = demand.sum (the actual shipment value, not the original order value)
    //
    //    Owner resolution priority:
    //      1. Parent customer order's owner  (standard case — order placed then shipped)
    //      2. Demand's own owner field       (fallback for standalone demands with no parent order,
    //                                         or when the parent order fetch failed)
    const smMap = {};
    demands.forEach(demand => {
      const ordHref  = demand.customerOrder?.meta?.href || '';
      const ordId    = ordHref ? ordHref.split('/').pop().split('?')[0] : null;
      const order    = ordId ? parentOrderMap[ordId] : null;

      // Try parent order owner first; fall back to the demand's own owner so standalone
      // demands (not linked to any customer order) are never incorrectly "Unassigned".
      const orderOwnerUUID  = (order?.owner?.meta?.href  || '').split('/').pop().split('?')[0];
      const demandOwnerUUID = (demand.owner?.meta?.href  || '').split('/').pop().split('?')[0];
      const ownerUUID = orderOwnerUUID || demandOwnerUUID;
      const name      = ownerUUID ? (empMap[ownerUUID] || 'Unassigned') : 'Unassigned';

      const val       = (demand.sum || 0) / 100;
      const date      = (demand.moment || '').slice(0, 10);
      const customer  = demand.agent?.name || order?.agent?.name || '—';
      const orderName = order?.name || '—';

      if (!smMap[name]) smMap[name] = { name, orders: 0, totalVal: 0, orderList: [] };
      smMap[name].orders++;
      smMap[name].totalVal += val;
      smMap[name].orderList.push({ name: demand.name || '—', orderName, date, customer, val, state: '—' });
    });

    const salesmen = Object.values(smMap)
      .map(s => ({
        name:      s.name,
        orders:    s.orders,
        shipments: s.orders,
        totalVal:  s.totalVal,
        avgVal:    s.orders > 0 ? s.totalVal / s.orders : 0,
        orderList: s.orderList.sort((a, b) => new Date(b.date) - new Date(a.date))
      }))
      .sort((a, b) => b.totalVal - a.totalVal);

    // 6. Unshipped modal: orders placed in this period with no shipment created yet
    const unshippedRaw = ordersInPeriod.filter(o => !shippedOrderIds.has(o.id));
    const UBATCH = 20;
    const unshippedOrders = [];
    for (let i = 0; i < unshippedRaw.length; i += UBATCH) {
      const slice = unshippedRaw.slice(i, i + UBATCH);
      const posResults = await Promise.allSettled(
        slice.map(o => ms(`/entity/customerorder/${o.id}/positions?limit=200`))
      );
      slice.forEach((o, j) => {
        const ownerUUID = (o.owner?.meta?.href || '').split('/').pop().split('?')[0];
        const salesman  = ownerUUID ? (empMap[ownerUUID] || 'Unassigned') : 'Unassigned';
        const posRows   = posResults[j]?.status === 'fulfilled' ? (posResults[j].value.rows || []) : [];
        const pcs       = Math.round(posRows.reduce((a, p) => a + (p.quantity || 0), 0));
        unshippedOrders.push({
          name:     o.name || '—',
          date:     (o.moment || '').slice(0, 10),
          customer: o.agent?.name || '—',
          salesman,
          state:    o.state?.name || '—',
          val:      (o.sum || 0) / 100,
          pcs
        });
      });
    }
    unshippedOrders.sort((a, b) => b.val - a.val);

    const chartTop = salesmen.slice(0, 10);
    res.render('salesman', {
      ...c, active: 'salesman',
      salesmen, period, months,
      totalOrders: demands.length,
      chartLabels:    JSON.stringify(chartTop.map(s => s.name)),
      chartValueData:  JSON.stringify(chartTop.map(s => Math.round(s.totalVal))),
      chartOrderData:  JSON.stringify(chartTop.map(s => s.orders)),
      chartQtyData:    JSON.stringify(chartTop.map(s => s.orders)),
      salesmenJSON:    JSON.stringify(salesmen),
      unshippedJSON:   JSON.stringify(unshippedOrders),
      unshippedCount:  unshippedOrders.length
    });
  } catch(e) { res.status(500).render('error', { message: e.message }); }
});

// ── CUSTOMERS ────────────────────────────────────────────
app.get('/customers', async (req, res) => {
  try {
    const c = await common();
    const period = req.query.period || 'current';

    // Build last 12 months list for filter
    const months = [];
    for (let i = 0; i < 12; i++) {
      const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
      const key   = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      const label = d.toLocaleString('en', { month: 'long', year: 'numeric' });
      months.push({ key, label });
    }

    // Determine momentFrom / momentTo
    let momentFrom = null, momentTo = null;
    if (period === 'current') {
      momentFrom = monthStart();
    } else if (/^\d{4}-\d{2}$/.test(period)) {
      const [yr, mo] = period.split('-').map(Number);
      momentFrom = `${yr}-${String(mo).padStart(2,'0')}-01 00:00:00`;
      const nd = new Date(yr, mo, 1);
      momentTo = `${nd.getFullYear()}-${String(nd.getMonth()+1).padStart(2,'0')}-01 00:00:00`;
    }

    // ── Revenue: reuse the exact same demand cache as the dashboard monthly chart
    // so customers "Total Revenue" always matches dashboard (guaranteed, same data source).
    // ── Qty: pulled from MongoDB ms_demands which has embedded positions from the last sync.
    const [allDemandsFull, totalCustomers] = await Promise.all([
      getDemandsFromDec25(),
      cached('counterparty_count', 10*60*1000, () => ms('/entity/counterparty?limit=1').then(r => r.meta?.size || 0)),
    ]);

    // Filter to selected period by moment string comparison (same format: "YYYY-MM-DD HH:MM:SS")
    const filteredDemands = allDemandsFull.filter(d => {
      const mom = d.moment || '';
      if (momentFrom && mom < momentFrom) return false;
      if (momentTo   && mom >= momentTo)  return false;
      return true;
    });

    // Counterparty name map: UUID → name (cached 15 min — avoids per-demand expand)
    const cpNameMap = await cached('cp_name_map_v1', 15*60*1000, async () => {
      const { rows = [] } = await msAll('/entity/counterparty?limit=1000');
      return Object.fromEntries(rows.map(r => [r.id, r.name || '']));
    });

    // Aggregate revenue per customer (ALL demands, including those without an agent)
    const custMap = {};
    filteredDemands.forEach(demand => {
      const agentId = (demand.agent?.meta?.href || '').split('/').pop().split('?')[0] || '';
      const name    = agentId ? (cpNameMap[agentId] || '—') : '—';
      const key     = agentId || '__no_agent__';
      if (!custMap[key]) custMap[key] = { id: agentId, name, orders: 0, totalQty: 0, totalVal: 0 };
      custMap[key].orders++;
      custMap[key].totalVal += (demand.sum || 0) / 100;
    });

    // Note: qty per customer is not available from the profit/bycounterparty endpoint.
    // MoySklad sync to MongoDB is disabled, so qty always stays 0 (not shown in UI).

    const customers = Object.values(custMap)
      .filter(x => x.id && x.name !== '—')   // exclude no-agent demands from list
      .map(x => ({
        ...x,
        avgQty: x.orders > 0 ? +(x.totalQty / x.orders).toFixed(1) : 0,
        avgVal: x.orders > 0 ? x.totalVal / x.orders : 0
      }))
      .sort((a, b) => b.totalVal - a.totalVal);

    const chartTop = customers.slice(0, 12);
    res.render('customers', {
      ...c, active: 'customers',
      customers,
      total: totalCustomers,
      period,
      months,
      chartLabels:    JSON.stringify(chartTop.map(x => x.name)),
      chartValueData: JSON.stringify(chartTop.map(x => Math.round(x.totalVal))),
      chartOrderData: JSON.stringify(chartTop.map(x => x.orders))
    });
  } catch(e) { res.status(500).render('error',{message:e.message}); }
});

// ── SKU ANALYSIS ─────────────────────────────────────────
// Data source: /report/profit/byproduct — same endpoint the dashboard uses.
app.get('/sku-analysis', async (req, res) => {
  try {
    const c   = await common();
    const now = new Date();

    // Default period = current calendar month key (e.g. "2026-05")
    const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
    const period = (/^\d{4}-\d{2}$/.test(req.query.period)) ? req.query.period : currentMonthKey;

    // Build last 12 months list (no "This Month" — always use explicit keys)
    const months = [];
    for (let i = 0; i < 12; i++) {
      const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
      const key   = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      const label = d.toLocaleString('en', { month: 'long', year: 'numeric' });
      months.push({ key, label });
    }

    // Date range — always explicit month boundaries
    const [yr, mo] = period.split('-').map(Number);
    const momentFrom = `${yr}-${String(mo).padStart(2,'0')}-01 00:00:00`;
    const nd         = new Date(yr, mo, 1);
    const momentTo   = `${nd.getFullYear()}-${String(nd.getMonth()+1).padStart(2,'0')}-01 00:00:00`;
    const filterStr  = `moment>${momentFrom};moment<${momentTo}`;

    // ── Hybrid: profit report totals + demand positions for flavour breakdown ──
    // The profit report gives correct model-level totals (same as dashboard).
    // Demand positions give flavour/variant names.
    // We normalise flavour quantities so each model sums to the profit report total.
    const dataKey = `sku_data_${period}`;
    const { demands, skuPCS } = await cached(dataKey, 5*60*1000, async () => {
      const lastDayDate = new Date(yr, mo, 0);
      const profitTo    = `${lastDayDate.getFullYear()}-${String(lastDayDate.getMonth()+1).padStart(2,'0')}-${String(lastDayDate.getDate()).padStart(2,'0')} 23:59:59`;

      const [demandResult, profitResult, nameMap] = await Promise.all([
        msAll(`/entity/demand?filter=${enc(filterStr)}&order=moment,desc`),
        msAll(`/report/profit/byproduct?momentFrom=${enc(momentFrom)}&momentTo=${enc(profitTo)}`),
        getNameMap()
      ]);
      const demands = demandResult.rows || [];

      // Correct model totals from profit report
      const profitTotals = {};
      (profitResult.rows || []).forEach(row => {
        const name = row.assortment?.name;
        const qty  = Math.round(row.sellQuantity || 0);
        if (name && qty > 0) profitTotals[name] = (profitTotals[name] || 0) + qty;
      });

      // Flavour-level counts from demand positions (no expand → no page-size cap)
      const rawSku = {};
      const BATCH  = 25;
      for (let i = 0; i < demands.length; i += BATCH) {
        const results = await Promise.allSettled(
          demands.slice(i, i + BATCH).map(d => fetchAllPos(d.id))
        );
        results.forEach(r => {
          if (r.status !== 'fulfilled') return;
          (r.value || []).forEach(pos => {
            const name = nameMap[pos.assortment?.meta?.href];
            if (!name) return;
            rawSku[name] = (rawSku[name] || 0) + Math.round(pos.quantity || 0);
          });
        });
      }

      // Group raw flavour counts by base model name
      const byModel = {};
      Object.entries(rawSku).forEach(([fullName, qty]) => {
        const base = fullName.replace(/\s*\([^)]*\)\s*$/, '').trim() || fullName;
        if (!byModel[base]) byModel[base] = { total: 0, skus: [] };
        byModel[base].total += qty;
        byModel[base].skus.push({ name: fullName, qty });
      });

      // Scale each model's flavours so they sum to the profit-report model total
      const map = {};
      Object.entries(byModel).forEach(([base, data]) => {
        const pTotal = profitTotals[base] || 0;
        const ratio  = (pTotal > 0 && data.total > 0) ? pTotal / data.total : 1;
        data.skus.forEach(s => { map[s.name] = Math.round(s.qty * ratio); });
      });

      // Models only in profit report (0 demand-position data) → show as single entry
      Object.entries(profitTotals).forEach(([name, total]) => {
        if (!byModel[name]) map[name] = total;
      });

      return { demands, skuPCS: map };
    });

    // ── Step 3: group by model (baseName) and flavour ─────────
    const modelMap = {};
    Object.entries(skuPCS).forEach(([fullName, pcs]) => {
      const flavorM  = fullName.match(/\(([^)]+)\)\s*$/);
      const baseName = fullName.replace(/\s*\([^)]*\)\s*$/, '').trim() || fullName;
      const sku      = flavorM ? flavorM[1] : '—';
      if (!modelMap[baseName]) modelMap[baseName] = { name: baseName, totalPCS: 0, skus: [] };
      modelMap[baseName].totalPCS += pcs;
      modelMap[baseName].skus.push({ fullName, sku, pcs });
    });

    // Sort models and SKUs by PCS descending
    const models = Object.values(modelMap).map(m => ({
      ...m,
      skus: m.skus.sort((a, b) => b.pcs - a.pcs)
    })).sort((a, b) => b.totalPCS - a.totalPCS);

    // ── Flat SKU list for top/low tables ─────────────────────
    const allSKUs = [];
    models.forEach(m => m.skus.forEach(s => allSKUs.push({ model: m.name, ...s })));
    allSKUs.sort((a, b) => b.pcs - a.pcs);

    const totalPCS  = allSKUs.reduce((a, s) => a + s.pcs, 0);
    const totalSKUs = allSKUs.length;

    // Top sellers = top 15 by PCS; Low sellers = bottom 15 by PCS (with > 0 PCS)
    const topSKUs = allSKUs.slice(0, 15);
    const lowSKUs = [...allSKUs].filter(s => s.pcs > 0).sort((a, b) => a.pcs - b.pcs).slice(0, 15);

    res.render('sku-analysis', {
      ...c, active: 'sku-analysis',
      models, period, months,
      totalPCS, totalSKUs,
      totalModels: models.length,
      shipmentCount: demands.length,
      topSKUs, lowSKUs,
      modelsJSON:  JSON.stringify(models),
      topJSON:     JSON.stringify(topSKUs),
      lowJSON:     JSON.stringify(lowSKUs)
    });
  } catch(e) { res.status(500).render('error', { message: e.message }); }
});

app.get('/suppliers', (req, res) => res.redirect('/customers'));
app.get('/reports',   (req, res) => res.redirect('/'));
app.get('/alerts',    (req, res) => res.redirect('/'));
app.get('/settings',  (req, res) => res.redirect('/'));

// ── ORDERS DAILY API (for "See More" on dashboard chart) ─
app.get('/api/orders/daily', async (req, res) => {
  try {
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    const days   = 8;
    const now    = new Date();
    const results = [];

    // Build date map from a filtered fetch
    const fromDate = new Date(now); fromDate.setDate(fromDate.getDate() - offset - days);
    const toDate   = new Date(now); toDate.setDate(toDate.getDate() - offset);
    const filterStr = `moment>=${localDateStr(fromDate)} 00:00:00;moment<=${localDateStr(toDate)} 23:59:59`;
    const data = await ms(`/entity/customerorder?limit=500&filter=${enc(filterStr)}&order=moment,desc`);
    const map  = {};
    (data.rows || []).forEach(r => {
      const d = (r.moment || '').slice(0, 10);
      if (d) map[d] = (map[d] || 0) + 1;
    });

    for (let i = 0; i < days; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - offset - i);
      const key = localDateStr(d);
      results.push({ date: key, count: map[key] || 0 });
    }
    res.json(results);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/orders/monthly', async (req, res) => {
  try {
    const before = req.query.before; // "YYYY-MM" — load 6 months ending before this month
    if (before) {
      const [yr, mo] = before.split('-').map(Number);
      // End = last day of the month BEFORE `before`
      const endDate   = new Date(yr, mo - 1, 0); // e.g. before=2025-12 → end=2025-11-30
      const startDate = new Date(endDate.getFullYear(), endDate.getMonth() - 5, 1); // 6 months range
      const from = `${localDateStr(startDate)} 00:00:00`;
      const to   = `${localDateStr(endDate)} 23:59:59`;
      const key  = `demands_hist_${localDateStr(startDate).slice(0,7)}_${localDateStr(endDate).slice(0,7)}`;
      const rows = await cached(key, 10*60*1000, () =>
        msAll(`/entity/demand?filter=${enc('moment>='+from+';moment<='+to)}&order=moment,asc`)
          .then(r => r.rows || [])
      );
      const months = [];
      let y = startDate.getFullYear(), m = startDate.getMonth() + 1;
      const ey = endDate.getFullYear(), em = endDate.getMonth() + 1;
      while (y < ey || (y === ey && m <= em)) {
        const k = `${y}-${String(m).padStart(2,'0')}`;
        months.push({ key: k, label: new Date(y, m-1, 1).toLocaleString('en', { month: 'short', year: '2-digit' }), count: 0, value: 0 });
        if (++m > 12) { m = 1; y++; }
      }
      const mMap = {}; months.forEach(e => { mMap[e.key] = e; });
      rows.forEach(r => { const ym = (r.moment||'').slice(0,7); if (mMap[ym]) { mMap[ym].count++; mMap[ym].value += Math.round((r.sum||0)/100); } });
      return res.json(months);
    }
    const rows = await getDemandsFromDec25();
    res.json(buildMonthlyCounts(rows));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SHIPMENTS PAGE ────────────────────────────────────────
app.get('/shipments', async (req, res) => {
  try {
    const c = await common();

    // Fetch all shipments with full pagination
    const { rows, total: msTotal } = await msAll('/entity/demand?order=moment,desc');

    // Group by date
    const dayMap = {};
    rows.forEach(r => {
      const date = (r.moment || '').slice(0, 10);
      if (!date) return;
      if (!dayMap[date]) dayMap[date] = { date, count: 0, total: 0 };
      dayMap[date].count++;
      dayMap[date].total += (r.sum || 0);
    });
    const days = Object.values(dayMap).sort((a, b) => b.date.localeCompare(a.date));

    // Derive months from actual data
    const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const monthMap = {};
    days.forEach(d => {
      const key = d.date.slice(0, 7);
      if (!monthMap[key]) {
        const [y, m] = key.split('-');
        monthMap[key] = { key, label: MONTH_NAMES[parseInt(m, 10) - 1] + ' ' + y, count: 0, total: 0 };
      }
      monthMap[key].count += d.count;
      monthMap[key].total += d.total;
    });
    const months = Object.values(monthMap).sort((a, b) => b.key.localeCompare(a.key));

    const totalCount = rows.length;
    const grandTotal = rows.reduce((a, r) => a + (r.sum || 0), 0);

    res.render('shipments', {
      ...c, active: 'shipments',
      days, months, totalCount, grandTotal: grandTotal / 100,
      msTotal
    });
  } catch(e) { res.status(500).render('error', { message: e.message }); }
});


// ── CUSTOMER ANALYTICS ───────────────────────────────────
app.get('/customer-analytics', async (req, res) => {
  try {
    const c = await common();
    const cpId   = req.query.id;
    const cpName = req.query.name || 'Customer';
    if (!cpId) return res.redirect('/');

    const cpHref      = `${MS_BASE}/entity/counterparty/${cpId}`;
    const agentFilter = `agent=${cpHref}`;
    const cpFilter    = `counterparty=${cpHref}`;

    const [cpRes, ordRes, prodRes, stateRes] = await Promise.allSettled([
      ms(`/entity/counterparty/${cpId}`),
      msAll(`/entity/customerorder?filter=${enc(agentFilter)}&order=moment,desc&expand=state`),
      ms(`/report/profit/byproduct?filter=${enc(cpFilter)}&limit=50`),
      getOrderStateMap()
    ]);

    const cp       = cpRes.status==='fulfilled'   ? cpRes.value : {};
    const orders   = ordRes.status==='fulfilled'  ? ordRes.value.rows : [];
    const products = prodRes.status==='fulfilled' ? (prodRes.value.rows||[]).sort((a,b)=>(b.sellSum||0)-(a.sellSum||0)) : [];
    const stateMap = stateRes.status==='fulfilled' ? stateRes.value : {};

    const totalRevenue   = orders.reduce((a,r)=>a+(r.sum||0),0)/100;
    const avgOrderValue  = orders.length>0 ? totalRevenue/orders.length : 0;
    const pending        = orders.filter(r=>{ const s=resolveState(r,stateMap).toLowerCase(); return s&&s!=='dispatched'&&s!=='draft'; }).length;

    // Monthly trend for chart
    const MN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const monthMap = {};
    orders.forEach(r => {
      const key = (r.moment||'').slice(0,7); if(!key) return;
      if(!monthMap[key]) monthMap[key]={key,count:0,revenue:0};
      monthMap[key].count++;
      monthMap[key].revenue += (r.sum||0)/100;
    });
    const monthlyTrend = Object.values(monthMap).sort((a,b)=>a.key.localeCompare(b.key)).map(m=>{
      const [y,mo]=m.key.split('-');
      return {...m, label: MN[parseInt(mo)-1]+' '+y };
    });

    // Order list for table (all orders, newest first)
    const orderList = orders.map(r=>({
      name:  r.name||'—',
      date:  (r.moment||'').slice(0,10),
      month: (r.moment||'').slice(0,7),
      sum:   (r.sum||0)/100,
      paid:  (r.payedSum||0)/100,
      state: resolveState(r,stateMap)||'—'
    }));

    res.render('customer-analytics', {
      ...c, active:'',
      cp: { name: cp.name||cpName, phone: cp.phone||'—', email: cp.email||'—', id: cpId },
      totalOrders: orders.length, totalRevenue, avgOrderValue, pending,
      orderList,
      topProducts: products.slice(0,10).map(r=>({
        name: r.assortment?.name||'—',
        id:   (r.assortment?.meta?.href||'').split('/').pop(),
        type: r.assortment?.meta?.type||'product',
        qty:  Math.round(r.sellQuantity||0),
        val:  (r.sellSum||0)/100
      })),
      monthlyTrend,
      ordersJSON:  JSON.stringify(orderList),
      trendJSON:   JSON.stringify(monthlyTrend)
    });
  } catch(e) { res.status(500).render('error',{message:e.message}); }
});

// ── PRODUCT ANALYTICS ────────────────────────────────────
app.get('/product-analytics', async (req, res) => {
  try {
    const c = await common();
    const { id, type = 'product', name: qName = 'Product' } = req.query;
    if (!id) return res.redirect('/');

    const entityPath = type === 'variant' ? 'variant' : 'product';
    const MN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const now = new Date();

    const monthRanges = Array.from({ length: 6 }, (_, i) => {
      const d   = new Date(now.getFullYear(), now.getMonth() - (5 - i), 1);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      const from = key + '-01';
      const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
      const to   = localDateStr(last);
      return { key, from, to, label: MN[d.getMonth()] + ' ' + d.getFullYear() };
    });

    // Fetch entity, stock, and per-month profit reports in parallel
    const [entityRes, stockRes, ...mResults] = await Promise.allSettled([
      ms(`/entity/${entityPath}/${id}`),
      ms('/report/stock/all?limit=1000'),
      ...monthRanges.map(m =>
        ms(`/report/profit/byproduct?momentFrom=${enc(m.from + ' 00:00:00')}&momentTo=${enc(m.to + ' 23:59:59')}&limit=1000`)
      )
    ]);

    const entity   = entityRes.status === 'fulfilled' ? entityRes.value : {};
    const allStock = stockRes.status  === 'fulfilled' ? (stockRes.value.rows || []) : [];

    // Derive the base product name (strip variant suffix like " (Flavor)").
    // This ensures stock/chart matching works whether the URL came from a
    // parent product ID or a specific variant ID.
    const rawName = entity.name || decodeURIComponent(qName);
    const baseName = rawName.replace(/\s*\([^)]*\)\s*$/, '').trim() || rawName;

    // Stock variants: match items whose name equals or starts with baseName
    function stockMatches(n) {
      return n === rawName || n === baseName ||
             n.startsWith(baseName + ' ') ||
             n.startsWith(baseName + '/') ||
             n.startsWith(baseName + '(');
    }
    const stockItems   = allStock.filter(r => stockMatches(r.name || ''));
    const currentStock = stockItems.reduce((a, r) => a + Math.max(0, r.quantity || 0), 0);
    const outCount     = stockItems.filter(r => (r.quantity || 0) <= 0).length;
    const lowCount     = stockItems.filter(r => (r.quantity || 0) > 0 && (r.quantity || 0) <= 100).length;

    // Build a set of known assortment IDs from stock items for fast matching
    const knownIds = new Set([id]);
    stockItems.forEach(r => {
      const sid = (r.meta?.href || '').split('/').pop().split('?')[0];
      if (sid) knownIds.add(sid);
    });

    // Does this profit-report row or demand position belong to our product?
    function nameMatches(name) {
      return name === rawName || name === baseName ||
             name.startsWith(baseName + ' ') ||
             name.startsWith(baseName + '/') ||
             name.startsWith(baseName + '(');
    }
    function assortmentMatches(href, name) {
      const sid = (href || '').split('/').pop().split('?')[0];
      return knownIds.has(sid) || nameMatches(name || '');
    }

    // For a month where the profit report returns 0, fall back to fetching raw demand
    // positions via the positions sub-resource (which reliably returns assortment names).
    async function monthFromDemands(m) {
      try {
        const filter = `moment>=${m.from} 00:00:00;moment<=${m.to} 23:59:59`;
        const [nameMap, { rows: demands }] = await Promise.all([
          getNameMap(),
          msAll(`/entity/demand?filter=${enc(filter)}`)
        ]);
        let qty = 0, val = 0;
        const BATCH = 25;
        for (let i = 0; i < demands.length; i += BATCH) {
          const slice = demands.slice(i, i + BATCH);
          const posRes = await Promise.allSettled(
            slice.map(d => fetchAllPos(d.id))
          );
          posRes.forEach(r => {
            if (r.status !== 'fulfilled') return;
            (r.value || []).forEach(pos => {
              const href = pos.assortment?.meta?.href || '';
              const name = nameMap[href]              || '';
              if (!assortmentMatches(href, name)) return;
              const q = pos.quantity || 0;
              const p = pos.price    || 0; // kopecks per unit
              const d = pos.discount || 0;
              qty += q;
              val += (q * p * (1 - d / 100)) / 100;
            });
          });
        }
        return { qty: Math.round(qty), val };
      } catch (_) { return { qty: 0, val: 0 }; }
    }

    // Build monthly trend: profit report primary; fall back to demand positions for 0 months
    const monthlyTrend = await Promise.all(monthRanges.map(async (m, i) => {
      const rows = mResults[i]?.status === 'fulfilled' ? (mResults[i].value.rows || []) : [];
      const matching = rows.filter(r => assortmentMatches(
        r.assortment?.meta?.href || '', r.assortment?.name || ''
      ));
      const qty = matching.reduce((a, r) => a + Math.round(r.sellQuantity || 0), 0);
      const val = matching.reduce((a, r) => a + (r.sellSum || 0) / 100, 0);
      if (qty > 0 || val > 0) return { ...m, qty, val };
      // Profit report has no data for this month — scan actual demand positions
      const fb = await monthFromDemands(m);
      return { ...m, ...fb };
    }));

    const totalQty = monthlyTrend.reduce((a, m) => a + m.qty, 0);
    const totalVal = monthlyTrend.reduce((a, m) => a + m.val, 0);
    const avgDaily = totalQty > 0 ? (totalQty / 180).toFixed(2) : '0.00';

    // Build per-flavour sales from all 6 months of profit report rows
    const flavorSalesMap = {};
    mResults.forEach(r => {
      if (r.status !== 'fulfilled') return;
      (r.value.rows || []).forEach(row => {
        const href = row.assortment?.meta?.href || '';
        const name = row.assortment?.name || '';
        if (!assortmentMatches(href, name)) return;
        // Skip the parent/base row (same name as baseName); keep only sub-flavour rows
        if (name === rawName || name === baseName) return;
        if (!flavorSalesMap[name]) flavorSalesMap[name] = { pcs: 0, revenue: 0 };
        flavorSalesMap[name].pcs     += Math.round(row.sellQuantity || 0);
        flavorSalesMap[name].revenue += (row.sellSum || 0) / 100;
      });
    });

    // Build flavour breakdown — merge sales with live stock qty (matched by name)
    const flavorBreakdown = Object.entries(flavorSalesMap).map(([name, sales]) => {
      const si    = allStock.find(r => r.name === name);
      const stock = si ? (si.quantity || 0) : null;
      const fm    = name.match(/\(([^)]+)\)\s*$/);
      return {
        name,
        flavor:  fm ? fm[1] : name,
        pcs:     sales.pcs,
        revenue: Math.round(sales.revenue),
        stock,
        stockStatus: stock === null ? 'unknown' : stock <= 0 ? 'out' : stock <= 100 ? 'low' : 'ok'
      };
    }).sort((a, b) => b.pcs - a.pcs);

    // Re-derive stock counts from flavorBreakdown when stockItems was empty
    const effectiveStockItems = stockItems.length > 0
      ? stockItems
      : allStock.filter(r => flavorSalesMap[r.name]);
    const currentStock2 = effectiveStockItems.reduce((a, r) => a + Math.max(0, r.quantity || 0), 0);
    const outCount2     = effectiveStockItems.filter(r => (r.quantity || 0) <= 0).length;
    const lowCount2     = effectiveStockItems.filter(r => (r.quantity || 0) > 0 && (r.quantity || 0) <= 100).length;

    const variants = effectiveStockItems.map(r => ({
      name:     r.name || '—',
      code:     r.code || r.article || '—',
      quantity: r.quantity || 0,
      status:   (r.quantity || 0) <= 0 ? 'Out of Stock' : (r.quantity || 0) <= 100 ? 'Low Stock' : 'In Stock'
    })).sort((a, b) => a.name.localeCompare(b.name));

    res.render('product-analytics', {
      ...c, active: '',
      productName: baseName, productId: id, productType: type,
      totalQty, totalVal,
      currentStock: currentStock2, avgDaily,
      outCount: outCount2, lowCount: lowCount2,
      variants, monthlyTrend, flavorBreakdown,
      trendJSON:           JSON.stringify(monthlyTrend),
      variantsJSON:        JSON.stringify(variants),
      flavorBreakdownJSON: JSON.stringify(flavorBreakdown)
    });
  } catch (e) { res.status(500).render('error', { message: e.message }); }
});

app.get('/stock-alerts', (req, res) => res.redirect('/inventory'));

// ── AI CHATBOT ────────────────────────────────────────────
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── MongoDB period parser (returns YYYY-MM-DD strings) ────────────────────
function parsePeriodMongo(period) {
  const now = new Date();
  if (!period || period === 'this_month') {
    return { from: `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`, to: todayStr() };
  }
  if (period === 'today')  return { from: todayStr(), to: todayStr() };
  if (period === 'this_year') return { from: `${now.getFullYear()}-01-01`, to: todayStr() };
  if (period === 'all')    return { from: '2024-12-01', to: todayStr() };
  if (period === 'last_month') {
    const p = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const l = new Date(now.getFullYear(), now.getMonth(), 0);
    return { from: `${p.getFullYear()}-${String(p.getMonth()+1).padStart(2,'0')}-01`, to: localDateStr(l) };
  }
  const ym = period.match(/^(\d{4})-(\d{2})$/);
  if (ym) {
    const [, yr, mo] = ym;
    return { from: `${yr}-${mo}-01`, to: localDateStr(new Date(+yr, +mo, 0)) };
  }
  const rng = period.match(/^(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/);
  if (rng) return { from: rng[1], to: rng[2] };
  return { from: `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`, to: todayStr() };
}

// ── Chatbot tool: query MoySklad data LIVE via API (not MongoDB) ──────────
async function toolQueryMoysklad({ data_type = 'demands', period = 'this_month', group_by = 'product', filter, top_n = 15, sort_by = 'revenue' } = {}) {
  try {
    const { from, to } = parsePeriodMongo(period);  // YYYY-MM-DD strings
    const N   = Math.min(+top_n || 15, 200);
    const sf  = sort_by === 'quantity' ? 'qty' : sort_by === 'orders' ? 'orders' : 'revenue';
    const apiFrom = `${from} 00:00:00`;
    const apiTo   = `${to} 23:59:59`;

    // ── STOCK ──────────────────────────────────────────────────────────────
    if (data_type === 'stock') {
      const stockRows = await getStock();
      let items = stockRows.map(s => {
        const qty = s.quantity || 0;
        const status = qty <= 0 ? 'out' : qty < 100 ? 'low' : 'ok';
        return { name: s.assortment?.name || s.name || '—', qty, status, price: Math.round((s.price || 0) / 100) };
      });
      if (filter?.startsWith('status:')) {
        const st = filter.slice(7);
        items = items.filter(i => i.status === st);
      } else if (filter) {
        const re = new RegExp(filter.replace(/^product:/, ''), 'i');
        items = items.filter(i => re.test(i.name));
      }
      items.sort((a, b) => b.qty - a.qty);
      return JSON.stringify({
        data_type: 'stock', source: 'MoySklad Live API',
        summary: { total: items.length, out: items.filter(i => i.status === 'out').length, low: items.filter(i => i.status === 'low').length, ok: items.filter(i => i.status === 'ok').length },
        items: items.slice(0, 100)
      });
    }

    // ── CUSTOMERS — top by revenue via profit report ────────────────────────
    if (data_type === 'customers') {
      const cacheKey = `chat_cp_${apiFrom}_${apiTo}`;
      const cpRows   = await cached(cacheKey, 5 * 60 * 1000, () =>
        ms(`/report/profit/bycounterparty?momentFrom=${enc(apiFrom)}&momentTo=${enc(apiTo)}&limit=100`).then(r => r.rows || [])
      );
      let customers = cpRows.map(r => ({
        name: r.counterparty?.name || '—',
        revenue: Math.round((r.sellSum || 0) / 100),
        orders: r.salesCount || 0
      }));
      if (filter) {
        const re = new RegExp(filter.replace(/^customer:/, ''), 'i');
        customers = customers.filter(c => re.test(c.name));
      }
      return JSON.stringify({ data_type: 'customers', period, source: 'MoySklad Live API', count: customers.length, customers: customers.slice(0, N) });
    }

    // ── ORDERS ──────────────────────────────────────────────────────────────
    if (data_type === 'orders') {
      const [allOrders, sMap] = await Promise.all([getAllOrders(), getOrderStateMap()]);
      let filtered = allOrders.filter(o => {
        const date = (o.moment || '').slice(0, 10);
        return date >= from && date <= to;
      });
      if (filter?.startsWith('customer:')) {
        const re = new RegExp(filter.slice(9), 'i');
        filtered = filtered.filter(o => re.test(agentName(o)));
      }
      const pending = filtered.filter(o => {
        const s = resolveState(o, sMap).toLowerCase();
        return !/dispatched|отгруж|declin|cancel|отмен|отклон|аннул/.test(s);
      });
      const totalRevenue = filtered.reduce((a, o) => a + Math.round((o.sum || 0) / 100), 0);
      return JSON.stringify({
        period, data_type: 'orders', source: 'MoySklad Live API',
        total: { revenue: totalRevenue, count: filtered.length },
        pending_count: pending.length,
        orders: filtered.slice(0, N).map(o => ({
          name: o.name || '—',
          date: (o.moment || '').slice(0, 10),
          customer: agentName(o),
          amount: Math.round((o.sum || 0) / 100),
          state: resolveState(o, sMap) || '—'
        }))
      });
    }

    // ── DEMANDS — filter live data and aggregate in-memory ──────────────────
    const allDemands = await getDemandsFromDec25();
    let demands = allDemands.filter(d => {
      const date = (d.moment || '').slice(0, 10);
      return date >= from && date <= to;
    });
    if (filter?.startsWith('customer:')) {
      const re = new RegExp(filter.slice(9), 'i');
      demands = demands.filter(d => re.test(agentName(d)));
    }

    if (group_by === 'none' || group_by === 'total') {
      const revenue = demands.reduce((a, d) => a + Math.round((d.sum || 0) / 100), 0);
      return JSON.stringify({ period, from, to, source: 'MoySklad Live API', revenue, shipments: demands.length });
    }

    if (group_by === 'customer') {
      const map = {};
      demands.forEach(d => {
        const name = agentName(d) || '—';
        if (!map[name]) map[name] = { customer: name, revenue: 0, orders: 0 };
        map[name].revenue += Math.round((d.sum || 0) / 100);
        map[name].orders++;
      });
      const rows = Object.values(map).sort((a, b) => b[sf === 'orders' ? 'orders' : 'revenue'] - a[sf === 'orders' ? 'orders' : 'revenue']);
      return JSON.stringify({ period, group_by: 'customer', source: 'MoySklad Live API', results: rows.slice(0, N) });
    }

    if (group_by === 'day') {
      const map = {};
      demands.forEach(d => {
        const date = (d.moment || '').slice(0, 10);
        if (!map[date]) map[date] = { date, revenue: 0, shipments: 0 };
        map[date].revenue += Math.round((d.sum || 0) / 100);
        map[date].shipments++;
      });
      const rows = Object.values(map).sort((a, b) => a.date.localeCompare(b.date));
      return JSON.stringify({ period, group_by: 'day', source: 'MoySklad Live API', results: rows });
    }

    if (group_by === 'month') {
      const map = {};
      allDemands.forEach(d => {
        const month = (d.moment || '').slice(0, 7);
        if (!month || month.length < 7) return;
        if (!map[month]) map[month] = { month, revenue: 0, shipments: 0 };
        map[month].revenue += Math.round((d.sum || 0) / 100);
        map[month].shipments++;
      });
      const rows = Object.values(map).sort((a, b) => a.month.localeCompare(b.month));
      return JSON.stringify({ group_by: 'month', source: 'MoySklad Live API', results: rows });
    }

    if (group_by === 'salesman') {
      const empMap = await cached('employees_map', 15 * 60 * 1000, async () => {
        const r = await ms('/entity/employee?limit=1000');
        const map = {};
        (r.rows || []).forEach(e => { if (e.id) map[e.id] = e.name || `${e.lastName || ''} ${e.firstName || ''}`.trim() || '—'; });
        return map;
      });
      const map = {};
      demands.forEach(d => {
        const uuid = (d.owner?.meta?.href || '').split('/').pop().split('?')[0];
        const name = uuid ? (empMap[uuid] || 'Unassigned') : 'Unassigned';
        if (!map[name]) map[name] = { salesman: name, revenue: 0, orders: 0 };
        map[name].revenue += Math.round((d.sum || 0) / 100);
        map[name].orders++;
      });
      const rows = Object.values(map).sort((a, b) => b[sf === 'orders' ? 'orders' : 'revenue'] - a[sf === 'orders' ? 'orders' : 'revenue']);
      return JSON.stringify({ period, group_by: 'salesman', source: 'MoySklad Live API', results: rows.slice(0, N) });
    }

    // ── product / sku — MoySklad profit report (live, cached 5 min) ─────────
    const prodCacheKey = `chat_prod_${apiFrom}_${apiTo}_${N}`;
    const prodRows = await cached(prodCacheKey, 5 * 60 * 1000, () =>
      ms(`/report/profit/byproduct?momentFrom=${enc(apiFrom)}&momentTo=${enc(apiTo)}&limit=${Math.min(N, 100)}`).then(r => r.rows || [])
    );
    let results = prodRows.map(r => ({
      product: r.assortment?.name || '—',
      qty: Math.round(r.sellQuantity || 0),
      revenue: Math.round((r.sellSum || 0) / 100)
    }));
    if (filter) {
      const re = new RegExp(filter.replace(/^product:/, ''), 'i');
      results = results.filter(r => re.test(r.product));
    }
    results.sort((a, b) => b[sf === 'quantity' ? 'qty' : 'revenue'] - a[sf === 'quantity' ? 'qty' : 'revenue']);
    return JSON.stringify({
      period, group_by: group_by || 'product', source: 'MoySklad Live API',
      total_revenue: results.reduce((a, r) => a + r.revenue, 0),
      total_pcs: results.reduce((a, r) => a + r.qty, 0),
      results: results.slice(0, N)
    });
  } catch (e) { return JSON.stringify({ error: e.message }); }
}

// ── Chatbot tool: query Tally data from MongoDB ───────────────────────────
async function toolQueryTally({ data_type = 'snapshot', period, filter } = {}) {
  try {
    const db = await getMongoDb();

    // ── Snapshot / debtors / creditors (from live Tally or saved snapshot) ──
    if (data_type === 'snapshot' || data_type === 'debtors' || data_type === 'creditors') {
      // Try DB ledgers first (more accurate than snapshot)
      if (db) {
        const [expLed, salesLed, purchLed, debtorLed, credLed] = await Promise.all([
          db.collection('tally_ledgers').find({ type: 'expense',  balance: { $gt: 0 } }).sort({ balance: -1 }).toArray(),
          db.collection('tally_ledgers').find({ type: 'sales' }).toArray(),
          db.collection('tally_ledgers').find({ type: 'purchase', balance: { $gt: 0 } }).toArray(),
          db.collection('tally_ledgers').find({ type: 'debtor',   balance: { $ne: 0 } }).sort({ balance: -1 }).toArray(),
          db.collection('tally_ledgers').find({ type: 'creditor', balance: { $ne: 0 } }).sort({ balance: -1 }).toArray(),
        ]);
        const totalSales     = salesLed.reduce((s, l) => s + Math.abs(l.balance || 0), 0);
        const totalPurchases = purchLed.reduce((s, l) => s + Math.abs(l.balance || 0), 0);
        const totalExpenses  = expLed.reduce((s, l) => s + (l.balance || 0), 0);
        const totalOutstanding = debtorLed.filter(d => d.balance > 0).reduce((s, l) => s + l.balance, 0);
        const supplierDues     = credLed.filter(c => c.balance > 0).reduce((s, l) => s + l.balance, 0);
        if (data_type === 'debtors') return JSON.stringify({
          total: Math.round(totalOutstanding),
          count: debtorLed.filter(d => d.balance > 0).length,
          debtors: debtorLed.filter(d => d.balance > 0).slice(0, 30).map(d => ({ name: d.name, balance: Math.round(d.balance), lastPayment: d.lastPaymentDate || null }))
        });
        if (data_type === 'creditors') return JSON.stringify({
          total: Math.round(supplierDues),
          creditors: credLed.filter(c => c.balance > 0).slice(0, 20).map(c => ({ name: c.name, balance: Math.round(c.balance) }))
        });
        return JSON.stringify({
          source: 'tally_ledgers (DB)',
          totalSales: Math.round(totalSales), totalPurchases: Math.round(totalPurchases),
          totalExpenses: Math.round(totalExpenses),
          netProfit: Math.round(totalSales - totalPurchases - totalExpenses),
          totalOutstanding: Math.round(totalOutstanding), supplierDues: Math.round(supplierDues),
          topDebtors: debtorLed.filter(d => d.balance > 0).slice(0, 15).map(d => ({ name: d.name, balance: Math.round(d.balance), lastPayment: d.lastPaymentDate || null })),
          topCreditors: credLed.filter(c => c.balance > 0).slice(0, 10).map(c => ({ name: c.name, balance: Math.round(c.balance) })),
          topExpenses: expLed.slice(0, 10).map(e => ({ name: e.name, balance: Math.round(e.balance) })),
        });
      }
      // Fallback: snapshot
      const snap = await loadTallySnapshot();
      if (!snap) return JSON.stringify({ error: 'No Tally data. Sync from Tally dashboard first.' });
      if (data_type === 'debtors')   return JSON.stringify({ total: Math.round(snap.totalOutstanding||0), debtors: (snap.debtors||[]).map(d=>({ name:d.name, balance:Math.round(d.balance) })) });
      if (data_type === 'creditors') return JSON.stringify({ total: Math.round(snap.supplierDues||0),   creditors: (snap.creditors||[]).map(c=>({ name:c.name, balance:Math.round(c.balance) })) });
      return JSON.stringify({ syncedAt: snap.syncedAt, totalSales: Math.round(snap.totalSales||0), totalPurchases: Math.round(snap.totalPurchases||0), totalExpenses: Math.round(snap.totalExpenses||0), netProfit: Math.round((snap.totalSales-snap.totalPurchases-snap.totalExpenses)||0), totalOutstanding: Math.round(snap.totalOutstanding||0), supplierDues: Math.round(snap.supplierDues||0) });
    }

    if (!db) return JSON.stringify({ error: 'MongoDB not connected' });

    // ── Vouchers: period + optional party/type filter ──
    if (data_type === 'vouchers') {
      const { from, to } = parsePeriodMongo(period || 'this_month');
      const q = { dateStr: { $gte: from.slice(0,10), $lte: to.slice(0,10) } };
      if (filter) q.$or = [{ party: { $regex: filter, $options:'i' } }, { type: { $regex: filter, $options:'i' } }, { narration: { $regex: filter, $options:'i' } }];
      const [vouchers, summary] = await Promise.all([
        db.collection('tally_vouchers').find(q).sort({ dateStr:-1 }).limit(150).toArray(),
        db.collection('tally_vouchers').aggregate([{ $match: q }, { $group: { _id:'$type', count:{ $sum:1 }, total:{ $sum:'$amount' } } }, { $sort: { total: -1 } }]).toArray()
      ]);
      return JSON.stringify({ period, from: from.slice(0,10), to: to.slice(0,10), totalVouchers: vouchers.length, summary, vouchers: vouchers.map(v=>({ date:v.dateStr, type:v.type, party:v.party, amount:Math.round(v.amount||0), narration:v.narration })) });
    }

    // ── Ledgers: all or filtered by name/type ──
    if (data_type === 'ledgers') {
      const q = {};
      if (filter) q.$or = [{ name:{ $regex:filter, $options:'i' } }, { type:{ $regex:filter, $options:'i' } }];
      const ledgers = await db.collection('tally_ledgers').find(q).sort({ balance:-1 }).limit(80).toArray();
      return JSON.stringify({ count: ledgers.length, ledgers: ledgers.map(l=>({ name:l.name, type:l.type, balance:Math.round(l.balance||0), lastPayment:l.lastPaymentDate })) });
    }

    // ── Month-by-month Tally sales from vouchers ──
    if (data_type === 'monthly_sales') {
      const rows = await db.collection('tally_vouchers').aggregate([
        { $group: { _id: { month: '$month', type: '$type' }, total: { $sum: '$amount' }, count: { $sum: 1 } } },
        { $sort: { '_id.month': 1 } }
      ]).toArray();
      const monthMap = {};
      rows.forEach(r => {
        const m = r._id.month; const t = (r._id.type||'').toLowerCase();
        if (!monthMap[m]) monthMap[m] = { month: m, sales: 0, purchases: 0, collections: 0, payments: 0, vouchers: 0 };
        if (t.includes('sales'))                              monthMap[m].sales       += Math.round(r.total);
        else if (t.includes('purchase'))                      monthMap[m].purchases   += Math.round(r.total);
        else if (t === 'journal' || t.includes('receipt'))    monthMap[m].collections += Math.round(r.total);
        else if (t.includes('payment'))                       monthMap[m].payments    += Math.round(r.total);
        monthMap[m].vouchers += r.count;
      });
      const months = Object.values(monthMap).sort((a,b) => a.month.localeCompare(b.month));
      return JSON.stringify({ months, note: 'All figures in ₹ from tally_vouchers DB' });
    }

    // ── Expense breakdown from ledgers ──
    if (data_type === 'expense_breakdown') {
      const expenses = await db.collection('tally_ledgers').find({ type: 'expense', balance: { $gt: 0 } }).sort({ balance: -1 }).toArray();
      const total = expenses.reduce((s, e) => s + (e.balance || 0), 0);
      return JSON.stringify({ totalExpenses: Math.round(total), count: expenses.length, breakdown: expenses.map(e => ({ name: e.name, amount: Math.round(e.balance), pct: total > 0 ? +((e.balance/total)*100).toFixed(1) : 0 })) });
    }

    // ── Stock inventory from tally_stock ──
    if (data_type === 'stock') {
      const q = filter ? { name: { $regex: filter, $options: 'i' } } : {};
      const items = await db.collection('tally_stock').find(q).sort({ value: -1 }).limit(100).toArray();
      const totalValue = items.reduce((s, i) => s + (i.value || 0), 0);
      const totalQty   = items.reduce((s, i) => s + (i.qty   || 0), 0);
      return JSON.stringify({ totalItems: items.length, totalValue: Math.round(totalValue), totalQty: Math.round(totalQty), items: items.map(i => ({ name: i.name, qty: Math.round(i.qty||0), value: Math.round(i.value||0) })) });
    }

    // ── Customer-specific voucher history ──
    if (data_type === 'customer_history') {
      if (!filter) return JSON.stringify({ error: 'Provide filter=customer name to search' });
      const { from, to } = parsePeriodMongo(period || 'this_year');
      const q = { party: { $regex: filter, $options: 'i' }, dateStr: { $gte: from.slice(0,10), $lte: to.slice(0,10) } };
      const [vouchers, summary] = await Promise.all([
        db.collection('tally_vouchers').find(q).sort({ dateStr: -1 }).limit(200).toArray(),
        db.collection('tally_vouchers').aggregate([{ $match: q }, { $group: { _id: '$type', total: { $sum: '$amount' }, count: { $sum: 1 } } }]).toArray()
      ]);
      const debtor = await db.collection('tally_ledgers').findOne({ name: { $regex: filter, $options: 'i' }, type: 'debtor' });
      return JSON.stringify({ customer: filter, period, from: from.slice(0,10), to: to.slice(0,10), outstandingBalance: debtor ? Math.round(debtor.balance) : null, lastPayment: debtor?.lastPaymentDate || null, totalVouchers: vouchers.length, summary, recentVouchers: vouchers.slice(0,30).map(v=>({ date:v.dateStr, type:v.type, amount:Math.round(v.amount||0), narration:v.narration })) });
    }

    // ── Purchase/supplier history ──
    if (data_type === 'purchase_history') {
      const { from, to } = parsePeriodMongo(period || 'this_year');
      const q = { type: { $regex: 'purchase', $options: 'i' }, dateStr: { $gte: from.slice(0,10), $lte: to.slice(0,10) } };
      if (filter) q.party = { $regex: filter, $options: 'i' };
      const [vouchers, bySupplier] = await Promise.all([
        db.collection('tally_vouchers').find(q).sort({ dateStr: -1 }).limit(150).toArray(),
        db.collection('tally_vouchers').aggregate([{ $match: q }, { $group: { _id: '$party', total: { $sum: '$amount' }, count: { $sum: 1 } } }, { $sort: { total: -1 } }, { $limit: 20 }]).toArray()
      ]);
      return JSON.stringify({ period, from: from.slice(0,10), to: to.slice(0,10), totalPurchases: vouchers.reduce((s,v) => s + (v.amount||0), 0), totalVouchers: vouchers.length, topSuppliers: bySupplier.map(s => ({ supplier: s._id||'Unknown', total: Math.round(s.total), count: s.count })), recentVouchers: vouchers.slice(0,30).map(v=>({ date:v.dateStr, party:v.party, amount:Math.round(v.amount||0), narration:v.narration })) });
    }

    // ── Overdue receivables (debtors not paid in N days) ──
    if (data_type === 'overdue') {
      const debtors = await db.collection('tally_ledgers').find({ type: 'debtor', balance: { $gt: 0 } }).sort({ balance: -1 }).toArray();
      const today   = new Date();
      const enriched = debtors.map(d => {
        const lastPay  = d.lastPaymentDate ? new Date(d.lastPaymentDate) : null;
        const daysSince = lastPay ? Math.floor((today - lastPay) / 86400000) : null;
        return { name: d.name, balance: Math.round(d.balance), lastPayment: d.lastPaymentDate || 'Never', daysSincePayment: daysSince, status: daysSince === null ? 'never_paid' : daysSince > 90 ? 'critical' : daysSince > 30 ? 'overdue' : 'recent' };
      });
      const critical = enriched.filter(d => d.status === 'critical' || d.status === 'never_paid');
      const overdue  = enriched.filter(d => d.status === 'overdue');
      return JSON.stringify({ totalOutstanding: Math.round(enriched.reduce((s,d) => s + d.balance, 0)), criticalCount: critical.length, overdueCount: overdue.length, critical, overdue, all: enriched });
    }

    // ── Gross Profit month-wise ──────────────────────────────────────────────
    // Formula: GP = Sales − Opening Stock − Purchases + Closing Stock
    // Opening stock of month M = tally_stock_monthly[M-1] (closing of prev month)
    // Closing stock of month M = tally_stock_monthly[M]
    if (data_type === 'gross_profit') {
      const stockMonthly = db.collection('tally_stock_monthly');
      const vouchersCol  = db.collection('tally_vouchers');
      const now          = new Date();

      // Determine which months to compute
      let targetMonths = [];
      if (period && /^\d{4}-\d{2}$/.test(period)) {
        // Single month requested (e.g. "2025-11" or "last_month")
        targetMonths = [period];
      } else if (period === 'last_month') {
        const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        targetMonths = [`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`];
      } else if (period === 'this_month') {
        targetMonths = [`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`];
      } else {
        // Default: last 6 months
        for (let i = 5; i >= 0; i--) {
          const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
          targetMonths.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`);
        }
      }

      // Collect all month keys we need (targets + their prev months for opening stock)
      const allMonthKeys = new Set();
      targetMonths.forEach(m => {
        allMonthKeys.add(m);
        const [y, mo] = m.split('-').map(Number);
        const prev = new Date(y, mo - 2, 1);
        allMonthKeys.add(`${prev.getFullYear()}-${String(prev.getMonth()+1).padStart(2,'0')}`);
      });

      // Fetch all stock records in one query
      const stockRecs = await stockMonthly.find({ _id: { $in: [...allMonthKeys] } }).toArray();
      const stockMap  = Object.fromEntries(stockRecs.map(r => [r._id, r.stockValue ?? 0]));

      // Compute GP per month
      const results = [];
      for (const month of targetMonths) {
        const [y, mo]  = month.split('-').map(Number);
        const firstDay = `${month}-01`;
        const lastDay  = new Date(y, mo, 0).toISOString().slice(0, 10);

        const prevMonDate = new Date(y, mo - 2, 1);
        const prevMonth   = `${prevMonDate.getFullYear()}-${String(prevMonDate.getMonth()+1).padStart(2,'0')}`;

        const openingStock = stockMap[prevMonth] ?? null;
        const closingStock = stockMap[month]     ?? null;
        const hasStock     = openingStock !== null && closingStock !== null;

        // Aggregate vouchers for the month
        const agg = await vouchersCol.aggregate([
          { $match: { dateStr: { $gte: firstDay, $lte: lastDay } } },
          { $group: { _id: '$type', total: { $sum: '$amount' } } }
        ]).toArray();

        let sales = 0, purchases = 0, collections = 0;
        for (const row of agg) {
          const t = (row._id || '').toLowerCase();
          if (t.includes('sales'))                           sales       += row.total;
          else if (t.includes('purchase'))                   purchases   += row.total;
          else if (t === 'journal' || t.includes('receipt')) collections += row.total;
        }

        const grossProfit  = hasStock ? (sales - (openingStock ?? 0) - purchases + (closingStock ?? 0)) : null;
        const grossMargin  = (hasStock && sales > 0) ? +((grossProfit / sales) * 100).toFixed(1) : null;

        results.push({
          month,
          sales:         Math.round(sales),
          purchases:     Math.round(purchases),
          collections:   Math.round(collections),
          openingStock:  openingStock !== null ? Math.round(openingStock)  : 'missing',
          closingStock:  closingStock !== null ? Math.round(closingStock)  : 'missing',
          grossProfit:   grossProfit  !== null ? Math.round(grossProfit)   : 'missing_stock_data',
          grossMarginPct: grossMargin !== null ? grossMargin : 'n/a',
          status:        hasStock ? (grossProfit >= 0 ? 'profit' : 'loss') : 'incomplete'
        });
      }

      return JSON.stringify({
        formula: 'GP = Sales − Opening Stock − Purchases + Closing Stock',
        note: 'Opening stock of month M = closing stock saved for month M-1',
        months: results,
        summary: {
          totalSales:       results.reduce((s, r) => s + (r.sales || 0), 0),
          totalPurchases:   results.reduce((s, r) => s + (r.purchases || 0), 0),
          totalGrossProfit: results.filter(r => typeof r.grossProfit === 'number').reduce((s, r) => s + r.grossProfit, 0),
          monthsWithData:   results.filter(r => r.status !== 'incomplete').length,
          monthsMissingStock: results.filter(r => r.status === 'incomplete').length
        }
      });
    }

    return JSON.stringify({ error: `Unknown data_type: ${data_type}. Options: snapshot|debtors|creditors|vouchers|ledgers|monthly_sales|expense_breakdown|stock|customer_history|purchase_history|overdue|gross_profit` });
  } catch (e) { return JSON.stringify({ error: e.message }); }
}

// ── Chatbot tool: compare Tally vs MoySklad ───────────────────────────────
async function toolCompareSources({ comparison_type = 'sales_total', period } = {}) {
  try {
    if (comparison_type === 'sales_total') {
      const { from, to } = parsePeriodMongo(period || 'this_month');
      const allDemands = await getDemandsFromDec25();
      const filtered = allDemands.filter(d => {
        const date = (d.moment || '').slice(0, 10);
        return date >= from && date <= to;
      });
      const msRev     = filtered.reduce((a, d) => a + Math.round((d.sum || 0) / 100), 0);
      const tallySnap = await loadTallySnapshot();
      const tallySales= Math.round(tallySnap?.totalSales || 0);
      const diff      = msRev - tallySales;
      return JSON.stringify({
        period, from, to,
        moysklad: { revenue: msRev, shipments: filtered.length, source: 'MoySklad Live API' },
        tally:    { sales: tallySales, syncedAt: tallySnap?.syncedAt },
        difference: { amount: diff, note: diff > 0 ? 'MoySklad higher' : diff < 0 ? 'Tally higher' : 'Match' }
      });
    }
    if (comparison_type === 'customer_outstanding') {
      const [tallySnap, allOrders, sMap] = await Promise.all([
        loadTallySnapshot(),
        getAllOrders(),
        getOrderStateMap()
      ]);
      const pending = allOrders.filter(o => {
        const s = resolveState(o, sMap).toLowerCase();
        return !/dispatched|отгруж|declin|cancel|отмен|отклон|аннул/.test(s);
      });
      const custMap = {};
      pending.forEach(o => {
        const name = agentName(o) || '—';
        if (!custMap[name]) custMap[name] = { customer: name, pendingOrders: 0, count: 0 };
        custMap[name].pendingOrders += Math.round((o.sum || 0) / 100);
        custMap[name].count++;
      });
      const pendingByCustomer = Object.values(custMap).sort((a, b) => b.pendingOrders - a.pendingOrders).slice(0, 20);
      return JSON.stringify({
        tally_outstanding: { total: Math.round(tallySnap?.totalOutstanding || 0), top_debtors: (tallySnap?.debtors || []).slice(0, 10).map(d => ({ name: d.name, balance: Math.round(d.balance) })) },
        moysklad_pending:  { customers: pendingByCustomer, source: 'MoySklad Live API' },
        note: 'Tally outstanding = unpaid invoices. MoySklad pending = orders not yet dispatched.'
      });
    }
    if (comparison_type === 'monthly_trend') {
      const allDemands = await getDemandsFromDec25();
      const monthMap = {};
      allDemands.forEach(d => {
        const mo = (d.moment || '').slice(0, 7);
        if (!mo || mo.length < 7) return;
        if (!monthMap[mo]) monthMap[mo] = { revenue: 0, shipments: 0 };
        monthMap[mo].revenue += Math.round((d.sum || 0) / 100);
        monthMap[mo].shipments++;
      });
      const msMonthly = Object.entries(monthMap).sort(([a], [b]) => a.localeCompare(b)).map(([mo, s]) => ({ month: mo, revenue: s.revenue, shipments: s.shipments }));
      let tallyMonthly = [];
      try {
        const db = await getMongoDb();
        if (db) {
          const rows = await db.collection('tally_vouchers').aggregate([
            { $match: { type: { $regex: 'sales', $options: 'i' } } },
            { $group: { _id: '$month', total: { $sum: '$amount' }, count: { $sum: 1 } } },
            { $sort: { _id: 1 } }
          ]).toArray().catch(() => []);
          tallyMonthly = rows.map(m => ({ month: m._id, sales: Math.round(m.total), vouchers: m.count }));
        }
      } catch (_) {}
      return JSON.stringify({
        moysklad_monthly: msMonthly,
        tally_monthly:    tallyMonthly,
        note: 'MoySklad = live shipment revenue (Dec 2025+). Tally = sales ledger entries.'
      });
    }
    return JSON.stringify({ error: `Unknown comparison_type: ${comparison_type}` });
  } catch(e) { return JSON.stringify({ error: e.message }); }
}

// ── Build chatbot context ─────────────────────────────────────────────────
async function buildChatContext() {
  return cached('chatCtx', 5 * 60 * 1000, async () => {
    const now           = new Date();
    const daysIntoMonth = now.getDate();
    const today         = todayStr();
    const curMonthName  = now.toLocaleString('en', { month: 'long', year: 'numeric' });
    const prevD         = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevMonthName = prevD.toLocaleString('en', { month: 'long', year: 'numeric' });
    const curMonthKey   = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
    const prevMonthKey  = `${prevD.getFullYear()}-${String(prevD.getMonth()+1).padStart(2,'0')}`;

    const fmtS  = n => { if(!n)return '₽0'; const a=Math.abs(n); if(a>=1e9)return `₽${(n/1e9).toFixed(2)}B`; if(a>=1e6)return `₽${(n/1e6).toFixed(2)}M`; if(a>=1e3)return `₽${Math.round(n/1e3)}K`; return `₽${Math.round(n).toLocaleString()}`; };
    const fmtINR= n => { if(!n)return '₹0'; const a=Math.abs(n); if(a>=1e7)return `₹${(n/1e7).toFixed(2)}Cr`; if(a>=1e5)return `₹${(n/1e5).toFixed(2)}L`; if(a>=1e3)return `₹${Math.round(n/1e3)}K`; return `₹${Math.round(n).toLocaleString()}`; };
    const pct   = (a, b) => b > 0 ? ((a-b)/b*100).toFixed(1)+'%' : 'N/A';

    // ── Fetch MoySklad live + Tally DB in parallel ────────────────────────
    const db = await getMongoDb().catch(() => null);
    const [demandsR, stockR, profProdR, profCustR, ordersR, stateMapR,
           tallyLedR, tallyVouchR, tallyStockR, tallyMonthR] = await Promise.allSettled([
      getDemandsFromDec25(),
      getStock(),
      getProfitByProduct(monthStart()),
      getProfitByCounterparty(monthStart()),
      getAllOrders(),
      getOrderStateMap(),
      // Tally ledgers from DB (debtors, creditors, expenses, sales, purchases)
      db ? db.collection('tally_ledgers').find({}).toArray() : Promise.resolve([]),
      // Recent Tally vouchers
      db ? db.collection('tally_vouchers').find({}).sort({ dateStr: -1 }).limit(500).toArray() : Promise.resolve([]),
      // Tally stock inventory
      db ? db.collection('tally_stock').find({}).sort({ value: -1 }).limit(50).toArray() : Promise.resolve([]),
      // Monthly sales summary from Tally vouchers
      db ? db.collection('tally_vouchers').aggregate([
        { $group: { _id: { month: '$month', type: '$type' }, total: { $sum: '$amount' }, count: { $sum: 1 } } },
        { $sort: { '_id.month': 1 } }
      ]).toArray() : Promise.resolve([]),
    ]);

    const allDemands  = demandsR.status   === 'fulfilled' ? demandsR.value   : [];
    const stock       = stockR.status     === 'fulfilled' ? stockR.value     : [];
    const topProds    = profProdR.status  === 'fulfilled' ? profProdR.value  : [];
    const topCusts    = profCustR.status  === 'fulfilled' ? profCustR.value  : [];
    const allOrders   = ordersR.status    === 'fulfilled' ? ordersR.value    : [];
    const sMap        = stateMapR.status  === 'fulfilled' ? stateMapR.value  : {};
    const tallyLed    = tallyLedR.status  === 'fulfilled' ? tallyLedR.value  : [];
    const tallyVouch  = tallyVouchR.status=== 'fulfilled' ? tallyVouchR.value: [];
    const tallyStock  = tallyStockR.status=== 'fulfilled' ? tallyStockR.value: [];
    const tallyMonthRows = tallyMonthR.status === 'fulfilled' ? tallyMonthR.value : [];

    // ── MoySklad stats ────────────────────────────────────────────────────
    const todayDemands   = allDemands.filter(d => (d.moment||'').startsWith(today));
    const curMonDemands  = allDemands.filter(d => (d.moment||'').slice(0,7) === curMonthKey);
    const prevMonDemands = allDemands.filter(d => (d.moment||'').slice(0,7) === prevMonthKey);
    const todayRevenue   = todayDemands.reduce((a,d) => a + Math.round((d.sum||0)/100), 0);
    const curRevenue     = curMonDemands.reduce((a,d) => a + Math.round((d.sum||0)/100), 0);
    const prevRevenue    = prevMonDemands.reduce((a,d) => a + Math.round((d.sum||0)/100), 0);
    const monthMap = {};
    allDemands.forEach(d => {
      const mo = (d.moment||'').slice(0,7); if (!mo || mo.length < 7) return;
      if (!monthMap[mo]) monthMap[mo] = { revenue:0, shipments:0 };
      monthMap[mo].revenue += Math.round((d.sum||0)/100); monthMap[mo].shipments++;
    });
    const stockWithStatus = stock.map(s => ({ name:s.assortment?.name||s.name||'—', qty:s.quantity||0, status:(s.quantity||0)<=0?'out':(s.quantity||0)<100?'low':'ok' }));
    const pendingOrders = allOrders.filter(o => !/dispatched|отгруж|declin|cancel|отмен|отклон|аннул/.test(resolveState(o,sMap).toLowerCase()));

    // ── Tally ledger aggregations ─────────────────────────────────────────
    const debtors   = tallyLed.filter(l => l.type === 'debtor'   && (l.balance||0) > 0).sort((a,b) => b.balance - a.balance);
    const creditors = tallyLed.filter(l => l.type === 'creditor' && (l.balance||0) > 0).sort((a,b) => b.balance - a.balance);
    const expenses  = tallyLed.filter(l => l.type === 'expense'  && (l.balance||0) > 0).sort((a,b) => b.balance - a.balance);
    const salesLed  = tallyLed.filter(l => l.type === 'sales');
    const purchLed  = tallyLed.filter(l => l.type === 'purchase' && (l.balance||0) > 0);
    const tSales    = salesLed.reduce((s,l) => s + Math.abs(l.balance||0), 0);
    const tPurch    = purchLed.reduce((s,l) => s + (l.balance||0), 0);
    const tExp      = expenses.reduce((s,l) => s + (l.balance||0), 0);
    const tOutstanding = debtors.reduce((s,l) => s + l.balance, 0);
    const tSupplier    = creditors.reduce((s,l) => s + l.balance, 0);

    // ── Tally monthly summary ─────────────────────────────────────────────
    const tMonthMap = {};
    tallyMonthRows.forEach(r => {
      const m = r._id.month; const t = (r._id.type||'').toLowerCase();
      if (!m) return;
      if (!tMonthMap[m]) tMonthMap[m] = { month:m, sales:0, purchases:0, collections:0, payments:0 };
      if (t.includes('sales'))                           tMonthMap[m].sales       += Math.round(r.total);
      else if (t.includes('purchase'))                   tMonthMap[m].purchases   += Math.round(r.total);
      else if (t === 'journal' || t.includes('receipt')) tMonthMap[m].collections += Math.round(r.total);
      else if (t.includes('payment'))                    tMonthMap[m].payments    += Math.round(r.total);
    });
    const tMonthly = Object.values(tMonthMap).sort((a,b) => a.month.localeCompare(b.month));

    // ── Recent Tally vouchers (last 30 days) ─────────────────────────────
    const thirtyDaysAgo = new Date(now); thirtyDaysAgo.setDate(thirtyDaysAgo.getDate()-30);
    const thirtyKey = thirtyDaysAgo.toISOString().slice(0,10);
    const recentTallyVouch = tallyVouch.filter(v => v.dateStr >= thirtyKey);

    const L   = [];
    const sec = t => L.push('', `── ${t} ──`);

    L.push(
      `You are PLATINA AI — the Business Intelligence assistant for PLATINA, a wholesale trading company.`,
      `Today: ${today} | Month: ${curMonthName} | ${daysIntoMonth} days elapsed`,
      `Currency: MoySklad data in ₽ (Russian Ruble) | Tally data in ₹ (Indian Rupee)`,
      ``,
      `━━━ DATA SOURCES ━━━`,
      `• MoySklad: Live API — shipments, orders, inventory, customers, salesmen (data from Dec 2025)`,
      `• Tally: MongoDB DB — vouchers (Jan 2024+), ledgers, stock, debtors, creditors, expenses`,
      ``,
      `━━━ TOOLS — ALWAYS USE TOOLS FOR DATA QUESTIONS ━━━`,
      ``,
      `1. query_moysklad(data_type, period, group_by, filter, top_n, sort_by)`,
      `   data_type: "demands"|"stock"|"customers"|"orders"`,
      `   group_by:  "product"|"sku"|"customer"|"day"|"month"|"salesman"|"none"`,
      `   period:    "today"|"this_month"|"last_month"|"this_year"|"YYYY-MM"|"YYYY-MM-DD:YYYY-MM-DD"`,
      `   filter:    "product:NAME" | "customer:NAME" | "status:low" | "status:out"`,
      ``,
      `2. query_tally(data_type, period, filter)`,
      `   data_type options:`,
      `   • "snapshot"          → P&L summary (sales, purchases, expenses, net profit, cash, bank)`,
      `   • "debtors"           → All debtors with outstanding balance + last payment date`,
      `   • "creditors"         → All supplier dues`,
      `   • "vouchers"          → Period vouchers (sales/purchase/payment/receipt/journal)`,
      `   • "ledgers"           → All ledger accounts with balances`,
      `   • "monthly_sales"     → Month-by-month sales, purchases, collections from DB`,
      `   • "expense_breakdown" → All expense heads with amounts and % of total`,
      `   • "stock"             → Tally stock inventory with quantities and values`,
      `   • "customer_history"  → All vouchers for a specific customer (use filter=customer name)`,
      `   • "purchase_history"  → Purchase vouchers by period or supplier (use filter=supplier name)`,
      `   • "overdue"           → Debtors overdue >30 or >90 days with payment status`,
      `   period: "this_month"|"last_month"|"this_year"|"YYYY-MM"|"YYYY-MM-DD:YYYY-MM-DD"`,
      `   filter: customer name / supplier name / ledger name / voucher type`,
      ``,
      `3. compare_sources(comparison_type, period)`,
      `   comparison_type: "sales_total"|"customer_outstanding"|"monthly_trend"`,
      ``,
      `4. web_search(query) — market trends, regulations, prices, external data only`,
      ``,
      `5. predict_sales(horizon, filter)`,
      `   horizon: "tomorrow"|"next_week"|"next_month" | filter: "customer:NAME"`,
      ``,
      `6. analyze(analysis_type, period)`,
      `   types: "health_report"|"growth_rate"|"slow_moving"|"day_of_week"|"avg_order_value"|"customer_frequency"|"peak_hours"|"top_days"`,
      ``,
      `━━━ DECISION RULES ━━━`,
      `- MoySklad shipments/orders/customers/stock/salesmen → query_moysklad`,
      `- Tally: outstanding receivables, debtors, payments, purchases, expenses, P&L → query_tally`,
      `- "Who owes us money" / overdue / receivables → query_tally data_type="overdue" or "debtors"`,
      `- "Which customer hasn't paid" → query_tally data_type="overdue"`,
      `- "Expense breakdown" / "what are our costs" → query_tally data_type="expense_breakdown"`,
      `- "Show purchases from [supplier]" → query_tally data_type="purchase_history" filter=supplier`,
      `- "History for [customer]" → query_tally data_type="customer_history" filter=customer`,
      `- "Monthly Tally trend" → query_tally data_type="monthly_sales"`,
      `- "Tally stock" / "inventory value" → query_tally data_type="stock"
- "gross profit" / "GP" / "margin" / "opening stock" / "closing stock" / "profitability this month" → query_tally data_type="gross_profit"`,
      `- "Salesman performance" → query_moysklad group_by="salesman"`,
      `- "SKU / flavour breakdown" → query_moysklad group_by="sku"`,
      `- "Sales forecast" → predict_sales`,
      `- "Business health" → analyze analysis_type="health_report"`,
      `- "Slow moving stock" → analyze analysis_type="slow_moving"`,
      `- MoySklad vs Tally comparison → compare_sources`,
      `- Always use tools. Never guess numbers. Lead with the answer. Tables for multi-row data.`,
      ``,
      `${'═'.repeat(70)}`,
      `LIVE SNAPSHOT (${new Date().toLocaleString('en-IN')})`,
      `${'═'.repeat(70)}`
    );

    // ── MoySklad section ──
    sec(`TODAY — ${today} (MoySklad)`);
    L.push(`Shipments: ${todayDemands.length} | Revenue: ${fmtS(todayRevenue)}`);

    sec(`MOYSKLAD INVENTORY`);
    const lowStock = stockWithStatus.filter(s=>s.status==='low').sort((a,b)=>a.qty-b.qty);
    const outStock = stockWithStatus.filter(s=>s.status==='out');
    L.push(`${stockWithStatus.length} SKUs | OK: ${stockWithStatus.filter(s=>s.status==='ok').length} | Low(≤100): ${lowStock.length} | Out: ${outStock.length}`);
    if (lowStock.length) L.push('Low: '+lowStock.slice(0,12).map(s=>`${s.name}(${s.qty})`).join(', '));
    if (outStock.length) L.push('Out: '+outStock.slice(0,12).map(s=>s.name).join(', '));

    sec(`MOYSKLAD SALES — ${curMonthName}`);
    const mom = prevRevenue > 0 ? ` (${pct(curRevenue,prevRevenue)} vs last month)` : '';
    L.push(`Shipments: ${curMonDemands.length} | Revenue: ${fmtS(curRevenue)}${mom}`);
    sec(`MOYSKLAD SALES — ${prevMonthName}`);
    L.push(`Shipments: ${prevMonDemands.length} | Revenue: ${fmtS(prevRevenue)}`);

    sec(`TOP PRODUCTS — ${curMonthName} (MoySklad)`);
    topProds.slice(0,10).forEach((p,i) => L.push(`${i+1}. ${p.assortment?.name||'—'} — ${fmtS((p.sellSum||0)/100)} | ${Math.round(p.sellQuantity||0)} pcs`));

    sec(`TOP CUSTOMERS — ${curMonthName} (MoySklad)`);
    topCusts.slice(0,10).forEach((c,i) => L.push(`${i+1}. ${c.counterparty?.name||'—'} — ${fmtS((c.sellSum||0)/100)} | ${c.salesCount||0} orders`));

    if (Object.keys(monthMap).length) {
      sec('MOYSKLAD MONTHLY HISTORY');
      Object.entries(monthMap).sort(([a],[b])=>a.localeCompare(b)).forEach(([mo,s]) => {
        L.push(`${mo}: ${fmtS(s.revenue)} (${s.shipments} shipments)`);
      });
    }

    sec(`PENDING ORDERS — ${pendingOrders.length} not dispatched (MoySklad)`);
    pendingOrders.slice(0,10).forEach(o => L.push(`  • ${o.name||'—'} | ${agentName(o)} | ${resolveState(o,sMap)||'—'} | ${fmtS((o.sum||0)/100)}`));

    // ── Tally section ──
    if (tallyLed.length > 0) {
      sec('TALLY FINANCIAL SUMMARY (from DB ledgers)');
      L.push(`Sales: ${fmtINR(tSales)} | Purchases: ${fmtINR(tPurch)} | Expenses: ${fmtINR(tExp)}`);
      L.push(`Net Profit: ${fmtINR(tSales-tPurch-tExp)} | Outstanding Receivables: ${fmtINR(tOutstanding)} | Supplier Dues: ${fmtINR(tSupplier)}`);

      sec(`TALLY DEBTORS — ${debtors.length} customers owe us ${fmtINR(tOutstanding)}`);
      debtors.slice(0,20).forEach((d,i) => {
        const lastPay = d.lastPaymentDate || 'never';
        const daysSince = d.lastPaymentDate ? Math.floor((now - new Date(d.lastPaymentDate))/86400000) : null;
        const overdue = daysSince ? (daysSince > 90 ? ' ⚠️CRITICAL' : daysSince > 30 ? ' ⚠️OVERDUE' : '') : ' ⚠️NEVER PAID';
        L.push(`${i+1}. ${d.name} — ${fmtINR(d.balance)} | Last paid: ${lastPay}${overdue}`);
      });

      if (creditors.length) {
        sec(`TALLY CREDITORS — ${creditors.length} suppliers, dues: ${fmtINR(tSupplier)}`);
        creditors.slice(0,10).forEach((c,i) => L.push(`${i+1}. ${c.name} — ${fmtINR(c.balance)}`));
      }

      if (expenses.length) {
        sec(`TALLY EXPENSE BREAKDOWN (total: ${fmtINR(tExp)})`);
        expenses.slice(0,15).forEach((e,i) => {
          const pctVal = tExp > 0 ? ((e.balance/tExp)*100).toFixed(1) : 0;
          L.push(`${i+1}. ${e.name}: ${fmtINR(e.balance)} (${pctVal}%)`);
        });
      }
    }

    if (tMonthly.length) {
      sec('TALLY MONTHLY TREND (from voucher DB)');
      tMonthly.forEach(m => L.push(`${m.month}: Sales ${fmtINR(m.sales)} | Purchases ${fmtINR(m.purchases)} | Collections ${fmtINR(m.collections)}`));
    }

    if (tallyStock.length) {
      const totalStockVal = tallyStock.reduce((s,i) => s+(i.value||0), 0);
      sec(`TALLY STOCK INVENTORY — ${tallyStock.length} items, total value: ${fmtINR(totalStockVal)}`);
      tallyStock.slice(0,20).forEach((s,i) => L.push(`${i+1}. ${s.name}: ${Math.round(s.qty||0)} qty | ${fmtINR(s.value)}`));
    }

    if (recentTallyVouch.length) {
      sec(`RECENT TALLY VOUCHERS (last 30 days — ${recentTallyVouch.length} entries)`);
      // Group by type
      const typeMap = {};
      recentTallyVouch.forEach(v => {
        const t = v.type||'Other';
        if (!typeMap[t]) typeMap[t] = { count:0, total:0 };
        typeMap[t].count++; typeMap[t].total += (v.amount||0);
      });
      Object.entries(typeMap).sort(([,a],[,b])=>b.total-a.total).forEach(([t,s]) => {
        L.push(`${t}: ${s.count} vouchers | ${fmtINR(s.total)}`);
      });
    }

    return L.join('\n');
  });
}

// ── Web search via DuckDuckGo (no API key needed) ────────
async function webSearch(query) {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'PLATINA-AI/1.0' },
      signal: AbortSignal.timeout(7000)
    });
    const d = await r.json();
    const parts = [];
    if (d.AbstractText) parts.push(`Overview: ${d.AbstractText}`);
    if (d.Answer)       parts.push(`Direct Answer: ${d.Answer}`);
    if (d.AbstractSource) parts.push(`Source: ${d.AbstractSource}`);
    (d.RelatedTopics || []).slice(0, 8).forEach(t => { if (t.Text) parts.push(`• ${t.Text}`); });
    (d.Results        || []).slice(0, 5).forEach(t => { if (t.Text) parts.push(`• ${t.Text}`); });
    return parts.length
      ? `[Web Search Results for: "${query}"]\n${parts.join('\n')}`
      : `[No instant results found for: "${query}". Use your training knowledge to answer.]`;
  } catch (e) {
    return `[Web search failed: ${e.message}. Use your training knowledge to answer this question.]`;
  }
}

// ── Chatbot tool: predict future sales using MoySklad live historical data ──
async function toolPredictSales({ horizon = 'tomorrow', filter } = {}) {
  try {
    let allDemands = await getDemandsFromDec25();
    if (filter) {
      const re = new RegExp(filter.replace(/^customer:/, ''), 'i');
      allDemands = allDemands.filter(d => re.test(agentName(d)));
    }

    const today = todayStr();

    // Build day-by-day revenue map (exclude today — it's still in progress)
    const dayMap = {};
    allDemands.forEach(d => {
      const date = (d.moment || '').slice(0, 10);
      if (!date || date >= today) return;
      if (!dayMap[date]) dayMap[date] = { revenue: 0, shipments: 0 };
      dayMap[date].revenue += Math.round((d.sum || 0) / 100);
      dayMap[date].shipments++;
    });

    const sortedDays = Object.entries(dayMap).sort(([a], [b]) => a.localeCompare(b));
    if (sortedDays.length < 7)
      return JSON.stringify({ error: 'Not enough historical data. Need at least 7 days of completed demand data.' });

    const last7  = sortedDays.slice(-7);
    const last14 = sortedDays.slice(-14);
    const last30 = sortedDays.slice(-30);

    // Daily moving averages
    const avg7  = last7.reduce((a, [, d]) => a + d.revenue, 0) / last7.length;
    const avg14 = last14.reduce((a, [, d]) => a + d.revenue, 0) / last14.length;
    const avg30 = last30.reduce((a, [, d]) => a + d.revenue, 0) / (last30.length || 1);

    // Day-of-week averages from last 30 days
    const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dowBuckets = [[], [], [], [], [], [], []];
    last30.forEach(([date, stats]) => {
      const dow = new Date(date + 'T00:00:00').getDay();
      dowBuckets[dow].push(stats.revenue);
    });
    const dowAvg = dowBuckets.map((vals, i) =>
      vals.length ? Math.round(vals.reduce((a, v) => a + v, 0) / vals.length) : Math.round(avg30)
    );

    // Week-over-week trend (prev 7 days vs the 7 before that)
    const wk1 = last14.slice(0, 7).reduce((a, [, d]) => a + d.revenue, 0);
    const wk2 = last7.reduce((a, [, d]) => a + d.revenue, 0);
    const weekTrend = wk1 > 0 ? (wk2 - wk1) / wk1 : 0;
    const trendFactor = Math.max(0.7, Math.min(1.5, 1 + weekTrend * 0.5)); // dampen, clamp

    // Day-of-week shipment averages (from last 30 days)
    const dowShipBuckets = [[], [], [], [], [], [], []];
    last30.forEach(([date, stats]) => {
      const dow = new Date(date + 'T00:00:00').getDay();
      dowShipBuckets[dow].push(stats.shipments);
    });
    const dowShipAvg = dowShipBuckets.map(vals =>
      vals.length ? Math.round(vals.reduce((a, v) => a + v, 0) / vals.length) : 0
    );
    const avgDailyShipments = last30.reduce((a, [, d]) => a + d.shipments, 0) / (last30.length || 1);

    // Build tomorrow + next 7 days predictions
    const next7 = [];
    for (let i = 1; i <= 7; i++) {
      const d = new Date(); d.setDate(d.getDate() + i);
      const dow = d.getDay();
      const pred = Math.round(dowAvg[dow] * trendFactor);
      const predShip = dowShipAvg[dow] > 0
        ? Math.round(dowShipAvg[dow] * trendFactor)
        : Math.round(avgDailyShipments * trendFactor);
      next7.push({ date: localDateStr(d), day: DOW_NAMES[dow], predicted_revenue: pred, predicted_shipments: predShip });
    }

    const tomorrow = next7[0];
    const next7Total = next7.reduce((a, d) => a + d.predicted_revenue, 0);

    // Next month estimate
    const now = new Date();
    const daysInNextMonth = new Date(now.getFullYear(), now.getMonth() + 2, 0).getDate();
    const nextMonthPred = Math.round(avg30 * trendFactor * daysInNextMonth);

    // Month-over-month context
    const curMonKey  = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
    const prevD2 = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevMonKey = `${prevD2.getFullYear()}-${String(prevD2.getMonth()+1).padStart(2,'0')}`;
    const curMonRev  = allDemands.filter(d => (d.moment||'').slice(0,7) === curMonKey).reduce((a,d) => a+Math.round((d.sum||0)/100), 0);
    const prevMonRev = allDemands.filter(d => (d.moment||'').slice(0,7) === prevMonKey).reduce((a,d) => a+Math.round((d.sum||0)/100), 0);

    const confidence = last30.length >= 25 ? 'high' : last30.length >= 14 ? 'medium' : 'low';

    return JSON.stringify({
      source: 'MoySklad Live API',
      model: 'Day-of-week moving average + weekly trend adjustment',
      data_points_used: last30.length,
      confidence,
      moving_averages: {
        last_7_days_daily_avg: Math.round(avg7),
        last_14_days_daily_avg: Math.round(avg14),
        last_30_days_daily_avg: Math.round(avg30)
      },
      trend: {
        prev_week_total: Math.round(wk1),
        last_week_total: Math.round(wk2),
        week_over_week: (weekTrend * 100).toFixed(1) + '%',
        direction: weekTrend > 0.05 ? 'Growing 📈' : weekTrend < -0.05 ? 'Declining 📉' : 'Stable ➡️',
        this_month_so_far: curMonRev,
        last_month_total: prevMonRev,
        month_over_month: prevMonRev > 0 ? ((curMonRev - prevMonRev) / prevMonRev * 100).toFixed(1) + '%' : 'N/A'
      },
      day_of_week_averages: DOW_NAMES.map((name, i) => ({ day: name, avg_revenue: dowAvg[i] })),
      predictions: {
        tomorrow: { date: tomorrow.date, day: tomorrow.day, low: Math.round(tomorrow.predicted_revenue * 0.75), expected: tomorrow.predicted_revenue, high: Math.round(tomorrow.predicted_revenue * 1.35) },
        next_7_days: { total_expected: next7Total, daily_avg: Math.round(next7Total / 7), day_by_day: next7 },
        next_month_estimate: nextMonthPred
      },
      note: 'Predictions use day-of-week averages + weekly momentum. Higher confidence with more data.'
    });
  } catch (e) { return JSON.stringify({ error: e.message }); }
}

// ── Chatbot tool: deep analytics from MoySklad live data ──────────────────
async function toolAnalytics({ analysis_type = 'health_report', period = 'this_month', filter } = {}) {
  try {
    const allDemands = await getDemandsFromDec25();
    const { from, to } = parsePeriodMongo(period);
    const today = todayStr();
    const fmtR = n => Math.round(n);

    let demands = allDemands.filter(d => {
      const date = (d.moment || '').slice(0, 10);
      return date >= from && date <= to;
    });
    if (filter) {
      const re = new RegExp(filter.replace(/^customer:/, ''), 'i');
      demands = demands.filter(d => re.test(agentName(d)));
    }

    // ── GROWTH RATE ───────────────────────────────────────────────────────
    if (analysis_type === 'growth_rate') {
      const now = new Date();
      // Last 8 weeks week-by-week
      const weeks = [];
      for (let w = 7; w >= 0; w--) {
        const wEnd   = new Date(); wEnd.setDate(wEnd.getDate() - w * 7);
        const wStart = new Date(wEnd); wStart.setDate(wStart.getDate() - 6);
        const wFrom = localDateStr(wStart), wTo = localDateStr(wEnd);
        const wDem = allDemands.filter(d => { const dt=(d.moment||'').slice(0,10); return dt>=wFrom&&dt<=wTo; });
        const wRev = wDem.reduce((a,d) => a+fmtR((d.sum||0)/100), 0);
        weeks.push({ week: `${wFrom} → ${wTo}`, revenue: wRev, shipments: wDem.length });
      }
      const wowGrowth = weeks.length >= 2 && weeks[weeks.length-2].revenue > 0
        ? ((weeks[weeks.length-1].revenue - weeks[weeks.length-2].revenue) / weeks[weeks.length-2].revenue * 100).toFixed(1) + '%'
        : 'N/A';

      // Last 6 months MoM
      const months = [];
      for (let m = 5; m >= 0; m--) {
        const mDate  = new Date(now.getFullYear(), now.getMonth() - m, 1);
        const moKey  = `${mDate.getFullYear()}-${String(mDate.getMonth()+1).padStart(2,'0')}`;
        const pDate  = new Date(mDate.getFullYear(), mDate.getMonth() - 1, 1);
        const prevKey= `${pDate.getFullYear()}-${String(pDate.getMonth()+1).padStart(2,'0')}`;
        const mRev   = allDemands.filter(d2 => (d2.moment||'').slice(0,7) === moKey).reduce((a,d2) => a+fmtR((d2.sum||0)/100), 0);
        const pRev   = allDemands.filter(d2 => (d2.moment||'').slice(0,7) === prevKey).reduce((a,d2) => a+fmtR((d2.sum||0)/100), 0);
        const mCount = allDemands.filter(d2 => (d2.moment||'').slice(0,7) === moKey).length;
        months.push({ month: moKey, revenue: mRev, shipments: mCount, mom_growth: pRev > 0 ? ((mRev-pRev)/pRev*100).toFixed(1)+'%' : 'N/A' });
      }
      return JSON.stringify({ analysis_type: 'growth_rate', source: 'MoySklad Live API', week_over_week_latest: wowGrowth, weekly_trend: weeks, monthly_trend: months });
    }

    // ── AVG ORDER VALUE ──────────────────────────────────────────────────
    if (analysis_type === 'avg_order_value') {
      const aov = demands.length > 0 ? fmtR(demands.reduce((a,d) => a+(d.sum||0)/100, 0) / demands.length) : 0;
      const monthMap = {};
      allDemands.forEach(d => {
        const mo = (d.moment||'').slice(0,7);
        if (!mo || mo.length < 7) return;
        if (!monthMap[mo]) monthMap[mo] = { revenue: 0, count: 0 };
        monthMap[mo].revenue += (d.sum||0)/100; monthMap[mo].count++;
      });
      const aovByMonth = Object.entries(monthMap).sort(([a],[b]) => a.localeCompare(b)).map(([mo, s]) => ({
        month: mo, avg_order_value: fmtR(s.count > 0 ? s.revenue/s.count : 0), shipments: s.count, revenue: fmtR(s.revenue)
      }));
      const buckets = { 'under_10k': 0, '10k_50k': 0, '50k_100k': 0, '100k_500k': 0, 'over_500k': 0 };
      demands.forEach(d => {
        const v = (d.sum||0)/100;
        if (v < 10000) buckets['under_10k']++;
        else if (v < 50000) buckets['10k_50k']++;
        else if (v < 100000) buckets['50k_100k']++;
        else if (v < 500000) buckets['100k_500k']++;
        else buckets['over_500k']++;
      });
      return JSON.stringify({ analysis_type: 'avg_order_value', period, source: 'MoySklad Live API', current_period_aov: aov, shipments: demands.length, revenue_distribution_by_order_size: buckets, monthly_aov_trend: aovByMonth });
    }

    // ── CUSTOMER FREQUENCY ───────────────────────────────────────────────
    if (analysis_type === 'customer_frequency') {
      const custDates = {};
      demands.forEach(d => {
        const name = agentName(d) || '—';
        const date = (d.moment||'').slice(0,10);
        if (!custDates[name]) custDates[name] = { dates: new Set(), revenue: 0, orders: 0 };
        custDates[name].dates.add(date);
        custDates[name].revenue += fmtR((d.sum||0)/100);
        custDates[name].orders++;
      });
      const custStats = Object.entries(custDates).map(([name, v]) => {
        const sortedDts = [...v.dates].sort();
        const gaps = sortedDts.slice(1).map((dt, i) => Math.round((new Date(dt) - new Date(sortedDts[i])) / 864e5));
        return {
          customer: name, orders: v.orders, unique_order_days: sortedDts.length,
          total_revenue: v.revenue,
          avg_days_between_orders: gaps.length ? Math.round(gaps.reduce((a,g)=>a+g,0)/gaps.length) : null,
          first_order: sortedDts[0], last_order: sortedDts[sortedDts.length-1]
        };
      }).sort((a, b) => b.orders - a.orders);
      const repeat = custStats.filter(c => c.orders > 1).length;
      return JSON.stringify({
        analysis_type: 'customer_frequency', period, source: 'MoySklad Live API',
        summary: { total_customers: custStats.length, repeat_customers: repeat, one_time_customers: custStats.length - repeat, repeat_rate: custStats.length > 0 ? (repeat/custStats.length*100).toFixed(1)+'%' : '0%' },
        top_customers: custStats.slice(0, 20)
      });
    }

    // ── DAY OF WEEK ──────────────────────────────────────────────────────
    if (analysis_type === 'day_of_week') {
      const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const dowStats  = Array.from({ length: 7 }, (_, i) => ({ day: DOW[i], total_revenue: 0, total_shipments: 0 }));
      const dowDates  = Array.from({ length: 7 }, () => new Set());
      demands.forEach(d => {
        const date = (d.moment||'').slice(0,10);
        if (!date) return;
        const dow = new Date(date + 'T00:00:00').getDay();
        dowStats[dow].total_revenue += fmtR((d.sum||0)/100);
        dowStats[dow].total_shipments++;
        dowDates[dow].add(date);
      });
      dowStats.forEach((s, i) => {
        const cnt = dowDates[i].size || 1;
        s.distinct_days = cnt;
        s.avg_daily_revenue = fmtR(s.total_revenue / cnt);
        s.avg_shipments_per_day = +(s.total_shipments / cnt).toFixed(1);
      });
      const ranked = [...dowStats].sort((a, b) => b.avg_daily_revenue - a.avg_daily_revenue);
      return JSON.stringify({ analysis_type: 'day_of_week', period, source: 'MoySklad Live API', best_day: ranked[0]?.day, slowest_day: ranked[ranked.length-1]?.day, by_day: dowStats, ranked_by_revenue: ranked });
    }

    // ── SLOW MOVING INVENTORY ────────────────────────────────────────────
    if (analysis_type === 'slow_moving') {
      const d30   = new Date(); d30.setDate(d30.getDate() - 30);
      const f30   = `${localDateStr(d30)} 00:00:00`;
      const t30   = `${today} 23:59:59`;
      const [stockRows, sold30] = await Promise.all([
        getStock(),
        cached(`slow_30d_${localDateStr(d30)}`, 5*60*1000, () =>
          ms(`/report/profit/byproduct?momentFrom=${enc(f30)}&momentTo=${enc(t30)}&limit=100`).then(r => r.rows || [])
        )
      ]);
      const soldNames = new Set(sold30.map(r => (r.assortment?.name || '').toLowerCase()));
      const inStock   = stockRows.filter(s => (s.quantity || 0) > 0);
      const slowItems = inStock
        .filter(s => !soldNames.has((s.assortment?.name || s.name || '').toLowerCase()))
        .map(s => ({
          name: s.assortment?.name || s.name || '—',
          qty: Math.round(s.quantity || 0),
          inventory_value: Math.round((s.quantity || 0) * (s.price || 0) / 100)
        })).sort((a, b) => b.inventory_value - a.inventory_value);
      return JSON.stringify({
        analysis_type: 'slow_moving', source: 'MoySklad Live API',
        note: 'Items in stock with ZERO sales in the last 30 days',
        summary: { slow_moving_count: slowItems.length, total_in_stock_skus: inStock.length, tied_up_value: slowItems.reduce((a,s)=>a+s.inventory_value,0) },
        slow_moving_items: slowItems.slice(0, 50)
      });
    }

    // ── PEAK HOURS ───────────────────────────────────────────────────────
    if (analysis_type === 'peak_hours') {
      const hourStats = Array.from({ length: 24 }, (_, i) => ({ hour: `${String(i).padStart(2,'0')}:00`, shipments: 0, revenue: 0 }));
      demands.forEach(d => {
        const hr = parseInt((d.moment || '').slice(11, 13), 10);
        if (isNaN(hr) || hr < 0 || hr > 23) return;
        hourStats[hr].shipments++;
        hourStats[hr].revenue += fmtR((d.sum||0)/100);
      });
      const active = hourStats.filter(h => h.shipments > 0).sort((a, b) => b.shipments - a.shipments);
      return JSON.stringify({ analysis_type: 'peak_hours', period, source: 'MoySklad Live API', busiest_hour: active[0]?.hour, top_5_hours: active.slice(0, 5), hourly_breakdown: hourStats });
    }

    // ── TOP DAYS ─────────────────────────────────────────────────────────
    if (analysis_type === 'top_days') {
      const dayRevMap = {}, dayShipMap = {};
      allDemands.forEach(d => {
        const date = (d.moment||'').slice(0,10);
        if (!date) return;
        dayRevMap[date]  = (dayRevMap[date]  || 0) + fmtR((d.sum||0)/100);
        dayShipMap[date] = (dayShipMap[date] || 0) + 1;
      });
      const byRev  = Object.entries(dayRevMap).map(([date,rev]) => ({ date, revenue: rev, shipments: dayShipMap[date]||0 })).sort((a,b)=>b.revenue-a.revenue);
      const byShip = Object.entries(dayShipMap).map(([date,ship]) => ({ date, shipments: ship, revenue: dayRevMap[date]||0 })).sort((a,b)=>b.shipments-a.shipments);
      return JSON.stringify({ analysis_type: 'top_days', source: 'MoySklad Live API', top_10_by_revenue: byRev.slice(0,10), top_10_by_shipments: byShip.slice(0,10) });
    }

    // ── HEALTH REPORT ────────────────────────────────────────────────────
    if (analysis_type === 'health_report') {
      const now       = new Date();
      const curMonKey = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
      const prevDt    = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const prevMonKey= `${prevDt.getFullYear()}-${String(prevDt.getMonth()+1).padStart(2,'0')}`;

      const curDem   = allDemands.filter(d => (d.moment||'').slice(0,7) === curMonKey);
      const prevDem  = allDemands.filter(d => (d.moment||'').slice(0,7) === prevMonKey);
      const todayDem = allDemands.filter(d => (d.moment||'').startsWith(today));

      const curRev   = curDem.reduce((a,d) => a+fmtR((d.sum||0)/100), 0);
      const prevRev  = prevDem.reduce((a,d) => a+fmtR((d.sum||0)/100), 0);
      const todayRev = todayDem.reduce((a,d) => a+fmtR((d.sum||0)/100), 0);
      const momNum   = prevRev > 0 ? (curRev - prevRev) / prevRev * 100 : null;
      const aov      = curDem.length > 0 ? fmtR(curRev / curDem.length) : 0;

      const [stockRows, allOrders, sMap] = await Promise.all([getStock(), getAllOrders(), getOrderStateMap()]);
      const stockStatus = stockRows.map(s => (s.quantity||0) <= 0 ? 'out' : (s.quantity||0) < 100 ? 'low' : 'ok');
      const pending = allOrders.filter(o => !/dispatched|отгруж|declin|cancel|отмен|отклон|аннул/.test(resolveState(o, sMap).toLowerCase()));

      // Last 7 days revenue
      const last7 = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const ds = localDateStr(d);
        last7.push({ date: ds, revenue: allDemands.filter(dd => (dd.moment||'').startsWith(ds)).reduce((a,dd)=>a+fmtR((dd.sum||0)/100),0), shipments: allDemands.filter(dd => (dd.moment||'').startsWith(ds)).length });
      }

      const curCusts  = new Set(curDem.map(d => agentName(d)).filter(n => n !== '—'));
      const prevCusts = new Set(prevDem.map(d => agentName(d)).filter(n => n !== '—'));
      const newCusts  = [...curCusts].filter(c => !prevCusts.has(c)).length;

      return JSON.stringify({
        analysis_type: 'health_report', source: 'MoySklad Live API', as_of: `${today} (live)`,
        today:      { revenue: todayRev, shipments: todayDem.length },
        this_month: { revenue: curRev, shipments: curDem.length, unique_customers: curCusts.size, new_customers: newCusts, avg_order_value: aov, mom_growth: momNum !== null ? momNum.toFixed(1)+'%' : 'N/A' },
        last_month: { revenue: prevRev, shipments: prevDem.length, unique_customers: prevCusts.size },
        inventory:  { total_skus: stockRows.length, ok: stockStatus.filter(s=>s==='ok').length, low: stockStatus.filter(s=>s==='low').length, out_of_stock: stockStatus.filter(s=>s==='out').length },
        pipeline:   { pending_orders: pending.length, pending_value: pending.reduce((a,o)=>a+fmtR((o.sum||0)/100),0) },
        last_7_days: last7,
        health_score: {
          revenue_trend:  momNum === null ? '⚪ No prev data' : momNum > 5 ? '✅ Growing' : momNum < -10 ? '🔴 Declining' : '🟡 Stable',
          stock_health:   stockStatus.filter(s=>s==='out').length > 10 ? '🔴 Many out of stock' : stockStatus.filter(s=>s==='low').length > 20 ? '🟡 Several low stock' : '✅ Good',
          order_pipeline: pending.length > 50 ? '🟡 High pending count' : '✅ Manageable'
        }
      });
    }

    return JSON.stringify({ error: `Unknown analysis_type: "${analysis_type}". Use: health_report, growth_rate, avg_order_value, customer_frequency, day_of_week, slow_moving, peak_hours, top_days` });
  } catch (e) { return JSON.stringify({ error: e.message }); }
}

// ── Period helpers used by dashboard pages and chatbot tools ───────────────
function resolvePeriod(period) {
  const now = new Date();
  if (!period || period === 'this_month') return { from: monthStart(), to: `${todayStr()} 23:59:59` };
  if (period === 'today') { const d = todayStr(); return { from: `${d} 00:00:00`, to: `${d} 23:59:59` }; }
  if (period === 'last_month') {
    const p = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const l = new Date(now.getFullYear(), now.getMonth(), 0);
    return { from: `${localDateStr(p)} 00:00:00`, to: `${localDateStr(l)} 23:59:59` };
  }
  const ym = period.match(/^(\d{4})-(\d{2})$/);
  if (ym) {
    const yr = +ym[1], mo = +ym[2];
    return { from: `${yr}-${String(mo).padStart(2,'0')}-01 00:00:00`, to: `${localDateStr(new Date(yr, mo, 0))} 23:59:59` };
  }
  const rng = period.match(/^(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/);
  if (rng) return { from: `${rng[1]} 00:00:00`, to: `${rng[2]} 23:59:59` };
  return { from: monthStart(), to: `${todayStr()} 23:59:59` };
}

// ── Chat tools definition ─────────────────────────────────
const CHAT_TOOLS = [
  {
    name: 'query_moysklad',
    description: `Query MoySklad business data LIVE from the MoySklad API (cached, always fresh — not MongoDB).

data_type options:
• "demands"   → shipment/sales records. Combine with group_by for breakdowns.
• "orders"    → customer orders (not yet shipped). Use for pending/outstanding orders.
• "stock"     → current live inventory levels.
• "customers" → top customers by revenue for the period.

group_by (for demands only):
• "product"   → revenue + qty by product model. Default.
• "sku"       → flavour/variant breakdown. Use for "sku wise", "flavour wise", "variant wise".
• "customer"  → revenue + shipments by customer.
• "salesman"  → revenue + shipments by salesman/employee. Use for "top salesman", "who sold most".
• "day"       → daily trend.
• "month"     → monthly trend across all history.
• "none"      → single total (revenue, count) for the period.

period: "today", "this_month", "last_month", "this_year", "YYYY-MM", "YYYY-MM-DD:YYYY-MM-DD"
filter: partial name match for product or customer (applies to sku/product/customer group_by)
sort_by: "revenue" (default) | "quantity" | "orders"
top_n: max results (default 15, max 200)

RULES:
- "sku wise" / "flavour wise" / "variant wise" / "breakdown" → group_by="sku"
- "which model sold most" / "product totals" → group_by="product"
- "top salesman" / "best salesman" / "salesman performance" → group_by="salesman"
- "by customer" / "top customers" → group_by="customer" OR data_type="customers"
- "monthly trend" / "month by month" → group_by="month"
- Pending orders / unshipped → data_type="orders"`,
    input_schema: {
      type: 'object',
      properties: {
        data_type: { type: 'string', enum: ['demands', 'orders', 'stock', 'customers'], description: 'Which collection to query' },
        period: { type: 'string', description: '"today","this_month","last_month","this_year","all","YYYY-MM","YYYY-MM-DD:YYYY-MM-DD"' },
        group_by: { type: 'string', enum: ['product', 'sku', 'customer', 'salesman', 'day', 'month', 'none'], description: 'How to aggregate demands. "sku" for flavour detail. "salesman" for employee breakdown.' },
        filter: { type: 'string', description: 'Partial name match for product or customer' },
        top_n: { type: 'number', description: 'Max rows to return (default 15)' },
        sort_by: { type: 'string', enum: ['revenue', 'quantity', 'orders'], description: 'Sort field (default: revenue)' }
      },
      required: ['data_type']
    }
  },
  {
    name: 'query_tally',
    description: `Query Tally accounting data from MongoDB.

data_type options:
• "snapshot"          → Full P&L summary from tally_ledgers: totalSales, totalPurchases, totalExpenses, netProfit, totalOutstanding, supplierDues, topDebtors, topCreditors, topExpenses
• "debtors"           → All customers who owe money: name, balance, lastPayment date (sorted by amount)
• "creditors"         → All suppliers owed: name, balance (sorted by amount)
• "vouchers"          → Individual Tally voucher transactions (sales, purchase, receipt, journal). Use period + filter
• "ledgers"           → All ledger account balances (filter by name or type)
• "monthly_sales"     → Month-by-month trend: sales, purchases, collections, payments per month from tally_vouchers
• "expense_breakdown" → All expense ledgers with amount + % of total. Use when asked "what are our costs" / "expense breakdown"
• "stock"             → Tally inventory: item name, qty, value. Use filter for specific product search
• "customer_history"  → All vouchers for ONE customer (sales invoices, receipts, payments). Requires filter=customer_name. Shows outstanding balance + lastPayment
• "purchase_history"  → Purchase vouchers by period. Optional filter=supplier_name. Shows top suppliers by spend
• "overdue"           → Debtors ranked by urgency: daysSincePayment, status (critical >90d / overdue >30d / never_paid). ALWAYS use for "who hasn't paid" / "overdue" / "follow up" questions
• "gross_profit"      → Month-wise gross profit: Sales − Opening Stock − Purchases + Closing Stock. period="YYYY-MM" for one month, omit for last 6 months trend. Formula matches Tally P&L exactly.

period: "today"|"this_month"|"last_month"|"this_year"|"YYYY-MM"|"YYYY-MM-DD:YYYY-MM-DD"
filter: "customer_name" | "supplier_name" | "product_name" (partial match, case-insensitive)

ROUTING GUIDE:
- "P&L" / "profit and loss" / "net profit" / "how much did we sell" → snapshot
- "who owes us" / "debtors" / "outstanding" → debtors or overdue
- "hasn't paid" / "overdue" / "follow up" / "receivables urgent" → overdue
- "expense" / "costs" / "what are we spending" → expense_breakdown
- "monthly trend" / "month by month Tally" → monthly_sales
- "stock value" / "inventory" / "how much stock" → stock
- "customer history" / "all invoices for [name]" → customer_history + filter
- "purchases from [supplier]" / "what did we buy" → purchase_history
- "suppliers owed" / "payables" → creditors
- "gross profit" / "GP" / "margin" / "opening stock" / "closing stock" / "profitability" → gross_profit`,
    input_schema: {
      type: 'object',
      properties: {
        data_type: {
          type: 'string',
          enum: ['snapshot', 'debtors', 'creditors', 'vouchers', 'ledgers', 'monthly_sales', 'expense_breakdown', 'stock', 'customer_history', 'purchase_history', 'overdue', 'gross_profit'],
          description: 'Which Tally data to fetch'
        },
        period: { type: 'string', description: 'Period: "this_month","last_month","this_year","YYYY-MM","YYYY-MM-DD:YYYY-MM-DD"' },
        filter: { type: 'string', description: 'Partial-match filter: customer name, supplier name, or product name' }
      },
      required: ['data_type']
    }
  },
  {
    name: 'compare_sources',
    description: `Compare Tally accounting data vs MoySklad operational data to find discrepancies.

comparison_type options:
• "sales_total"           → MoySklad shipment revenue vs Tally total sales for same period
• "customer_outstanding"  → Tally debtors outstanding vs MoySklad pending/unshipped orders
• "monthly_trend"         → Month-by-month revenue from both systems side by side

Use this when user asks: "why is there a difference", "reconcile", "tally vs moysklad", "discrepancy", "match the figures".`,
    input_schema: {
      type: 'object',
      properties: {
        comparison_type: { type: 'string', enum: ['sales_total', 'customer_outstanding', 'monthly_trend'], description: 'What to compare' },
        period: { type: 'string', description: 'Period for comparison: "this_month","last_month","YYYY-MM","this_year"' }
      },
      required: ['comparison_type']
    }
  },
  {
    name: 'predict_sales',
    description: `Predict future sales revenue using MoySklad live historical data.
Uses day-of-week patterns + moving averages + weekly momentum trend.

horizon: "tomorrow" (default) | "next_week" | "next_month"
filter: optional "customer:NAME" to forecast for a specific customer

Use for: "predict tomorrow sales", "what will revenue be next week", "sales forecast", "expected revenue", "sales outlook", "will we hit target"`,
    input_schema: {
      type: 'object',
      properties: {
        horizon: { type: 'string', enum: ['tomorrow', 'next_week', 'next_month'], description: 'Forecast horizon' },
        filter:  { type: 'string', description: 'Optional customer filter e.g. "customer:Acme"' }
      }
    }
  },
  {
    name: 'analyze',
    description: `Deep business analytics and intelligence from MoySklad live data.

analysis_type options:
• "health_report"      → FULL business snapshot: today + month + MoM growth + stock + pipeline + last 7 days. Use for general health/overview questions.
• "growth_rate"        → Week-over-week and month-over-month revenue growth rates with trend table.
• "avg_order_value"    → Average shipment value trend over time + revenue distribution buckets.
• "customer_frequency" → Repeat rate, avg days between orders, customer loyalty metrics.
• "day_of_week"        → Which days generate most revenue/shipments (Mon–Sun heatmap).
• "slow_moving"        → SKUs in stock with ZERO sales in last 30 days (tied-up capital).
• "peak_hours"         → Hour-of-day analysis — when are shipments processed most.
• "top_days"           → Top 10 highest revenue days and busiest shipment days ever.

period: "today","this_month","last_month","this_year","YYYY-MM","YYYY-MM-DD:YYYY-MM-DD"
filter: optional "customer:NAME"

ROUTING:
- "health report" / "how are we doing" / "business overview" → health_report
- "slow moving" / "dead stock" / "not selling" / "sitting in warehouse" → slow_moving
- "growth" / "trend" / "month over month" / "week over week" → growth_rate
- "busy day" / "best day" / "weekday" / "weekend" → day_of_week
- "repeat customers" / "loyalty" / "how often" → customer_frequency
- "average order" / "ticket size" → avg_order_value`,
    input_schema: {
      type: 'object',
      properties: {
        analysis_type: { type: 'string', enum: ['health_report', 'growth_rate', 'avg_order_value', 'customer_frequency', 'day_of_week', 'slow_moving', 'peak_hours', 'top_days'], description: 'Type of analysis' },
        period: { type: 'string', description: 'Period: "this_month","last_month","this_year","YYYY-MM","YYYY-MM-DD:YYYY-MM-DD"' },
        filter: { type: 'string', description: 'Optional customer filter' }
      },
      required: ['analysis_type']
    }
  },
  {
    name: 'web_search',
    description: 'Search the internet for EXTERNAL information only: market trends, regulations, competitor data, industry news, GST/tax rates, global pricing. Do NOT use for internal business data — use query_moysklad or query_tally instead.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Focused search query. E.g. "vaping market India 2025" or "e-cigarette GST rate India"' }
      },
      required: ['query']
    }
  }
];

// ── MoySklad sync endpoints ───────────────────────────────────────────────
app.post('/api/ms/sync', (req, res) => {
  res.status(410).json({ ok: false, message: 'MoySklad database sync is disabled' });
});

app.get('/api/ms/sync/status', (req, res) => {
  res.json({ ok: true, running: false, meta: null, disabled: true });
});

// ── Chat tool status label ────────────────────────────────────────────────
function getToolStatusText(toolUses) {
  const labels = toolUses.map(t => {
    if (t.name === 'query_tally') {
      const dt = (t.input.data_type || 'data').replace(/_/g, ' ');
      return `Tally ${dt}`;
    }
    if (t.name === 'query_moysklad') {
      const dt = (t.input.data_type || 'data').replace(/_/g, ' ');
      return `MoySklad ${dt}`;
    }
    if (t.name === 'web_search')      return 'web search';
    if (t.name === 'analyze')         return `analytics · ${(t.input.analysis_type||'').replace(/_/g,' ')}`;
    if (t.name === 'predict_sales')   return 'sales forecast';
    if (t.name === 'compare_sources') return 'comparing Tally vs MoySklad';
    return t.name;
  });
  return `Fetching ${labels.join(' + ')}…`;
}

app.post('/api/chat', async (req, res) => {
  try {
    const { messages } = req.body;
    if (!Array.isArray(messages) || messages.length === 0)
      return res.status(400).json({ error: 'messages array required' });

    // ── SSE headers — stream reply to client in real time ──
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    const sse = data => res.write(`data: ${JSON.stringify(data)}\n\n`);

    const systemPrompt = await buildChatContext();
    let msgHistory = [...messages.slice(-20)];

    // Agentic loop: allow up to 5 rounds (each round may have multiple tool calls)
    for (let round = 0; round < 5; round++) {
      let textStreamed = false;

      // ── Stream the response — text chunks arrive immediately ──
      const stream = anthropic.messages.stream({
        model: 'claude-sonnet-4-6',
        max_tokens: 3000,
        // cache_control caches the large system prompt on Anthropic's side → ~80% faster TTFT
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        tools: CHAT_TOOLS,
        messages: msgHistory
      });

      // Forward text tokens to client as they arrive
      stream.on('text', text => {
        textStreamed = true;
        sse({ type: 'chunk', text });
      });

      // Wait for the full message (needed to read tool inputs)
      const finalMsg = await stream.finalMessage();

      if (finalMsg.stop_reason === 'tool_use') {
        const toolUses = finalMsg.content.filter(c => c.type === 'tool_use');
        // If Claude streamed any pre-tool reasoning, clear it from client
        if (textStreamed) sse({ type: 'clear' });
        // Tell client which data is being fetched
        sse({ type: 'status', text: getToolStatusText(toolUses) });

        const toolResults_raw = await Promise.all(toolUses.map(t => {
          if (t.name === 'web_search')       return webSearch(t.input.query);
          if (t.name === 'query_moysklad')   return toolQueryMoysklad(t.input);
          if (t.name === 'query_tally')      return toolQueryTally(t.input);
          if (t.name === 'compare_sources')  return toolCompareSources(t.input);
          if (t.name === 'predict_sales')    return toolPredictSales(t.input);
          if (t.name === 'analyze')          return toolAnalytics(t.input);
          return Promise.resolve(JSON.stringify({ error: 'Unknown tool: ' + t.name }));
        }));

        const toolResults = toolUses.map((t, i) => ({
          type: 'tool_result',
          tool_use_id: t.id,
          content: toolResults_raw[i]
        }));
        msgHistory = [
          ...msgHistory,
          { role: 'assistant', content: finalMsg.content },
          { role: 'user',      content: toolResults }
        ];
        continue;
      }

      // end_turn — Claude finished, text was already streamed
      sse({ type: 'done' });
      return res.end();
    }

    sse({ type: 'done' });
    res.end();
  } catch (e) {
    console.error('Chat API error:', e.message);
    try { res.write(`data: ${JSON.stringify({ type: 'error', text: e.message })}\n\n`); res.end(); } catch (_) {}
  }
});

// ── TALLY FINANCIAL DASHBOARD ────────────────────────────
async function fetchLiveTallyData() {
  const result = {
    connected: false, company: TALLY_COMPANY || '', error: null,
    tallyUrl: TALLY_BASE,
    totalSales: 0, totalPurchases: 0, totalExpenses: 0, totalOutstanding: 0,
    cashBalance: 0, bankBalance: 0, supplierDues: 0,
    debtors: [], creditors: [], recentVouchers: []
  };

  const ledXml = await tallyCollection('AllLedgers', `
<COLLECTION NAME="AllLedgers" ISMODIFY="No">
  <TYPE>Ledger</TYPE>
  <FETCH>Name,Parent,ClosingBalance</FETCH>
</COLLECTION>`);

  result.connected = true;

  for (const blk of blocks(ledXml, 'LEDGER')) {
    const name   = attr(blk, 'NAME') || stripXml(getTag(blk, 'NAME')) || '—';
    const parent = stripXml(getTag(blk, 'PARENT')).toLowerCase();
    const balStr = stripXml(getTag(blk, 'CLOSINGBALANCE'));
    const bal    = parseTallyAmount(balStr);
    const absBal = Math.abs(bal);
    const isCr   = /\bCr\b/i.test(balStr);

    if      (parent.includes('sales account'))    result.totalSales     += absBal;
    else if (parent.includes('purchase account')) result.totalPurchases += absBal;
    else if (parent.includes('indirect expense')) result.totalExpenses  += absBal;
    else if (parent === 'cash-in-hand' || parent === 'cash in hand') result.cashBalance += absBal;
    else if (parent.includes('bank account'))     result.bankBalance    += absBal;
    else if (parent.includes('sundry debtor')) {
      if (absBal > 0) result.debtors.push({ name, balance: isCr ? -absBal : absBal });
    }
    else if (parent.includes('sundry creditor')) {
      if (absBal > 0) result.creditors.push({ name, balance: isCr ? absBal : -absBal });
    }
  }

  result.debtors          = result.debtors.filter(d => d.balance > 0).sort((a,b) => b.balance - a.balance).slice(0, 15);
  result.creditors        = result.creditors.filter(c => c.balance > 0).sort((a,b) => b.balance - a.balance).slice(0, 15);
  result.totalOutstanding = result.debtors.reduce((a, r) => a + r.balance, 0);
  result.supplierDues     = result.creditors.reduce((a, r) => a + r.balance, 0);

  try {
    const vXml = await tallyCollection('RecentVouchers', `
<COLLECTION NAME="RecentVouchers" ISMODIFY="No">
  <TYPE>Voucher</TYPE>
  <FETCH>Date,VoucherNumber,VoucherTypeName,PartyLedgerName,Amount</FETCH>
</COLLECTION>`, { fromDate: `${new Date().getFullYear()}-${String(new Date().getMonth()+1).padStart(2,'0')}-01`, toDate: todayStr() });

    result.recentVouchers = blocks(vXml, 'VOUCHER').slice(0, 25).map(v => ({
      date:  formatTallyDate(stripXml(getTag(v, 'DATE'))),
      type:  stripXml(getTag(v, 'VOUCHERTYPENAME')) || attr(v, 'VCHTYPE') || '—',
      num:   stripXml(getTag(v, 'VOUCHERNUMBER')) || '—',
      party: stripXml(getTag(v, 'PARTYLEDGERNAME')) || '—',
      amt:   Math.abs(parseTallyAmount(getTag(v, 'AMOUNT')))
    })).filter(v => v.date !== '—' && v.type !== '—');
  } catch(_) {}

  return result;
}

app.get('/tally', async (req, res) => {
  if (req.session.role === 'limited') return res.redirect('/');
  const c   = await common();
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;

  // ── Discover which months actually have data in MongoDB ──────
  let monthsWithData = [];
  const dbEarly = await getMongoDb();
  if (dbEarly) {
    monthsWithData = (await dbEarly.collection('tally_vouchers').distinct('month')).sort();
  }

  // ── Date-range selection (always date-based, no month dropdown) ──
  const todayStr     = now.toISOString().slice(0, 10);
  const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

  // Smart default: use current month if DB has data for it,
  // otherwise fall back to the most recent month that does have data.
  const currentMonthStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const lastKnownMonth  = monthsWithData.length > 0 ? monthsWithData[monthsWithData.length - 1] : currentMonthStr;
  const defaultMonth    = monthsWithData.includes(currentMonthStr) ? currentMonthStr : lastKnownMonth;
  const firstOfMonth    = `${defaultMonth}-01`;
  // Last day of defaultMonth
  const [dy, dm]        = defaultMonth.split('-').map(Number);
  const lastOfMonth     = new Date(dy, dm, 0).toISOString().slice(0, 10);
  const defaultTo       = defaultMonth === currentMonthStr ? todayStr : lastOfMonth;

  const customFrom  = isDate(req.query.from) ? String(req.query.from) : firstOfMonth;
  const customTo    = isDate(req.query.to)   ? String(req.query.to)   : defaultTo;
  const isCustomRange  = customFrom <= customTo;
  const selMonth       = customFrom.slice(0, 7);
  const periodQuery    = { dateStr: { $gte: customFrom, $lte: customTo } };
  const periodStartDate = customFrom;
  const periodEndDate   = customTo;
  const periodLabel = `${customFrom.split('-').reverse().join('/')} – ${customTo.split('-').reverse().join('/')}`;

  // ── Live Tally data (balances) ──────────────────────────────
  let result;
  let fromCache = false;
  let syncedAt  = null;
  try {
    result = await fetchLiveTallyData();
    if (result.connected) {
      saveTallySnapshot(result).catch(e => console.error('Mongo save:', e.message));
      syncedAt = now;
      // ── Auto stock snapshot: save today's stock silently on every page load ──
      // Builds up daily history so opening/closing stock calc works automatically.
      setImmediate(async () => {
        try {
          const dbS = await getMongoDb();
          if (!dbS) return;
          const todayKey = now.toISOString().slice(0, 10);
          const alreadySaved = await dbS.collection('tally_stock_history').findOne({ _id: todayKey });
          if (!alreadySaved) {
            const items = await fetchTallyStock();
            if (items.length > 0) {
              const totalValue = items.reduce((s, i) => s + (i.value || 0), 0);
              await dbS.collection('tally_stock_history').replaceOne(
                { _id: todayKey },
                { _id: todayKey, date: now, month: todayKey.slice(0, 7), totalValue, auto: true },
                { upsert: true }
              );
              console.log(`[stock] Auto-saved snapshot for ${todayKey}: ₹${Math.round(totalValue).toLocaleString('en-IN')}`);
            }
          }
        } catch(e) { console.error('[stock] Auto-snapshot error:', e.message); }
      });
    }
  } catch(e) {
    result = {
      connected: false, company: TALLY_COMPANY || '',
      error: (e.cause?.code === 'ECONNREFUSED' || e.message.includes('ECONNREFUSED') || e.name === 'AbortError')
        ? `Cannot reach Tally at ${TALLY_BASE} — open TallyPrime and enable HTTP server (F12 → Advanced Config → port 9000)`
        : e.message,
      tallyUrl: TALLY_BASE,
      totalSales: 0, totalPurchases: 0, totalExpenses: 0, totalOutstanding: 0,
      cashBalance: 0, bankBalance: 0, supplierDues: 0,
      debtors: [], creditors: [], recentVouchers: []
    };
    const snapshot = await loadTallySnapshot();
    if (snapshot) {
      fromCache = true;
      syncedAt  = snapshot.syncedAt;
      result    = { ...result, ...snapshot, connected: false, error: result.error, _id: undefined, syncedAt: undefined };
    } else {
      // No snapshot yet — try to read syncedAt from MongoDB metadata
      try {
        const dbMeta = await getMongoDb();
        if (dbMeta) {
          const meta = await dbMeta.collection('tally_snapshots').findOne({ _id: 'main' });
          if (meta?.syncedAt) { fromCache = true; syncedAt = meta.syncedAt; }
        }
      } catch(_) {}
    }
  }

  // ── MongoDB: period + enhanced data ────────────────────────
  let periodSales = 0, periodPurchases = 0, periodCollections = 0, periodPayments = 0;
  let periodVouchers   = [];
  let monthlyTrend     = [];
  let debtors          = result.debtors   || [];
  let creditors        = result.creditors || [];
  let expenseBreakdown = [];
  let openingStock = 0, closingStock = 0;
  let openingStockDate = null, closingStockDate = null;
  let hasValidStockRange = false;
  let refStockValue = null, refStockDate = null;
  let topCustSales     = [];
  let topSuppPurchase  = [];
  let stockItems       = [];
  let totalStockValue  = 0;
  let hasDbData        = false;

  const db = await getMongoDb();
  if (db) {
    hasDbData = true;

    // Period vouchers — MongoDB first, live Tally fallback if empty
    let pv = await db.collection('tally_vouchers').find(periodQuery).sort({ date: -1 }).toArray();

    // MongoDB has no data for this period (e.g. new FY) — fetch live from Tally + filter by date in JS
    if (pv.length === 0 && result.connected) {
      try {
        const liveXml = await tallyCollection('PeriodVouchers', `
<COLLECTION NAME="PeriodVouchers" ISMODIFY="No">
  <TYPE>Voucher</TYPE>
  <FETCH>Date,VoucherNumber,VoucherTypeName,PartyLedgerName,Amount,Narration</FETCH>
</COLLECTION>`, { fromDate: customFrom, toDate: customTo });
        // Always filter in JS — Tally ignores SVFROMDATE/SVTODATE
        const live = parseVouchersFromXml(liveXml)
          .filter(v => v.dateStr >= customFrom && v.dateStr <= customTo);
        if (live.length > 0) {
          pv = live;
          // Save to MongoDB so next page load is instant
          const ops = live.map(v => ({ replaceOne: { filter: { _id: v._id }, replacement: v, upsert: true } }));
          db.collection('tally_vouchers').bulkWrite(ops, { ordered: false }).catch(() => {});
        }
      } catch(_) { /* Tally live fetch failed — stay with empty */ }
    }

    periodVouchers    = pv;
    const isCollection = v => (v.type === 'Journal' || /receipt/i.test(v.type)) && !/stock journal/i.test(v.type);
    periodSales       = pv.filter(v => /sales/i.test(v.type)).reduce((s,v) => s + (v.amount||0), 0);
    periodPurchases   = pv.filter(v => /purchase/i.test(v.type)).reduce((s,v) => s + (v.amount||0), 0);
    periodCollections = pv.filter(isCollection).reduce((s,v) => s + (v.amount||0), 0);
    periodPayments    = pv.filter(v => /payment/i.test(v.type)).reduce((s,v) => s + (v.amount||0), 0);

    // Monthly trend — last 6 months from MongoDB
    const sixAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);
    const trend  = await db.collection('tally_vouchers').aggregate([
      { $match: { date: { $gte: sixAgo } } },
      { $group: { _id: { month: '$month', type: '$type' }, total: { $sum: '$amount' } } }
    ]).toArray();
    const tMap = {};
    // If current month missing from DB trend (new FY), inject from the live pv we just fetched
    const curMonthKey = now.toISOString().slice(0, 7);
    trend.forEach(row => {
      const m = row._id.month;
      if (!tMap[m]) tMap[m] = { month: m, sales: 0, collections: 0, purchases: 0, payments: 0 };
      if (/sales/i.test(row._id.type))                                    tMap[m].sales       += row.total;
      if (row._id.type === 'Journal' || /receipt/i.test(row._id.type))    tMap[m].collections += row.total;
      if (/purchase/i.test(row._id.type))                                 tMap[m].purchases   += row.total;
      if (/payment/i.test(row._id.type))                                  tMap[m].payments    += row.total;
    });
    if (!tMap[curMonthKey] && pv.length > 0) {
      tMap[curMonthKey] = {
        month: curMonthKey,
        sales:       pv.filter(v => /sales/i.test(v.type)).reduce((s,v) => s+(v.amount||0), 0),
        collections: pv.filter(v => v.type==='Journal'||/receipt/i.test(v.type)).reduce((s,v) => s+(v.amount||0), 0),
        purchases:   pv.filter(v => /purchase/i.test(v.type)).reduce((s,v) => s+(v.amount||0), 0),
        payments:    pv.filter(v => /payment/i.test(v.type)).reduce((s,v) => s+(v.amount||0), 0),
      };
    }
    monthlyTrend = Object.values(tMap).sort((a,b) => a.month.localeCompare(b.month));

    // Debtors + creditors with last payment dates from tally_ledgers
    const allLedgers = await db.collection('tally_ledgers')
      .find({ type: { $in: ['debtor','creditor'] } }).toArray();
    const dbDebtors   = allLedgers.filter(l => l.type === 'debtor'   && l.balance > 0).sort((a,b) => b.balance - a.balance);
    const dbCreditors = allLedgers.filter(l => l.type === 'creditor' && l.balance > 0).sort((a,b) => b.balance - a.balance);
    if (dbDebtors.length)   debtors   = dbDebtors;
    if (dbCreditors.length) creditors = dbCreditors;

    // YTD P&L figures — all from tally_ledgers so they're from the SAME sync point in time
    // (live Tally mixes FY periods; ledgers are always consistent with each other)
    const [expLedgers, salesLedgers, purchLedgers] = await Promise.all([
      db.collection('tally_ledgers').find({ type: 'expense',  balance: { $gt: 0 } }).sort({ balance: -1 }).toArray(),
      db.collection('tally_ledgers').find({ type: 'sales' }).toArray(),
      db.collection('tally_ledgers').find({ type: 'purchase', balance: { $gt: 0 } }).toArray(),
    ]);

    // Expense breakdown (YTD ledger balances)
    expenseBreakdown = expLedgers;

    // Derive consistent YTD totals — override live Tally values which may be period-mismatched
    const dbTotalExpenses  = expLedgers.reduce((s, l) => s + (l.balance || 0), 0);
    const dbTotalSales     = salesLedgers.reduce((s, l) => s + Math.abs(l.balance || 0), 0); // sales are Cr → negative balance stored
    const dbTotalPurchases = purchLedgers.reduce((s, l) => s + (l.balance || 0), 0);

    if (dbTotalExpenses  > 0) result.totalExpenses  = dbTotalExpenses;
    if (dbTotalSales     > 0) result.totalSales     = dbTotalSales;
    if (dbTotalPurchases > 0) result.totalPurchases = dbTotalPurchases;

    // Top customers by collections this period (Journal = money received)
    topCustSales = await db.collection('tally_vouchers').aggregate([
      { $match: { ...periodQuery, type: { $in: ['Sales', 'Journal', 'Receipt'] }, party: { $gt: '' } } },
      { $group: { _id: '$party', total: { $sum: '$amount' } } },
      { $sort: { total: -1 } }, { $limit: 10 }
    ]).toArray();

    // Top suppliers by purchases this period
    topSuppPurchase = await db.collection('tally_vouchers').aggregate([
      { $match: { ...periodQuery, type: { $regex: /purchase/i }, party: { $gt: '' } } },
      { $group: { _id: '$party', total: { $sum: '$amount' } } },
      { $sort: { total: -1 } }, { $limit: 10 }
    ]).toArray();

    // Stock from tally_stock collection
    stockItems      = await db.collection('tally_stock').find({}).sort({ value: -1 }).limit(25).toArray();
    totalStockValue = stockItems.reduce((s, i) => s + (i.value || 0), 0);

    // Opening & closing stock for selected period.
    // Opening stock = closing stock of the month BEFORE the period starts.
    // Closing stock = closing stock of the month in which the period ends.
    // Primary source: tally_stock_monthly (seeded historically + auto-saved on every sync).
    // Fallback: tally_stock_history (daily snapshots, for backwards compat).
    const stockHistory = db.collection('tally_stock_history');
    const stockMonthly = db.collection('tally_stock_monthly');

    // Compute the "previous month" key for opening stock
    const [_psY, _psM] = periodStartDate.slice(0, 7).split('-').map(Number);
    const _prevMon     = new Date(_psY, _psM - 2, 1); // JS handles month=-1 → Dec prev year
    const openMonKey   = `${_prevMon.getFullYear()}-${String(_prevMon.getMonth()+1).padStart(2,'0')}`;
    const closeMonKey  = periodEndDate.slice(0, 7);

    const [_openMon, _closeMon, _latestMon, _latestSnaps] = await Promise.all([
      stockMonthly.findOne({ _id: openMonKey }),
      stockMonthly.findOne({ _id: closeMonKey }),
      stockMonthly.find({}).sort({ _id: -1 }).limit(1).toArray(),
      stockHistory.find({}).sort({ _id: -1 }).limit(1).toArray(),
    ]);

    if (_openMon || _closeMon) {
      // Use monthly records (primary path — always correct after seeding)
      openingStock     = _openMon  ? (_openMon.stockValue  ?? 0) : 0;
      closingStock     = _closeMon ? (_closeMon.stockValue ?? 0) : 0;
      openingStockDate = _openMon  ? _openMon.month  : null;
      closingStockDate = _closeMon ? _closeMon.month : null;
      hasValidStockRange = !!(_openMon && _closeMon);
    } else {
      // Fallback: daily tally_stock_history snapshots
      const [_oBefore, _cBefore] = await Promise.all([
        stockHistory.find({ _id: { $lte: periodStartDate } }).sort({ _id: -1 }).limit(1).toArray(),
        stockHistory.find({ _id: { $lte: periodEndDate   } }).sort({ _id: -1 }).limit(1).toArray(),
      ]);
      const _oSnap = _oBefore[0] || null;
      const _cSnap = _cBefore[0] || null;
      hasValidStockRange = !!(_oSnap && _cSnap && _oSnap._id !== _cSnap._id);
      openingStock     = hasValidStockRange ? (_oSnap.totalValue ?? 0) : 0;
      closingStock     = hasValidStockRange ? (_cSnap.totalValue ?? 0) : 0;
      openingStockDate = hasValidStockRange ? _oSnap._id : null;
      closingStockDate = hasValidStockRange ? _cSnap._id : null;
    }

    // Reference stock — latest available snapshot (for GP modal reference card)
    const _refMon = _latestMon[0] || null;
    const _refHis = _latestSnaps[0] || null;
    refStockValue = _refMon ? (_refMon.stockValue ?? null) : (_refHis ? (_refHis.totalValue ?? null) : null);
    refStockDate  = _refMon ? _refMon._id : (_refHis ? _refHis._id : null);

    hasDbData = monthsWithData.length > 0;

    // YTD fallback: if Tally is offline and snapshot has no totals, compute from MongoDB
    if (!result.connected && (!result.totalSales || result.totalSales === 0)) {
      const fyStart = now.getMonth() >= 3
        ? `${now.getFullYear()}-04-01`
        : `${now.getFullYear() - 1}-04-01`;
      const ytd = await db.collection('tally_vouchers')
        .find({ dateStr: { $gte: fyStart } }).toArray();
      if (ytd.length > 0) {
        result.totalSales     = ytd.filter(v => /sales/i.test(v.type)).reduce((s,v) => s + (v.amount||0), 0);
        result.totalPurchases = ytd.filter(v => /purchase/i.test(v.type)).reduce((s,v) => s + (v.amount||0), 0);
        // Expenses don't have their own voucher type in Tally (they're Journal entries)
        // Use ledger balances from tally_ledgers instead — already loaded in expenseBreakdown
      }
    }

  }

  const totalOutstanding = debtors.reduce((s,d) => s + (d.balance||0), 0);
  const supplierDues     = creditors.reduce((s,c) => s + (c.balance||0), 0);

  // Receivables aging buckets (from lastPaymentDate as proxy)
  const aging = { a0:{count:0,amt:0}, a30:{count:0,amt:0}, a60:{count:0,amt:0}, a90:{count:0,amt:0} };
  debtors.forEach(d => {
    const ds = d.lastPaymentDate
      ? Math.floor((Date.now() - new Date(d.lastPaymentDate).getTime()) / 86400000)
      : 999;
    const key = ds <= 30 ? 'a0' : ds <= 60 ? 'a30' : ds <= 90 ? 'a60' : 'a90';
    aging[key].count++;
    aging[key].amt += d.balance || 0;
  });

  res.render('tally', {
    ...c, active: 'tally', ...result,
    fromCache, syncedAt, selMonth,
    isCustomRange, customFrom, customTo, periodLabel,
    periodSales, periodPurchases, periodCollections, periodPayments,
    periodVouchers, monthlyTrend,
    debtors, creditors, totalOutstanding, supplierDues,
    expenseBreakdown, topCustSales, topSuppPurchase,
    stockItems, totalStockValue, openingStock, closingStock, openingStockDate, closingStockDate,
    hasValidStockRange, refStockValue, refStockDate, aging, hasDbData, monthsWithData
  });
});

// Block all Tally API routes for limited-role users
app.use('/api/tally', (req, res, next) => {
  if (req.session.role === 'limited') return res.status(403).json({ ok: false, error: 'Access denied' });
  next();
});

// Diagnostic — show all voucher types in DB so we can tune filters
app.get('/api/tally/voucher-types', async (req, res) => {
  const db = await getMongoDb();
  if (!db) return res.json({ error: 'No DB' });
  const types = await db.collection('tally_vouchers').aggregate([
    { $group: { _id: '$type', count: { $sum: 1 }, total: { $sum: '$amount' } } },
    { $sort: { count: -1 } }
  ]).toArray();
  res.json(types);
});

// ── Manual stock snapshot for a specific date (or today) ─────
// POST /api/tally/stock-snapshot?date=YYYY-MM-DD
app.post('/api/tally/stock-snapshot', async (req, res) => {
  try {
    const dateKey  = (req.query.date || req.body?.date || new Date().toISOString().slice(0, 10)).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return res.status(400).json({ ok: false, error: 'Invalid date' });
    const monthKey = dateKey.slice(0, 7); // 'YYYY-MM'
    const items    = await fetchTallyStock();
    if (!items.length) return res.status(500).json({ ok: false, error: 'No stock items returned from Tally' });
    const totalValue = items.reduce((s, i) => s + (i.value || 0), 0);
    const db = await getMongoDb();
    if (!db) return res.status(500).json({ ok: false, error: 'MongoDB unavailable' });
    const now = new Date();
    // Save to daily history
    await db.collection('tally_stock_history').replaceOne(
      { _id: dateKey },
      { _id: dateKey, date: now, month: monthKey, totalValue, itemCount: items.length },
      { upsert: true }
    );
    // Save to monthly collection — GP modal reads from here
    await db.collection('tally_stock_monthly').replaceOne(
      { _id: monthKey },
      { _id: monthKey, month: monthKey, stockValue: totalValue, syncDate: dateKey, syncedAt: now, itemCount: items.length },
      { upsert: true }
    );
    res.json({ ok: true, date: dateKey, month: monthKey, totalValue, items: items.length });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Gross Profit API — month-by-month data for the GP modal ──
// GET /api/tally/gross-profit?month=YYYY-MM
app.get('/api/tally/gross-profit', async (req, res) => {
  try {
    const db = await getMongoDb();
    if (!db) return res.status(503).json({ ok: false, error: 'MongoDB unavailable' });

    const now = new Date();
    const curMonthStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;

    // Validate / default requested month
    const rawMonth = String(req.query.month || curMonthStr);
    const month    = /^\d{4}-\d{2}$/.test(rawMonth) ? rawMonth : curMonthStr;
    const [my, mm] = month.split('-').map(Number);
    const firstDay = `${month}-01`;
    const lastDay  = new Date(my, mm, 0).toISOString().slice(0, 10); // last day of month

    // Build list of last 20 months for the selector (newest first)
    const availableMonths = [];
    for (let i = 0; i < 20; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      availableMonths.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`);
    }

    const stockMonthly = db.collection('tally_stock_monthly');
    const stockHistory = db.collection('tally_stock_history');
    const vouchersCol  = db.collection('tally_vouchers');

    // Previous month key (opening stock = closing stock of prev month)
    const prevMonthDate = new Date(my, mm - 2, 1); // mm is 1-based, -2 goes back 1 month
    const prevMonth     = `${prevMonthDate.getFullYear()}-${String(prevMonthDate.getMonth()+1).padStart(2,'0')}`;

    // Parallel: voucher totals + monthly stock records (primary) + daily history fallback
    const [salesAgg, openingMonthly, closingMonthly, latestMonthly] = await Promise.all([
      vouchersCol.aggregate([
        { $match: { dateStr: { $gte: firstDay, $lte: lastDay } } },
        { $group: { _id: '$type', total: { $sum: '$amount' } } }
      ]).toArray(),
      // Opening stock = the monthly record for the PREVIOUS month
      stockMonthly.findOne({ _id: prevMonth }),
      // Closing stock = the monthly record for THIS month
      stockMonthly.findOne({ _id: month }),
      // Latest sync ever (for reference card)
      stockMonthly.find({}).sort({ _id: -1 }).limit(1).toArray()
    ]);

    // Aggregate voucher totals
    let sales = 0, purchases = 0, collections = 0, payments = 0;
    for (const row of salesAgg) {
      const t = (row._id || '').toLowerCase();
      if (t.includes('sales'))                            sales       += row.total;
      else if (t.includes('purchase'))                    purchases   += row.total;
      else if (t === 'journal' || t.includes('receipt'))  collections += row.total;
      else if (t.includes('payment'))                     payments    += row.total;
    }

    // --- Stock from tally_stock_monthly only (no live Tally fetch — avoids crashes) ---
    // Opening stock = closing stock of PREVIOUS month  → tally_stock_monthly[prevMonth]
    // Closing stock = closing stock of THIS month       → tally_stock_monthly[month]
    // Both are seeded historically and auto-saved on every sync going forward.
    let openingStock = 0, closingStock = 0;
    let openingStockDate = null, closingStockDate = null;
    let hasStockData = false;
    let stockSource = 'db';

    if (openingMonthly || closingMonthly) {
      openingStock     = openingMonthly ? (openingMonthly.stockValue ?? 0) : 0;
      closingStock     = closingMonthly ? (closingMonthly.stockValue  ?? 0) : 0;
      openingStockDate = openingMonthly ? `${openingMonthly.month} (synced ${openingMonthly.syncDate})` : null;
      closingStockDate = closingMonthly ? `${closingMonthly.month} (synced ${closingMonthly.syncDate})` : null;
      hasStockData     = !!(openingMonthly && closingMonthly);
      stockSource      = 'db';
    } else {
      // Last-resort fallback: tally_stock_history (daily snapshots)
      const [_oSnaps, _cSnaps] = await Promise.all([
        stockHistory.find({ _id: { $lte: firstDay } }).sort({ _id: -1 }).limit(1).toArray(),
        stockHistory.find({ _id: { $lte: lastDay  } }).sort({ _id: -1 }).limit(1).toArray(),
      ]);
      const _oSnap = _oSnaps[0] || null;
      const _cSnap = _cSnaps[0] || null;
      if (_oSnap && _cSnap && _oSnap._id !== _cSnap._id) {
        hasStockData     = true;
        openingStock     = _oSnap.totalValue ?? 0;
        closingStock     = _cSnap.totalValue  ?? 0;
        openingStockDate = _oSnap._id;
        closingStockDate = _cSnap._id;
        stockSource      = 'db';
      }
    }

    // Gross Profit = Sales − Opening Stock − Purchases + Closing Stock
    const grossProfit = sales - openingStock - purchases + closingStock;
    const grossMargin = sales > 0 ? Math.round(grossProfit / sales * 100) : 0;

    // Latest sync for reference card — prefer monthly, then daily
    const latestRef = latestMonthly[0] || null;

    // Which months have monthly stock records (for status info)
    const stockMonths = await stockMonthly.distinct('_id');

    res.json({
      ok: true,
      month, firstDay, lastDay, prevMonth,
      sales, purchases, collections, payments,
      openingStock, openingStockDate,
      closingStock,  closingStockDate,
      hasStockData,
      hasOpeningRecord: !!openingMonthly,
      hasClosingRecord: !!closingMonthly,
      stockSource,   // 'db' | 'none'
      grossProfit, grossMargin,
      refStockValue: latestRef ? (latestRef.stockValue ?? null) : null,
      refStockDate:  latestRef ? latestRef.syncDate : null,
      stockMonths,
      availableMonths
    });
  } catch(e) {
    console.error('[GP API]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Sync button — full save: snapshot + ledgers + current+prev month vouchers + stock
app.post('/api/tally/sync', async (req, res) => {
  try {
    const syncedAt = new Date();
    const today    = syncedAt.toISOString().slice(0, 10);

    // Current month start
    const curMonthStart = `${syncedAt.getFullYear()}-${String(syncedAt.getMonth()+1).padStart(2,'0')}-01`;
    // Previous month start (for catching late/backdated entries)
    const prevD = new Date(syncedAt.getFullYear(), syncedAt.getMonth() - 1, 1);
    const prevMonthStart = `${prevD.getFullYear()}-${String(prevD.getMonth()+1).padStart(2,'0')}-01`;
    const prevMonthEnd   = new Date(syncedAt.getFullYear(), syncedAt.getMonth(), 0).toISOString().slice(0,10);

    // ── 1. Live Tally summary snapshot ────────────────────────
    const data = await fetchLiveTallyData();
    await saveTallySnapshot({ ...data, syncedAt });

    const db = await getMongoDb();
    if (db) {
      // ── 2. All ledgers (current balances) ───────────────────
      const ledXml = await tallyCollection('SyncLedgers', `
<COLLECTION NAME="SyncLedgers" ISMODIFY="No">
  <TYPE>Ledger</TYPE>
  <FETCH>Name,Parent,ClosingBalance</FETCH>
</COLLECTION>`);
      const ledgers = parseLedgersFromXml(ledXml);
      if (ledgers.length > 0) {
        const ops = ledgers.map(l => ({ replaceOne: { filter: { _id: l._id }, replacement: { ...l, updatedAt: syncedAt }, upsert: true } }));
        await db.collection('tally_ledgers').bulkWrite(ops, { ordered: false });
      }

      // ── 3. Current month vouchers (full, not just today) ────
      const vXmlCur = await tallyCollection('SyncVouchersCur', `
<COLLECTION NAME="SyncVouchersCur" ISMODIFY="No">
  <TYPE>Voucher</TYPE>
  <FETCH>Date,VoucherNumber,VoucherTypeName,PartyLedgerName,Amount,Narration</FETCH>
</COLLECTION>`, { fromDate: curMonthStart, toDate: today });
      const vCur = parseVouchersFromXml(vXmlCur);

      // ── 4. Previous month vouchers (catches late entries) ───
      const vXmlPrev = await tallyCollection('SyncVouchersPrev', `
<COLLECTION NAME="SyncVouchersPrev" ISMODIFY="No">
  <TYPE>Voucher</TYPE>
  <FETCH>Date,VoucherNumber,VoucherTypeName,PartyLedgerName,Amount,Narration</FETCH>
</COLLECTION>`, { fromDate: prevMonthStart, toDate: prevMonthEnd });
      const vPrev = parseVouchersFromXml(vXmlPrev);

      const allVouchers = [...vCur, ...vPrev];
      if (allVouchers.length > 0) {
        await db.collection('tally_vouchers').deleteMany({ month: { $in: [curMonthStart.slice(0, 7), prevMonthStart.slice(0, 7)] } });
        const ops = allVouchers.map(v => ({ replaceOne: { filter: { _id: v._id }, replacement: v, upsert: true } }));
        await db.collection('tally_vouchers').bulkWrite(ops, { ordered: false });
      }

      // ── 5. Update last payment dates ────────────────────────
      await updateLastPaymentDates(db);

      // ── 6. Stock items + save daily + monthly stock snapshots ──
      try {
        const stockItems = await fetchTallyStock();
        if (stockItems.length > 0) {
          const ops = stockItems.map(s => ({ replaceOne: { filter: { _id: s._id }, replacement: s, upsert: true } }));
          await db.collection('tally_stock').bulkWrite(ops, { ordered: false });
          const totalValue = stockItems.reduce((s, i) => s + (i.value || 0), 0);
          const curMonth   = today.slice(0, 7); // 'YYYY-MM'
          // Daily snapshot (fine-grained, used as fallback)
          await db.collection('tally_stock_history').replaceOne(
            { _id: today },
            { _id: today, date: syncedAt, month: curMonth, totalValue, itemCount: stockItems.length },
            { upsert: true }
          );
          // Monthly snapshot — one record per month, always overwritten with latest sync
          // GP modal reads: opening stock of M = tally_stock_monthly[M-1]
          //                 closing stock of M = tally_stock_monthly[M]
          await db.collection('tally_stock_monthly').replaceOne(
            { _id: curMonth },
            { _id: curMonth, month: curMonth, stockValue: totalValue, syncDate: today, syncedAt, itemCount: stockItems.length },
            { upsert: true }
          );
          console.log(`[stock] Saved monthly snapshot for ${curMonth}: ₹${Math.round(totalValue).toLocaleString('en-IN')}`);
        }
      } catch(e) { console.error('Stock sync error:', e.message); }

      // ── 7. Save sync metadata so offline mode knows last sync time
      await db.collection('tally_snapshots').updateOne(
        { _id: 'main' },
        { $set: { syncedAt, ledgerCount: ledgers.length, voucherCount: allVouchers.length } },
        { upsert: true }
      );
    }

    res.json({
      ok: true, syncedAt,
      dateKey: today,
      label: syncedAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ════════════════════════════════════════════════════════
//  START
// ════════════════════════════════════════════════════════
// Returns [today, yesterday, ..., n-1 days ago] — newest first, no overflow into wrong bucket
function buildMonthlyCounts(items) {
  const now = new Date();
  const months = [];
  let y = 2025, m = 12;
  while (y < now.getFullYear() || (y === now.getFullYear() && m <= now.getMonth() + 1)) {
    const key   = `${y}-${String(m).padStart(2,'0')}`;
    const label = new Date(y, m - 1, 1).toLocaleString('en', { month: 'short', year: '2-digit' });
    months.push({ key, label, count: 0, value: 0 });
    if (++m > 12) { m = 1; y++; }
  }
  const mMap = {};
  months.forEach(e => { mMap[e.key] = e; });
  items.forEach(r => {
    const ym = (r.moment || '').slice(0, 7);
    if (mMap[ym]) { mMap[ym].count++; mMap[ym].value += Math.round((r.sum||0)/100); }
  });
  return months; // oldest → newest (left → right)
}

function buildDailyCounts(items, n) {
  const map = {};
  items.forEach(r => {
    const date = (r.moment || '').slice(0, 10);
    if (date) {
      if (!map[date]) map[date] = { count: 0, value: 0 };
      map[date].count++;
      map[date].value += Math.round((r.sum||0)/100);
    }
  });
  const now = new Date();
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    return map[localDateStr(d)] || { count: 0, value: 0 };
  });
}

function getLocalIP() {
  const { networkInterfaces } = require('os');
  for (const ifaces of Object.values(networkInterfaces()))
    for (const i of ifaces) if (i.family === 'IPv4' && !i.internal) return i.address;
  return 'your-ip';
}

function startServer(port) {
  const server = app.listen(port, '0.0.0.0');

  server.on('listening', () => {
    const ip = getLocalIP();
    console.log(`\n  PLATINA running`);
    console.log(`  Local:   http://localhost:${port}`);
    console.log(`  Network: http://${ip}:${port}\n`);

  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`  Port ${port} is in use, trying ${port + 1}...`);
      server.close();
      startServer(port + 1);
    } else {
      throw err;
    }
  });
}

startServer(Number(PORT));
