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
    const raw    = `${dateStr}|${type}|${num || (party + '|' + amount)}`;
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

// ── Auth credentials ─────────────────────────────────────
const PASSCODE = process.env.PASSCODE || '1990';

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
      .filter(r => !/dispatched|отгруж|declin|cancel|отмен|отклон|аннул/.test(resolveState(r, stateMapVal).toLowerCase()))
      .map(o => o.id);
    if (pendingIds.length) await getPendingPCS(pendingIds).catch(() => {});
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
  res.locals.active    = '';
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

    // Pending = NOT dispatched / declined / cancelled.
    // "ready to dispatch" stays pending. Declined/cancelled are excluded.
    const pendingOrders = orders.filter(r => {
      const s = resolveState(r, stateMap).toLowerCase();
      return !/dispatched|отгруж|declin|cancel|отмен|отклон|аннул/.test(s);
    });
    const pending = pendingOrders.length;

    // Count by actual state name for card sub-label
    const stateCountMap = {};
    pendingOrders.forEach(r => {
      const s = resolveState(r, stateMap) || '—';
      stateCountMap[s] = (stateCountMap[s] || 0) + 1;
    });
    const pendingStates = Object.entries(stateCountMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
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
      salesToday: salesToday/100, shipmentsToday,
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
        const diff = Math.floor((new Date(demand.moment) - new Date(createdDate)) / 86400000);
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
      const r = await ms('/entity/employee?limit=100');
      const map = {};
      (r.rows || []).forEach(e => {
        const uuid = (e.meta?.href || '').split('/').pop().split('?')[0];
        if (uuid) map[uuid] = e.name || e.shortFio || e.uid || '—';
      });
      return map;
    });

    // Fetch customerOrders and demands for the period in parallel.
    // Demands filter uses the same start but extends the end by 45 days to catch
    // shipments created shortly after the period (e.g. order Jan 31, shipped Feb 2).
    const ordUrl = `/entity/customerorder?${filterStr ? 'filter='+enc(filterStr)+'&' : ''}expand=agent&order=moment,desc`;
    const demParts = [];
    if (momentFrom) demParts.push(`moment>${momentFrom}`);
    if (momentTo) {
      const bufDate = new Date(momentTo.slice(0, 10));
      bufDate.setDate(bufDate.getDate() + 45);
      demParts.push(`moment<${localDateStr(bufDate)} 00:00:00`);
    }
    const demFilterStr = demParts.join(';');
    const demUrl = `/entity/demand?${demFilterStr ? 'filter='+enc(demFilterStr)+'&' : ''}order=moment,desc`;

    const [{ rows: orders }, { rows: demands }] = await Promise.all([
      msAll(ordUrl),
      msAll(demUrl)
    ]);

    // Build a Set of customerOrder IDs that have at least one demand (shipment created).
    const shippedOrderIds = new Set();
    demands.forEach(d => {
      const href = d.customerOrder?.meta?.href || '';
      if (!href) return;
      const oid = href.split('/').pop().split('?')[0];
      if (oid) shippedOrderIds.add(oid);
    });

    // Only count orders where a shipment has actually been created.
    const shippedOrders   = orders.filter(o =>  shippedOrderIds.has(o.id));
    const unshippedRaw    = orders.filter(o => !shippedOrderIds.has(o.id));

    // Fetch positions for each unshipped order (batches of 20) to get PCS count.
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

    // Aggregate by salesman (customerOrder.owner)
    const smMap = {};
    shippedOrders.forEach(order => {
      const ownerUUID = (order.owner?.meta?.href || '').split('/').pop().split('?')[0];
      const name      = ownerUUID ? (empMap[ownerUUID] || 'Unassigned') : 'Unassigned';
      const val       = (order.sum || 0) / 100;
      const date      = (order.moment || '').slice(0, 10);
      const customer  = order.agent?.name || '—';
      const orderName = order.name || '—';
      const state     = order.state?.name || '—';

      if (!smMap[name]) smMap[name] = { name, orders: 0, totalVal: 0, orderList: [] };
      smMap[name].orders++;
      smMap[name].totalVal += val;
      smMap[name].orderList.push({ name: orderName, orderName, date, customer, val, state });
    });

    const salesmen = Object.values(smMap)
      .map(s => ({
        name:      s.name,
        orders:    s.orders,
        shipments: s.orders,   // kept for template compatibility
        totalVal:  s.totalVal,
        avgVal:    s.orders > 0 ? s.totalVal / s.orders : 0,
        orderList: s.orderList.sort((a, b) => new Date(b.date) - new Date(a.date))
      }))
      .sort((a, b) => b.totalVal - a.totalVal);

    const chartTop = salesmen.slice(0, 10);
    res.render('salesman', {
      ...c, active: 'salesman',
      salesmen, period, months,
      totalOrders: shippedOrders.length,
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

    // Fetch orders with positions expanded (to get actual qty per customer)
    // and total counterparty count in parallel
    const filterParts = [];
    if (momentFrom) filterParts.push(`moment>${momentFrom}`);
    if (momentTo)   filterParts.push(`moment<${momentTo}`);
    const filterStr = filterParts.join(';');
    const ordersUrl = `/entity/customerorder?${filterStr ? 'filter='+enc(filterStr)+'&' : ''}expand=agent,positions&limit=100&order=moment,desc`;

    const custOrdKey = `cust_orders_${filterStr}`;
    const [allOrders, totalCustomers] = await Promise.all([
      cached(custOrdKey, 2*60*1000, () => msAll(ordersUrl).then(r => r.rows || [])),
      cached('counterparty_count', 10*60*1000, () => ms('/entity/counterparty?limit=1').then(r => r.meta?.size || 0)),
    ]);

    // Aggregate per customer from orders + their positions
    const custMap = {};
    allOrders.forEach(order => {
      const name = order.agent?.name || '—';
      if (name === '—') return;
      const id = (order.agent?.meta?.href || '').split('/').pop();
      if (!custMap[name]) custMap[name] = { id, name, orders: 0, totalQty: 0, totalVal: 0 };
      custMap[name].orders++;
      custMap[name].totalVal += (order.sum || 0) / 100;
      (order.positions?.rows || []).forEach(pos => {
        custMap[name].totalQty += Math.round(pos.quantity || 0);
      });
    });

    const customers = Object.values(custMap)
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

// ── Chatbot tool: query MoySklad data from MongoDB ────────────────────────
async function toolQueryMoysklad({ data_type = 'demands', period = 'this_month', group_by = 'product', filter, top_n = 15, sort_by = 'revenue' } = {}) {
  try {
    const db = await getMongoDb();
    if (!db) return JSON.stringify({ error: 'MongoDB not connected' });
    const { from, to } = parsePeriodMongo(period);
    const N  = Math.min(+top_n || 15, 200);
    const sf = sort_by === 'quantity' ? 'qty' : sort_by === 'orders' ? 'orders' : 'revenue';

    // ── STOCK ──
    if (data_type === 'stock') {
      let q = {};
      if (filter?.startsWith('status:'))  q.status = filter.slice(7);
      else if (filter?.startsWith('product:')) q.name = { $regex: filter.slice(8), $options: 'i' };
      else if (filter) q.name = { $regex: filter, $options: 'i' };
      const items = await db.collection('ms_stock').find(q).sort({ quantity: -1 }).limit(300).toArray();
      return JSON.stringify({
        data_type: 'stock', syncNote: 'Stock snapshot from last sync',
        summary: { total: items.length, out: items.filter(s=>s.status==='out').length, low: items.filter(s=>s.status==='low').length, ok: items.filter(s=>s.status==='ok').length },
        items: items.slice(0, 100).map(s => ({ name: s.name, qty: s.quantity, status: s.status, price: Math.round(s.price) }))
      });
    }

    // ── CUSTOMERS LIST ──
    if (data_type === 'customers') {
      const q = filter ? { name: { $regex: filter, $options: 'i' } } : {};
      const rows = await db.collection('ms_customers').find(q).limit(N).toArray();
      return JSON.stringify({ data_type: 'customers', count: rows.length, customers: rows.map(r => ({ name: r.name, code: r.code, phone: r.phone, email: r.email })) });
    }

    // ── ORDERS ──
    if (data_type === 'orders') {
      const match = { date: { $gte: from, $lte: to } };
      if (filter?.startsWith('customer:')) match.customerName = { $regex: filter.slice(9), $options: 'i' };
      const orders = await db.collection('ms_orders').find(match).sort({ date: -1 }).limit(N).toArray();
      const agg = await db.collection('ms_orders').aggregate([{ $match: match }, { $group: { _id: null, revenue: { $sum: '$amountRub' }, count: { $sum: 1 } } }]).toArray();
      return JSON.stringify({ period, data_type: 'orders', total: agg[0] || {}, orders: orders.map(o => ({ name: o.name, date: o.date, customer: o.customerName, amount: Math.round(o.amountRub), state: o.stateName })) });
    }

    // ── DEMANDS — aggregations ──
    const dateMatch = { date: { $gte: from, $lte: to } };
    if (filter?.startsWith('customer:')) dateMatch.customerName = { $regex: filter.slice(9), $options: 'i' };
    const productFilter = filter?.startsWith('product:') ? filter.slice(8) : (!filter?.includes(':') && filter ? filter : null);

    if (group_by === 'none' || group_by === 'total') {
      const r = await db.collection('ms_demands').aggregate([{ $match: dateMatch }, { $group: { _id: null, revenue: { $sum: '$amountRub' }, shipments: { $sum: 1 } } }]).toArray();
      return JSON.stringify({ period, from, to, revenue: Math.round(r[0]?.revenue || 0), shipments: r[0]?.shipments || 0 });
    }
    if (group_by === 'customer') {
      const rows = await db.collection('ms_demands').aggregate([
        { $match: dateMatch },
        { $group: { _id: '$customerName', revenue: { $sum: '$amountRub' }, orders: { $sum: 1 } } },
        { $sort: { [sf === 'orders' ? 'orders' : 'revenue']: -1 } }, { $limit: N }
      ]).toArray();
      return JSON.stringify({ period, group_by: 'customer', results: rows.map(r => ({ customer: r._id || '—', revenue: Math.round(r.revenue), orders: r.orders })) });
    }
    if (group_by === 'day') {
      const rows = await db.collection('ms_demands').aggregate([
        { $match: dateMatch },
        { $group: { _id: '$date', revenue: { $sum: '$amountRub' }, shipments: { $sum: 1 } } },
        { $sort: { _id: 1 } }
      ]).toArray();
      return JSON.stringify({ period, group_by: 'day', results: rows.map(r => ({ date: r._id, revenue: Math.round(r.revenue), shipments: r.shipments })) });
    }
    if (group_by === 'month') {
      const rows = await db.collection('ms_demands').aggregate([
        { $match: { date: { $gte: '2024-12-01' } } },
        { $group: { _id: { $substr: ['$date', 0, 7] }, revenue: { $sum: '$amountRub' }, shipments: { $sum: 1 } } },
        { $sort: { _id: 1 } }
      ]).toArray();
      return JSON.stringify({ group_by: 'month', results: rows.map(r => ({ month: r._id, revenue: Math.round(r.revenue), shipments: r.shipments })) });
    }
    // SKU / variant breakdown — unwind positions
    if (group_by === 'sku') {
      const pipeline = [
        { $match: dateMatch }, { $unwind: '$positions' },
        ...(productFilter ? [{ $match: { 'positions.baseName': { $regex: productFilter, $options: 'i' } } }] : []),
        { $group: { _id: '$positions.productName', baseName: { $first: '$positions.baseName' }, variant: { $first: '$positions.variantName' }, qty: { $sum: '$positions.quantity' }, revenue: { $sum: '$positions.amountRub' } } },
        { $sort: { [sf]: -1 } }, { $limit: N }
      ];
      const rows = await db.collection('ms_demands').aggregate(pipeline).toArray();
      const totalQty = rows.reduce((a, r) => a + r.qty, 0);
      return JSON.stringify({ period, group_by: 'sku', total_pcs: Math.round(totalQty), results: rows.map(r => ({ sku: r._id, product: r.baseName, variant: r.variant || '', qty: Math.round(r.qty), revenue: Math.round(r.revenue) })) });
    }
    // Default: product-level (unwind positions, group by baseName)
    const pipeline = [
      { $match: dateMatch }, { $unwind: '$positions' },
      ...(productFilter ? [{ $match: { 'positions.baseName': { $regex: productFilter, $options: 'i' } } }] : []),
      { $group: { _id: '$positions.baseName', qty: { $sum: '$positions.quantity' }, revenue: { $sum: '$positions.amountRub' } } },
      { $sort: { [sf]: -1 } }, { $limit: N }
    ];
    const rows = await db.collection('ms_demands').aggregate(pipeline).toArray();
    return JSON.stringify({ period, group_by: 'product', total_revenue: Math.round(rows.reduce((a,r)=>a+r.revenue,0)), total_pcs: Math.round(rows.reduce((a,r)=>a+r.qty,0)), results: rows.map(r => ({ product: r._id || '—', qty: Math.round(r.qty), revenue: Math.round(r.revenue) })) });
  } catch (e) { return JSON.stringify({ error: e.message }); }
}

// ── Chatbot tool: query Tally data from MongoDB ───────────────────────────
async function toolQueryTally({ data_type = 'snapshot', period, filter } = {}) {
  try {
    if (data_type === 'snapshot' || data_type === 'debtors' || data_type === 'creditors') {
      const snap = await loadTallySnapshot();
      if (!snap) return JSON.stringify({ error: 'No Tally data. Open Financial Dashboard with Tally running to sync.' });
      if (data_type === 'debtors')   return JSON.stringify({ total: Math.round(snap.totalOutstanding||0), debtors: (snap.debtors||[]).map(d=>({ name:d.name, balance:Math.round(d.balance) })) });
      if (data_type === 'creditors') return JSON.stringify({ total: Math.round(snap.supplierDues||0), creditors: (snap.creditors||[]).map(c=>({ name:c.name, balance:Math.round(c.balance) })) });
      return JSON.stringify({
        syncedAt: snap.syncedAt,
        totalSales:       Math.round(snap.totalSales||0),
        totalPurchases:   Math.round(snap.totalPurchases||0),
        totalExpenses:    Math.round(snap.totalExpenses||0),
        netProfit:        Math.round((snap.totalSales-snap.totalPurchases-snap.totalExpenses)||0),
        totalOutstanding: Math.round(snap.totalOutstanding||0),
        supplierDues:     Math.round(snap.supplierDues||0),
        cashBalance:      Math.round(snap.cashBalance||0),
        bankBalance:      Math.round(snap.bankBalance||0),
        debtors:   (snap.debtors||[]).slice(0,15).map(d=>({ name:d.name, balance:Math.round(d.balance) })),
        creditors: (snap.creditors||[]).slice(0,15).map(c=>({ name:c.name, balance:Math.round(c.balance) })),
      });
    }
    const db = await getMongoDb();
    if (!db) return JSON.stringify({ error: 'MongoDB not connected' });
    if (data_type === 'vouchers') {
      const { from, to } = parsePeriodMongo(period || 'this_month');
      const q = { dateStr: { $gte: from.slice(0,10), $lte: to.slice(0,10) } };
      if (filter) q.$or = [{ party: { $regex: filter, $options:'i' } }, { type: { $regex: filter, $options:'i' } }];
      const [vouchers, summary] = await Promise.all([
        db.collection('tally_vouchers').find(q).sort({ dateStr:-1 }).limit(100).toArray(),
        db.collection('tally_vouchers').aggregate([{ $match: q }, { $group: { _id:'$type', count:{ $sum:1 }, total:{ $sum:'$amount' } } }]).toArray()
      ]);
      return JSON.stringify({ period, from: from.slice(0,10), to: to.slice(0,10), count: vouchers.length, vouchers: vouchers.map(v=>({ date:v.dateStr, type:v.type, party:v.party, amount:Math.round(v.amount||0), narration:v.narration })), summary });
    }
    if (data_type === 'ledgers') {
      const q = filter ? { name:{ $regex:filter, $options:'i' } } : {};
      const ledgers = await db.collection('tally_ledgers').find(q).sort({ balance:-1 }).limit(50).toArray();
      return JSON.stringify({ ledgers: ledgers.map(l=>({ name:l.name, type:l.type, balance:Math.round(l.balance||0), lastPayment:l.lastPaymentDate })) });
    }
    return JSON.stringify({ error: `Unknown data_type: ${data_type}` });
  } catch (e) { return JSON.stringify({ error: e.message }); }
}

// ── Chatbot tool: compare Tally vs MoySklad ───────────────────────────────
async function toolCompareSources({ comparison_type = 'sales_total', period } = {}) {
  try {
    const db = await getMongoDb();
    if (!db) return JSON.stringify({ error: 'MongoDB not connected' });

    if (comparison_type === 'sales_total') {
      const { from, to } = parsePeriodMongo(period || 'this_month');
      const [msAgg, tallySnap] = await Promise.all([
        db.collection('ms_demands').aggregate([{ $match: { date:{ $gte:from, $lte:to } } }, { $group:{ _id:null, revenue:{ $sum:'$amountRub' }, shipments:{ $sum:1 } } }]).toArray(),
        loadTallySnapshot()
      ]);
      const msRev     = Math.round(msAgg[0]?.revenue || 0);
      const tallySales= Math.round(tallySnap?.totalSales || 0);
      const diff      = msRev - tallySales;
      return JSON.stringify({
        period, from, to,
        moysklad: { revenue: msRev, shipments: msAgg[0]?.shipments||0 },
        tally:    { sales: tallySales, syncedAt: tallySnap?.syncedAt },
        difference: { amount: diff, note: diff > 0 ? 'MoySklad higher' : diff < 0 ? 'Tally higher' : 'Match' }
      });
    }
    if (comparison_type === 'customer_outstanding') {
      const [tallySnap, msPending] = await Promise.all([
        loadTallySnapshot(),
        db.collection('ms_orders').aggregate([
          { $match: { stateName: { $not: /dispatched|отгружен/i } } },
          { $group: { _id:'$customerName', pendingValue:{ $sum:'$amountRub' }, count:{ $sum:1 } } },
          { $sort: { pendingValue:-1 } }, { $limit:20 }
        ]).toArray()
      ]);
      return JSON.stringify({
        tally_outstanding: { total: Math.round(tallySnap?.totalOutstanding||0), top_debtors: (tallySnap?.debtors||[]).slice(0,10).map(d=>({ name:d.name, balance:Math.round(d.balance) })) },
        moysklad_pending:  { customers: msPending.map(r=>({ customer:r._id, pendingOrders:Math.round(r.pendingValue), count:r.count })) },
        note: 'Tally outstanding = unpaid invoices. MoySklad pending = orders not yet dispatched.'
      });
    }
    if (comparison_type === 'monthly_trend') {
      const [msMonthly, tallyMonthly] = await Promise.all([
        db.collection('ms_demands').aggregate([
          { $match:{ date:{ $gte:'2024-12-01' } } },
          { $group:{ _id:{ $substr:['$date',0,7] }, revenue:{ $sum:'$amountRub' }, orders:{ $sum:1 } } },
          { $sort:{ _id:1 } }
        ]).toArray(),
        db.collection('tally_vouchers').aggregate([
          { $match:{ type:{ $regex:'sales', $options:'i' } } },
          { $group:{ _id:'$month', total:{ $sum:'$amount' }, count:{ $sum:1 } } },
          { $sort:{ _id:1 } }
        ]).toArray().catch(()=>[])
      ]);
      return JSON.stringify({
        moysklad_monthly: msMonthly.map(m=>({ month:m._id, revenue:Math.round(m.revenue), shipments:m.orders })),
        tally_monthly:    tallyMonthly.map(m=>({ month:m._id, sales:Math.round(m.total), vouchers:m.count })),
        note: 'MoySklad = shipment revenue. Tally = sales ledger entries.'
      });
    }
    return JSON.stringify({ error: `Unknown comparison_type: ${comparison_type}` });
  } catch(e) { return JSON.stringify({ error: e.message }); }
}

// ── Build chatbot context from MongoDB (no live API calls) ────────────────
async function buildChatContext() {
  return cached('chatCtx', 15 * 60 * 1000, async () => {
    const now = new Date();
    const daysIntoMonth = now.getDate();
    const today         = todayStr();

    // ── Date boundaries ──────────────────────────────────
    const prevD         = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const curMonthName  = now.toLocaleString('en', { month: 'long', year: 'numeric' });
    const prevMonthName = prevD.toLocaleString('en', { month: 'long', year: 'numeric' });
    const curStart      = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
    const prevStart     = `${prevD.getFullYear()}-${String(prevD.getMonth()+1).padStart(2,'0')}-01`;
    const prevEnd       = localDateStr(new Date(now.getFullYear(), now.getMonth(), 0));

    const fmtS = n => { if(!n)return '₽0'; const a=Math.abs(n); if(a>=1e9)return `₽${(n/1e9).toFixed(2)}B`; if(a>=1e6)return `₽${(n/1e6).toFixed(2)}M`; if(a>=1e3)return `₽${Math.round(n/1e3)}K`; return `₽${Math.round(n).toLocaleString()}`; };
    const pct  = (a,b) => b>0 ? ((a-b)/b*100).toFixed(1)+'%' : 'N/A';

    const db       = await getMongoDb();
    const syncMeta = db ? await db.collection('ms_sync_meta').findOne({ _id:'main' }).catch(()=>null) : null;
    const tallySnap= await loadTallySnapshot().catch(()=>null);

    // ── Parallel MongoDB queries ──────────────────────────
    let stock=[], topProducts=[], topCustomers=[], monthlyHistory=[];
    let curRevenue=0, prevRevenue=0, curShipments=0, prevShipments=0;
    let pendingOrders=[], lowStock=[], outStock=[];

    if (db) {
      const [stkR, curR, prevR, prodR, custR, histR, ordR] = await Promise.allSettled([
        db.collection('ms_stock').find({}).toArray(),
        db.collection('ms_demands').aggregate([{ $match:{ date:{ $gte:curStart } } }, { $group:{ _id:null, revenue:{ $sum:'$amountRub' }, count:{ $sum:1 } } }]).toArray(),
        db.collection('ms_demands').aggregate([{ $match:{ date:{ $gte:prevStart, $lte:prevEnd } } }, { $group:{ _id:null, revenue:{ $sum:'$amountRub' }, count:{ $sum:1 } } }]).toArray(),
        db.collection('ms_demands').aggregate([{ $match:{ date:{ $gte:curStart } } }, { $unwind:'$positions' }, { $group:{ _id:'$positions.baseName', qty:{ $sum:'$positions.quantity' }, revenue:{ $sum:'$positions.amountRub' } } }, { $sort:{ revenue:-1 } }, { $limit:15 }]).toArray(),
        db.collection('ms_demands').aggregate([{ $match:{ date:{ $gte:curStart } } }, { $group:{ _id:'$customerName', revenue:{ $sum:'$amountRub' }, orders:{ $sum:1 } } }, { $sort:{ revenue:-1 } }, { $limit:15 }]).toArray(),
        db.collection('ms_demands').aggregate([{ $match:{ date:{ $gte:'2024-12-01' } } }, { $group:{ _id:{ $substr:['$date',0,7] }, revenue:{ $sum:'$amountRub' }, orders:{ $sum:1 } } }, { $sort:{ _id:1 } }]).toArray(),
        db.collection('ms_orders').find({ stateName:{ $not:/dispatched|отгружен/i } }).sort({ date:-1 }).limit(30).toArray(),
      ]);
      stock          = stkR.status==='fulfilled' ? stkR.value : [];
      curRevenue     = curR.status==='fulfilled'  ? (curR.value[0]?.revenue||0)  : 0;
      curShipments   = curR.status==='fulfilled'  ? (curR.value[0]?.count||0)    : 0;
      prevRevenue    = prevR.status==='fulfilled' ? (prevR.value[0]?.revenue||0) : 0;
      prevShipments  = prevR.status==='fulfilled' ? (prevR.value[0]?.count||0)   : 0;
      topProducts    = prodR.status==='fulfilled' ? prodR.value : [];
      topCustomers   = custR.status==='fulfilled' ? custR.value : [];
      monthlyHistory = histR.status==='fulfilled' ? histR.value : [];
      pendingOrders  = ordR.status==='fulfilled'  ? ordR.value  : [];
      lowStock       = stock.filter(s=>s.status==='low').sort((a,b)=>a.quantity-b.quantity);
      outStock       = stock.filter(s=>s.status==='out').slice(0,20);
    }

    const L   = [];
    const sec = t => L.push('', `── ${t} ──`);

    L.push(
      `You are PLATINA AI — a sharp Business Intelligence assistant.`,
      `Today: ${today} | Month: ${curMonthName} | ${daysIntoMonth} days elapsed | Currency: ₽`,
      `All business data is served from MongoDB (synced from MoySklad). Data available from Dec 2024.`,
      syncMeta
        ? `MoySklad last synced: ${new Date(syncMeta.lastSyncAt).toLocaleString('en-IN')} (${syncMeta.lastSyncType} — ${syncMeta.totalDemands||0} demands, ${syncMeta.totalStock||0} SKUs)`
        : `⚠ MoySklad not synced yet. Run: node sync-ms-data.js`,
      ``,
      `━━━ TOOLS (USE FOR ALL DATA QUESTIONS) ━━━`,
      `1. query_moysklad(data_type, period, group_by, filter, top_n, sort_by)`,
      `   data_type: "demands"|"stock"|"customers"|"orders"`,
      `   group_by:  "product"(model totals) | "sku"(FLAVOUR/VARIANT — use for "sku wise"/"flavour wise") | "customer" | "day" | "month" | "none"`,
      `   period:    "today"|"this_month"|"last_month"|"YYYY-MM"|"YYYY-MM-DD:YYYY-MM-DD"|"all"`,
      `   filter:    "product:NAME" | "customer:NAME" | "status:low" | "status:out"`,
      ``,
      `2. query_tally(data_type, period, filter)`,
      `   data_type: "snapshot"|"debtors"|"creditors"|"vouchers"|"ledgers"`,
      ``,
      `3. compare_sources(comparison_type, period)`,
      `   comparison_type: "sales_total"|"customer_outstanding"|"monthly_trend"`,
      ``,
      `4. web_search(query) — external data only (market trends, regulations, etc.)`,
      ``,
      `━━━ RULES ━━━`,
      `- NEVER call MoySklad API directly. ALL data is in MongoDB — always use tools.`,
      `- For flavour/SKU breakdown → query_moysklad with group_by="sku". Never say it's unavailable.`,
      `- For P&L / outstanding → query_tally with data_type="snapshot".`,
      `- For Tally vs MoySklad difference → compare_sources.`,
      `- Lead with the answer. Use markdown tables for multi-row data. No preamble.`,
      ``,
      `${'═'.repeat(60)}`,
      `LIVE SNAPSHOT`,
      `${'═'.repeat(60)}`
    );

    // Inventory
    sec('INVENTORY');
    L.push(`${stock.length} SKUs | In Stock: ${stock.filter(s=>s.status==='ok').length} | Low (≤100): ${lowStock.length} | Out: ${outStock.length}`);
    if (lowStock.length)  L.push('Low stock: ' + lowStock.slice(0,15).map(s=>`${s.name}(${s.quantity})`).join(', '));
    if (outStock.length)  L.push('Out of stock: ' + outStock.slice(0,15).map(s=>s.name).join(', '));

    // Sales
    sec(`SALES — ${curMonthName}`);
    const mom = prevRevenue>0 ? ` (${pct(curRevenue,prevRevenue)} vs last month)` : '';
    L.push(`Shipments: ${curShipments} | Revenue: ${fmtS(curRevenue)}${mom}`);

    sec(`SALES — ${prevMonthName}`);
    L.push(`Shipments: ${prevShipments} | Revenue: ${fmtS(prevRevenue)}`);

    // Top products
    sec(`TOP PRODUCTS — ${curMonthName}`);
    if (topProducts.length) topProducts.forEach((p,i)=>L.push(`${i+1}. ${p._id||'—'} — ${fmtS(p.revenue)} | ${Math.round(p.qty||0).toLocaleString()} pcs`));
    else L.push('No product data yet — run MoySklad sync first.');

    // Top customers
    sec(`TOP CUSTOMERS — ${curMonthName}`);
    if (topCustomers.length) topCustomers.forEach((c,i)=>L.push(`${i+1}. ${c._id||'—'} — ${fmtS(c.revenue)} | ${c.orders} orders`));
    else L.push('No customer data yet.');

    // Monthly history
    if (monthlyHistory.length) {
      sec('MONTHLY HISTORY (Dec 2024 onwards)');
      monthlyHistory.forEach(m=>{ const d=new Date(m._id+'-02'); L.push(`${d.toLocaleString('en',{month:'short',year:'numeric'})}: ${fmtS(m.revenue)} (${m.orders} shipments)`); });
    }

    // Pending orders
    sec(`PENDING ORDERS (${pendingOrders.length} not dispatched)`);
    if (pendingOrders.length) pendingOrders.slice(0,15).forEach(o=>L.push(`  • ${o.name||'—'} | ${o.customerName||'—'} | ${o.stateName||'—'} | ${fmtS(o.amountRub)}`));
    else L.push('No pending orders.');

    // Tally summary
    if (tallySnap) {
      sec('TALLY FINANCIAL SUMMARY');
      L.push(`Sales: ${fmtS(tallySnap.totalSales)} | Purchases: ${fmtS(tallySnap.totalPurchases)} | Expenses: ${fmtS(tallySnap.totalExpenses)}`);
      L.push(`Net Profit: ${fmtS(tallySnap.totalSales-tallySnap.totalPurchases-tallySnap.totalExpenses)} | Outstanding: ${fmtS(tallySnap.totalOutstanding)} | Supplier Dues: ${fmtS(tallySnap.supplierDues)}`);
      if (tallySnap.debtors?.length) L.push('Top debtors: '+tallySnap.debtors.slice(0,5).map((d,i)=>`${i+1}.${d.name}(${fmtS(d.balance)})`).join(' | '));
      if (tallySnap.syncedAt) L.push(`Tally synced: ${new Date(tallySnap.syncedAt).toLocaleString('en-IN')}`);
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

// ── (legacy helpers kept for dashboard pages — chatbot uses MongoDB) ───────
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
    description: `Query MoySklad business data from MongoDB (fast — no live API calls).

data_type options:
• "demands"   → shipment/sales records. Combine with group_by for breakdowns.
• "orders"    → customer orders (not yet shipped). Use for pending/outstanding orders.
• "stock"     → current inventory levels from latest sync.
• "customers" → customer list/details.

group_by (for demands only):
• "product"  → revenue + qty by product model (fast). Default.
• "sku"      → flavour/variant breakdown (unwinds positions). Use for "sku wise", "flavour wise", "variant wise".
• "customer" → revenue + shipments by customer.
• "day"      → daily trend.
• "month"    → monthly trend across all history.
• "none"     → single total (revenue, count) for the period.

period: "today", "this_month", "last_month", "this_year", "all", "YYYY-MM", "YYYY-MM-DD:YYYY-MM-DD"
filter: partial name match for product or customer (applies to sku/product/customer group_by)
sort_by: "revenue" (default) | "quantity" | "orders"
top_n: max results (default 15, max 200)

RULES:
- "sku wise" / "flavour wise" / "variant wise" / "breakdown" → group_by="sku"
- "which model sold most" / "product totals" → group_by="product"
- "by customer" / "top customers" → group_by="customer" OR data_type="customers"
- "monthly trend" / "month by month" → group_by="month"
- Pending orders / unshipped → data_type="orders"`,
    input_schema: {
      type: 'object',
      properties: {
        data_type: { type: 'string', enum: ['demands', 'orders', 'stock', 'customers'], description: 'Which collection to query' },
        period: { type: 'string', description: '"today","this_month","last_month","this_year","all","YYYY-MM","YYYY-MM-DD:YYYY-MM-DD"' },
        group_by: { type: 'string', enum: ['product', 'sku', 'customer', 'day', 'month', 'none'], description: 'How to aggregate demands. "sku" for flavour detail.' },
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
• "snapshot"  → latest Tally P&L snapshot: totalSales, totalPurchases, grossProfit, collections, outstanding, payables
• "debtors"   → list of customers who owe money (from Tally outstanding)
• "creditors" → list of suppliers owed (from Tally payables)
• "vouchers"  → individual Tally voucher transactions for a period
• "ledgers"   → ledger account balances

Use Tally data for: accounting figures, P&L, collections, outstanding receivables/payables, debtors/creditors.
Use MoySklad (query_moysklad) for: shipment volumes, SKU sales, order tracking, inventory.`,
    input_schema: {
      type: 'object',
      properties: {
        data_type: { type: 'string', enum: ['snapshot', 'debtors', 'creditors', 'vouchers', 'ledgers'], description: 'Which Tally data to fetch' },
        period: { type: 'string', description: 'Period for vouchers/ledgers: "this_month","last_month","YYYY-MM","YYYY-MM-DD:YYYY-MM-DD"' },
        filter: { type: 'string', description: 'Filter by ledger/party name (partial match)' }
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
let _msSyncRunning = false;

app.post('/api/ms/sync', async (req, res) => {
  if (_msSyncRunning) return res.json({ ok: false, message: 'Sync already running' });
  res.json({ ok: true, message: 'Sync started' });
  _msSyncRunning = true;
  try {
    const { runSync } = require('./sync-ms-data');
    await runSync({ verbose: true });
    console.log('[MS sync] completed');
  } catch (e) {
    console.error('[MS sync] failed:', e.message);
  } finally {
    _msSyncRunning = false;
  }
});

app.get('/api/ms/sync/status', async (req, res) => {
  try {
    const db = await getMongoDb();
    if (!db) return res.json({ ok: false, error: 'MongoDB not connected' });
    const meta = await db.collection('ms_sync_meta').findOne({ _id: 'main' });
    res.json({ ok: true, running: _msSyncRunning, meta: meta || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const { messages } = req.body;
    if (!Array.isArray(messages) || messages.length === 0)
      return res.status(400).json({ error: 'messages array required' });

    const systemPrompt = await buildChatContext();
    let msgHistory = [...messages.slice(-20)];

    // Agentic loop: allow up to 5 rounds (each round may have multiple tool calls)
    for (let round = 0; round < 5; round++) {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 8192,
        system: systemPrompt,
        tools: CHAT_TOOLS,
        messages: msgHistory
      });

      // If Claude wants to use tools, execute ALL tool calls in this response in parallel
      if (response.stop_reason === 'tool_use') {
        const toolUses = response.content.filter(c => c.type === 'tool_use');
        if (toolUses.length > 0) {
          const toolResults_raw = await Promise.all(toolUses.map(t => {
            if (t.name === 'web_search')       return webSearch(t.input.query);
            if (t.name === 'query_moysklad')   return toolQueryMoysklad(t.input);
            if (t.name === 'query_tally')      return toolQueryTally(t.input);
            if (t.name === 'compare_sources')  return toolCompareSources(t.input);
            return Promise.resolve(JSON.stringify({ error: 'Unknown tool: ' + t.name }));
          }));
          const toolResults = toolUses.map((t, i) => ({
            type: 'tool_result',
            tool_use_id: t.id,
            content: toolResults_raw[i]
          }));
          msgHistory = [
            ...msgHistory,
            { role: 'assistant', content: response.content },
            { role: 'user',      content: toolResults }
          ];
          continue;
        }
      }

      // Claude finished (end_turn or no tool calls) — extract the text reply
      const replyText = response.content.find(c => c.type === 'text')?.text || 'No response generated.';
      return res.json({ reply: replyText });
    }

    res.json({ reply: 'I completed multiple searches. Please ask your question again for a fresh answer.' });
  } catch (e) {
    console.error('Chat API error:', e.message);
    res.status(500).json({ error: e.message });
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
  const c   = await common();
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;

  // ── Discover which months actually have data in MongoDB ──────
  let monthsWithData = [];
  const dbEarly = await getMongoDb();
  if (dbEarly) {
    monthsWithData = (await dbEarly.collection('tally_vouchers').distinct('month')).sort();
  }

  // Build dropdown: only months with data + current month (always shown for syncing)
  let dropdownMonths = [...new Set([...monthsWithData, currentMonth])].sort().reverse();
  if (dropdownMonths.length === 0) {
    // Fallback: show last 12 months so user can still sync
    for (let i = 0; i < 12; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      dropdownMonths.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`);
    }
  }
  // Helper: Indian FY label for a YYYY-MM string
  const fyLabel = v => {
    const [y, m] = v.split('-').map(Number);
    return m >= 4 ? `FY ${y}-${String(y+1).slice(2)}` : `FY ${y-1}-${String(y).slice(2)}`;
  };
  const monthOpts = dropdownMonths.map(v => {
    const d = new Date(v + '-02');
    return { value: v, label: d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }), fy: fyLabel(v) };
  });

  // Default to latest month with data (not current month if it has no data)
  const latestWithData = monthsWithData.length > 0 ? monthsWithData[monthsWithData.length - 1] : currentMonth;
  const requestedMonth = (req.query.month || '').slice(0, 7);
  let selMonth;
  if (requestedMonth) {
    selMonth = requestedMonth; // user explicitly chose a month — honour it
  } else {
    selMonth = latestWithData; // default: latest month with real data
  }

  // ── Live Tally data (balances) ──────────────────────────────
  let result;
  let fromCache = false;
  let syncedAt  = null;
  try {
    result = await fetchLiveTallyData();
    if (result.connected) {
      saveTallySnapshot(result).catch(e => console.error('Mongo save:', e.message));
      syncedAt = now;
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
  let topCustSales     = [];
  let topSuppPurchase  = [];
  let stockItems       = [];
  let totalStockValue  = 0;
  let hasDbData        = false;

  const db = await getMongoDb();
  if (db) {
    hasDbData = true;

    // Period vouchers (selected month)
    const pv = await db.collection('tally_vouchers').find({ month: selMonth }).sort({ date: -1 }).toArray();
    periodVouchers    = pv.slice(0, 100);
    const isCollection = v => (v.type === 'Journal' || /receipt/i.test(v.type)) && !/stock journal/i.test(v.type);
    periodSales       = pv.filter(v => /sales/i.test(v.type)).reduce((s,v) => s + (v.amount||0), 0);
    periodPurchases   = pv.filter(v => /purchase/i.test(v.type)).reduce((s,v) => s + (v.amount||0), 0);
    periodCollections = pv.filter(isCollection).reduce((s,v) => s + (v.amount||0), 0);
    periodPayments    = pv.filter(v => /payment/i.test(v.type)).reduce((s,v) => s + (v.amount||0), 0);

    // Monthly trend — last 6 months
    const sixAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);
    const trend  = await db.collection('tally_vouchers').aggregate([
      { $match: { date: { $gte: sixAgo } } },
      { $group: { _id: { month: '$month', type: '$type' }, total: { $sum: '$amount' } } }
    ]).toArray();
    const tMap = {};
    trend.forEach(row => {
      const m = row._id.month;
      if (!tMap[m]) tMap[m] = { month: m, sales: 0, collections: 0, purchases: 0, payments: 0 };
      if (/sales/i.test(row._id.type))    tMap[m].sales       += row.total;
      if (row._id.type === 'Journal' || /receipt/i.test(row._id.type)) tMap[m].collections += row.total;
      if (/purchase/i.test(row._id.type)) tMap[m].purchases   += row.total;
      if (/payment/i.test(row._id.type))  tMap[m].payments    += row.total;
    });
    monthlyTrend = Object.values(tMap).sort((a,b) => a.month.localeCompare(b.month));

    // Debtors + creditors with last payment dates from tally_ledgers
    const allLedgers = await db.collection('tally_ledgers')
      .find({ type: { $in: ['debtor','creditor'] } }).toArray();
    const dbDebtors   = allLedgers.filter(l => l.type === 'debtor'   && l.balance > 0).sort((a,b) => b.balance - a.balance);
    const dbCreditors = allLedgers.filter(l => l.type === 'creditor' && l.balance > 0).sort((a,b) => b.balance - a.balance);
    if (dbDebtors.length)   debtors   = dbDebtors;
    if (dbCreditors.length) creditors = dbCreditors;

    // Expense breakdown (YTD ledger balances)
    expenseBreakdown = await db.collection('tally_ledgers')
      .find({ type: 'expense', balance: { $gt: 0 } }).sort({ balance: -1 }).toArray();

    // Top customers by collections this period (Journal = money received)
    topCustSales = await db.collection('tally_vouchers').aggregate([
      { $match: { month: selMonth, type: { $in: ['Sales', 'Journal', 'Receipt'] }, party: { $gt: '' } } },
      { $group: { _id: '$party', total: { $sum: '$amount' } } },
      { $sort: { total: -1 } }, { $limit: 10 }
    ]).toArray();

    // Top suppliers by purchases this period
    topSuppPurchase = await db.collection('tally_vouchers').aggregate([
      { $match: { month: selMonth, type: { $regex: /purchase/i }, party: { $gt: '' } } },
      { $group: { _id: '$party', total: { $sum: '$amount' } } },
      { $sort: { total: -1 } }, { $limit: 10 }
    ]).toArray();

    // Stock from tally_stock collection
    stockItems      = await db.collection('tally_stock').find({}).sort({ value: -1 }).limit(25).toArray();
    totalStockValue = stockItems.reduce((s, i) => s + (i.value || 0), 0);

    // Opening & closing stock for selected month (from daily history snapshots)
    const monthEnd   = selMonth + '-31'; // past end of month, fine for lte
    const monthStart2 = selMonth + '-01';
    const [closingSnap, openingSnap] = await Promise.all([
      // Closing = latest snapshot on or before end of selected month
      db.collection('tally_stock_history')
        .find({ _id: { $lte: monthEnd } }).sort({ _id: -1 }).limit(1).toArray(),
      // Opening = latest snapshot strictly before the 1st of selected month
      db.collection('tally_stock_history')
        .find({ _id: { $lt: monthStart2 } }).sort({ _id: -1 }).limit(1).toArray(),
    ]);
    closingStock = closingSnap[0]?.totalValue ?? totalStockValue;
    openingStock = openingSnap[0]?.totalValue ?? 0;

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
        result.totalExpenses  = ytd.filter(v => /expense/i.test(v.type)).reduce((s,v) => s + (v.amount||0), 0);
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
    fromCache, syncedAt, selMonth, monthOpts,
    periodSales, periodPurchases, periodCollections, periodPayments,
    periodVouchers, monthlyTrend,
    debtors, creditors, totalOutstanding, supplierDues,
    expenseBreakdown, topCustSales, topSuppPurchase,
    stockItems, totalStockValue, openingStock, closingStock, aging, hasDbData,
    monthsWithData
  });
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
        const ops = allVouchers.map(v => ({ replaceOne: { filter: { _id: v._id }, replacement: v, upsert: true } }));
        await db.collection('tally_vouchers').bulkWrite(ops, { ordered: false });
      }

      // ── 5. Update last payment dates ────────────────────────
      await updateLastPaymentDates(db);

      // ── 6. Stock items + save daily stock value snapshot ────
      try {
        const stockItems = await fetchTallyStock();
        if (stockItems.length > 0) {
          const ops = stockItems.map(s => ({ replaceOne: { filter: { _id: s._id }, replacement: s, upsert: true } }));
          await db.collection('tally_stock').bulkWrite(ops, { ordered: false });
          // Save daily stock value so we can compute opening/closing stock per month
          const totalValue = stockItems.reduce((s, i) => s + (i.value || 0), 0);
          await db.collection('tally_stock_history').replaceOne(
            { _id: today },
            { _id: today, date: syncedAt, month: today.slice(0, 7), totalValue },
            { upsert: true }
          );
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

    // Background MoySklad auto-sync every 4 hours
    const MS_SYNC_INTERVAL = 4 * 60 * 60 * 1000;
    async function scheduleSync() {
      if (!_msSyncRunning) {
        _msSyncRunning = true;
        try {
          const { runSync } = require('./sync-ms-data');
          await runSync({ verbose: false });
          console.log('[MS auto-sync] completed');
        } catch (e) {
          console.error('[MS auto-sync] failed:', e.message);
        } finally {
          _msSyncRunning = false;
        }
      }
      setTimeout(scheduleSync, MS_SYNC_INTERVAL);
    }
    setTimeout(scheduleSync, MS_SYNC_INTERVAL);
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
