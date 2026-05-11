require('dotenv').config();
const express = require('express');
const path    = require('path');
const app     = express();

const TOKEN   = process.env.TOKEN || '';
const MS_BASE = 'https://api.moysklad.ru/api/remap/1.2';
const TALLY_BASE    = process.env.TALLY_URL || process.env.TALLY_BASE || 'http://localhost:9000';
const TALLY_COMPANY = process.env.TALLY_COMPANY || '';
const PORT = process.env.PORT || 3000;
const CUR     = '₹';

// ── Express setup ────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('view cache', true);
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d', etag: true }));
app.use(express.json());

// ── Format helpers available in all EJS templates ────────
app.use((req, res, next) => {
  res.locals.active    = '';
  res.locals.empName   = 'Admin';
  res.locals.empLetter = 'A';
  res.locals.empRole   = 'System';
  res.locals.date      = new Date().toLocaleDateString('en-IN', { day:'2-digit', month:'long', year:'numeric' });
  res.locals.time      = new Date().toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' });
  res.locals.fmt = (n) =>
    (n == null || isNaN(n)) ? '—' : CUR + Math.round(n).toLocaleString('en-IN');
  res.locals.fmtShort = (n) => {
    if (n == null || isNaN(n)) return '—';
    const a = Math.abs(n);
    if (a >= 1e7) return CUR + (n/1e7).toFixed(2) + ' Cr';
    if (a >= 1e5) return CUR + (n/1e5).toFixed(1) + ' L';
    if (a >= 1e3) return CUR + (n/1e3).toFixed(0) + 'K';
    return CUR + Math.round(n);
  };
  res.locals.fmtDate = (s) => s ? s.slice(0,10) : '—';
  res.locals.CUR = CUR;
  next();
});

// ── Moysklad API helper ──────────────────────────────────
async function ms(path) {
  const r = await fetch(MS_BASE + path, {
    headers: {
      'Authorization': 'Bearer ' + TOKEN,
      'Accept': 'application/json;charset=utf-8'
    }
  });
  if (!r.ok) throw new Error('MS API ' + r.status + ' ' + path);
  return r.json();
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

// TallyPrime XML helper. Start Tally and enable its HTTP server on port 9000.
async function tallyXml(xml) {
  const signal = AbortSignal.timeout(8000);
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
function cached(key, ttlMs, fn) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return Promise.resolve(hit.v);
  return fn().then(v => { _cache.set(key, { v, t: Date.now() }); return v; });
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
  cached('orders_all', 2*60*1000, () => ms('/entity/customerorder?limit=1000&order=moment,desc').then(r => r.rows || []));

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

// ── Helpers ──────────────────────────────────────────────
const todayStr   = () => localDateStr(new Date());
const localDateStr = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const monthStart  = () => { const n=new Date(); return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-01 00:00:00`; };
const enc         = s => encodeURIComponent(s);
const stateName   = r => (r.state?.name || '—');
const agentName   = r => (r.agent?.name || r.counterparty?.name || '—');

// Fetch customerorder state metadata → map of { id → name }
async function getOrderStateMap() {
  return cached('stateMap', 15 * 60 * 1000, async () => {
    try {
      const meta = await ms('/entity/customerorder/metadata');
      const map = {};
      (meta.states || []).forEach(s => { map[s.id] = s.name; });
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

    // Pending orders: has a state, not dispatched, not draft
    const pendingOrders = orders.filter(r => {
      const s = resolveState(r, stateMap).toLowerCase();
      return s && s !== 'dispatched' && s !== 'draft';
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

    // Stock stats
    let lowStock=0, inStock=0, outStock=0, totalQty=0, totalVal=0;
    const folders = new Set();
    stock.forEach(r => {
      const q=r.quantity||0; totalQty+=q; totalVal+=q*(r.price||0);
      if (r.folder?.name) folders.add(r.folder.name);
      if (q<=0) outStock++; else if (q<100) { lowStock++; inStock++; } else inStock++;
    });

    const totalSell    = products.reduce((a,r)=>a+(r.sellSum||0),0);
    const weeklyOrders = buildDailyCounts(orders, 8);

    res.render('dashboard', {
      ...c, active: 'dashboard',
      salesToday: salesToday/100, shipmentsToday,
      pending, pendingStates,
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
      weeklyData: JSON.stringify(weeklyOrders)
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
      cached(ordKey, 2*60*1000, () => msAll(`/entity/customerorder?filter=${enc(df)}&order=moment,desc&expand=agent,store,state`).then(r => r.rows || [])),
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
        state: state || 'Draft', stateL,
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
    const draftCount = orders.filter(o => !o.stateL || /draft|черновик/i.test(o.stateL)).length;
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

    // Fetch customerOrders for the period — owner is the salesman, sum is revenue.
    // This matches what MoySklad's Sales Orders page shows exactly.
    const ordUrl = `/entity/customerorder?${filterStr ? 'filter='+enc(filterStr)+'&' : ''}expand=agent&order=moment,desc`;
    const { rows: orders } = await msAll(ordUrl);

    // Aggregate by salesman (customerOrder.owner)
    const smMap = {};
    orders.forEach(order => {
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
      totalOrders: orders.length,
      chartLabels:    JSON.stringify(chartTop.map(s => s.name)),
      chartValueData: JSON.stringify(chartTop.map(s => Math.round(s.totalVal))),
      chartOrderData: JSON.stringify(chartTop.map(s => s.orders)),
      chartQtyData:   JSON.stringify(chartTop.map(s => s.orders)),
      salesmenJSON:   JSON.stringify(salesmen)
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
        const { rows: demands } = await msAll(`/entity/demand?filter=${enc(filter)}`);
        let qty = 0, val = 0;
        const BATCH = 25;
        for (let i = 0; i < demands.length; i += BATCH) {
          const slice = demands.slice(i, i + BATCH);
          const posRes = await Promise.allSettled(
            slice.map(d => ms(`/entity/demand/${d.id}/positions?expand=assortment&limit=100`))
          );
          posRes.forEach(r => {
            if (r.status !== 'fulfilled') return;
            (r.value.rows || []).forEach(pos => {
              const href = pos.assortment?.meta?.href || '';
              const name = pos.assortment?.name      || '';
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

    const variants = stockItems.map(r => ({
      name:     r.name || '—',
      code:     r.code || r.article || '—',
      quantity: r.quantity || 0,
      status:   (r.quantity || 0) <= 0 ? 'Out of Stock' : (r.quantity || 0) <= 100 ? 'Low Stock' : 'In Stock'
    })).sort((a, b) => a.name.localeCompare(b.name));

    res.render('product-analytics', {
      ...c, active: '',
      productName: baseName, productId: id, productType: type,
      totalQty, totalVal, currentStock, avgDaily,
      outCount, lowCount,
      variants, monthlyTrend,
      trendJSON:    JSON.stringify(monthlyTrend),
      variantsJSON: JSON.stringify(variants)
    });
  } catch (e) { res.status(500).render('error', { message: e.message }); }
});

app.get('/stock-alerts', (req, res) => res.redirect('/inventory'));

// ── AI CHATBOT ────────────────────────────────────────────
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function buildChatContext() {
  return cached('chatCtx', 10 * 60 * 1000, async () => {
    const now           = new Date();
    const daysIntoMonth = now.getDate();
    const today         = todayStr();

    // ── Date boundaries ──────────────────────────────────
    const curMonthStart = monthStart(); // e.g. "2026-05-01 00:00:00"
    const prevD         = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevMonthStart= `${localDateStr(prevD)} 00:00:00`;
    const prevMonthEnd  = `${localDateStr(new Date(now.getFullYear(), now.getMonth(), 0))} 23:59:59`;
    const threeMonthsAgo= new Date(now); threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
    const from3mo       = `${localDateStr(threeMonthsAgo)} 00:00:00`;

    const curMonthName  = now.toLocaleString('en', { month: 'long', year: 'numeric' });
    const prevMonthName = prevD.toLocaleString('en', { month: 'long', year: 'numeric' });
    const dateStr       = now.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });

    // ── Parallel fetch — every relevant MoySklad endpoint ──
    const [
      stkRes,        // stock levels
      demCurRes,     // this month shipments (with agent)
      demPrevRes,    // last month shipments
      prodCurRes,    // this month profit by product
      prodPrevRes,   // last month profit by product
      custCurRes,    // this month profit by counterparty  ← correct customer source
      custPrevRes,   // last month profit by counterparty
      ordAllRes,     // last 3 months orders (for pending/delayed)
      stateMapRes,   // order state names
    ] = await Promise.allSettled([
      ms('/report/stock/all?limit=1000'),
      ms(`/entity/demand?filter=${enc('moment>'+curMonthStart)}&limit=1000&expand=agent&order=moment,desc`),
      ms(`/entity/demand?filter=${enc('moment>'+prevMonthStart+';moment<'+prevMonthEnd)}&limit=1000&expand=agent&order=moment,desc`),
      ms(`/report/profit/byproduct?momentFrom=${enc(curMonthStart)}&limit=1000`),
      ms(`/report/profit/byproduct?momentFrom=${enc(prevMonthStart)}&momentTo=${enc(prevMonthEnd)}&limit=1000`),
      ms(`/report/profit/bycounterparty?momentFrom=${enc(curMonthStart)}&limit=500`),
      ms(`/report/profit/bycounterparty?momentFrom=${enc(prevMonthStart)}&momentTo=${enc(prevMonthEnd)}&limit=500`),
      ms(`/entity/customerorder?filter=${enc('moment>'+from3mo)}&limit=1000&expand=agent,state&order=moment,desc`),
      getOrderStateMap(),
    ]);

    // ── Parse all responses ──────────────────────────────
    const stock     = stkRes.status      === 'fulfilled' ? (stkRes.value.rows     || []) : [];
    const demCur    = demCurRes.status   === 'fulfilled' ? (demCurRes.value.rows  || []) : [];
    const demPrev   = demPrevRes.status  === 'fulfilled' ? (demPrevRes.value.rows || []) : [];
    const prodCur   = prodCurRes.status  === 'fulfilled' ? (prodCurRes.value.rows || []) : [];
    const prodPrev  = prodPrevRes.status === 'fulfilled' ? (prodPrevRes.value.rows|| []) : [];
    const custCur   = custCurRes.status  === 'fulfilled' ? (custCurRes.value.rows || []) : [];
    const custPrev  = custPrevRes.status === 'fulfilled' ? (custPrevRes.value.rows|| []) : [];
    const allOrders = ordAllRes.status   === 'fulfilled' ? (ordAllRes.value.rows  || []) : [];
    const stateMap  = stateMapRes.status === 'fulfilled' ? stateMapRes.value : {};

    const fmt  = n => `₹${Math.round(n).toLocaleString('en-IN')}`;
    const fmtS = n => {
      const a = Math.abs(n);
      if (a >= 1e7) return `₹${(n/1e7).toFixed(2)} Cr`;
      if (a >= 1e5) return `₹${(n/1e5).toFixed(1)} L`;
      return fmt(n);
    };
    const pct = (a, b) => b > 0 ? ((a - b) / b * 100).toFixed(1) + '%' : 'N/A';

    // ── Inventory ───────────────────────────────────────
    let outStk = 0, lowStk = 0, inStk = 0;
    stock.forEach(r => {
      const q = r.quantity || 0;
      if (q <= 0) outStk++; else if (q <= 100) lowStk++; else inStk++;
    });
    const lowItems = stock.filter(r => (r.quantity||0) > 0 && (r.quantity||0) <= 100)
      .sort((a, b) => a.quantity - b.quantity).slice(0, 30)
      .map(r => `  • ${r.name}: ${r.quantity} pcs`);
    const outItems = stock.filter(r => (r.quantity||0) <= 0).slice(0, 30)
      .map(r => `  • ${r.name}`);

    // ── Sales velocity & predictions ────────────────────
    const velMap = {};
    prodCur.forEach(r => {
      if (!r.assortment?.name) return;
      velMap[r.assortment.name] = {
        dailyQty: (r.sellQuantity || 0) / daysIntoMonth,
        monthQty: Math.round(r.sellQuantity || 0),
      };
    });
    const runningOut = stock
      .map(r => {
        const v = velMap[r.name];
        const qty = r.quantity || 0;
        const daysLeft = v && v.dailyQty > 0 ? Math.round(qty / v.dailyQty) : null;
        return { name: r.name, qty, daysLeft, reorder: v ? Math.round(v.dailyQty * 30) : 0 };
      })
      .filter(r => r.qty > 0 && r.daysLeft !== null && r.daysLeft <= 45)
      .sort((a, b) => a.daysLeft - b.daysLeft).slice(0, 20);

    const slowMoving = stock
      .filter(r => (r.quantity||0) > 0 && (!velMap[r.name] || velMap[r.name].monthQty === 0))
      .sort((a, b) => (b.quantity||0) - (a.quantity||0)).slice(0, 20);

    // ── Pending & delayed orders ─────────────────────────
    const pendingOrders = allOrders.filter(r => {
      const s = resolveState(r, stateMap).toLowerCase();
      return s && s !== 'dispatched' && s !== 'draft';
    });
    const delayedOrders = allOrders
      .filter(r => {
        const s = resolveState(r, stateMap).toLowerCase();
        return r.deliveryPlannedMoment && s !== 'dispatched' && new Date(r.deliveryPlannedMoment) < now;
      })
      .map(r => ({
        name: r.name || '—', customer: r.agent?.name || '—',
        state: resolveState(r, stateMap) || '—',
        planned: (r.deliveryPlannedMoment || '').slice(0, 10),
        daysLate: Math.floor((now - new Date(r.deliveryPlannedMoment)) / 86400000),
        val: (r.sum || 0) / 100
      })).sort((a, b) => b.daysLate - a.daysLate);

    // ── This month sales ─────────────────────────────────
    const curRevenue   = demCur.reduce((a, r) => a + (r.sum||0), 0) / 100;
    const prevRevenue  = demPrev.reduce((a, r) => a + (r.sum||0), 0) / 100;
    const todayDemands = demCur.filter(r => (r.moment||'').startsWith(today));
    const todayRevenue = todayDemands.reduce((a, r) => a + (r.sum||0), 0) / 100;

    // ── Top products — current month ─────────────────────
    const topProdCur = prodCur
      .filter(r => r.assortment?.name)
      .map(r => ({ name: r.assortment.name, qty: Math.round(r.sellQuantity||0), val: (r.sellSum||0)/100, margin: (r.sellSum||0) > 0 ? Math.round(((r.sellSum - (r.buySum||0)) / r.sellSum) * 100) : null }))
      .sort((a, b) => b.val - a.val).slice(0, 15);
    const topProdByQty = [...topProdCur].sort((a, b) => b.qty - a.qty).slice(0, 10);
    const highMargin = topProdCur.filter(p => p.margin !== null).sort((a, b) => b.margin - a.margin).slice(0, 10);

    // ── Top products — last month ────────────────────────
    const topProdPrev = prodPrev
      .filter(r => r.assortment?.name)
      .map(r => ({ name: r.assortment.name, qty: Math.round(r.sellQuantity||0), val: (r.sellSum||0)/100 }))
      .sort((a, b) => b.val - a.val).slice(0, 10);

    // ── Top customers — current month (bycounterparty) ──
    const topCustCur = custCur
      .filter(r => r.counterparty?.name)
      .map(r => ({ name: r.counterparty.name, orders: r.salesCount||0, val: (r.sellSum||0)/100, qty: Math.round(r.sellQuantity||0) }))
      .sort((a, b) => b.val - a.val).slice(0, 15);
    const topCustByOrders = [...topCustCur].sort((a, b) => b.orders - a.orders).slice(0, 10);

    // ── Robust counterparty name helper ─────────────────
    const cpName = r => r.counterparty?.name || r.agent?.name || r.name || null;

    // ── Top customers — last month ───────────────────────
    const topCustPrev = custPrev
      .filter(r => cpName(r))
      .map(r => ({ name: cpName(r), orders: r.salesCount||0, val: (r.sellSum||0)/100 }))
      .sort((a, b) => b.val - a.val).slice(0, 10);

    // Re-parse current month customers with robust name helper
    const topCustCurFixed = custCur
      .filter(r => cpName(r))
      .map(r => ({ name: cpName(r), orders: r.salesCount||0, val: (r.sellSum||0)/100, qty: Math.round(r.sellQuantity||0) }))
      .sort((a, b) => b.val - a.val).slice(0, 15);
    const topCustByOrdersFixed = [...topCustCurFixed].sort((a, b) => b.orders - a.orders).slice(0, 10);

    // ── Historical months: Nov 2025 → month before current ──
    const histMonths = [];
    {
      let hy = 2025, hm = 11;
      const nowY = now.getFullYear(), nowM = now.getMonth() + 1;
      while (hy < nowY || (hy === nowY && hm < nowM)) {
        const d    = new Date(hy, hm - 1, 1);
        const last = new Date(hy, hm, 0);
        // Skip months already covered as "current" or "prev" (they have full data)
        const key = `${hy}-${String(hm).padStart(2,'0')}`;
        if (key !== prevD.toISOString().slice(0,7).replace('-','').slice(0,7)) { // always add
          histMonths.push({
            label: d.toLocaleString('en', { month: 'long', year: 'numeric' }),
            from:  `${key}-01 00:00:00`,
            to:    `${localDateStr(last)} 23:59:59`,
          });
        }
        hm++; if (hm > 12) { hm = 1; hy++; }
      }
    }

    // Fetch 3 calls per historical month in parallel: customers, products, shipment count
    const histResults = histMonths.length > 0
      ? await Promise.allSettled(
          histMonths.flatMap(m => [
            ms(`/report/profit/bycounterparty?momentFrom=${enc(m.from)}&momentTo=${enc(m.to)}&limit=50`),
            ms(`/report/profit/byproduct?momentFrom=${enc(m.from)}&momentTo=${enc(m.to)}&limit=50`),
            ms(`/entity/demand?filter=${enc('moment>'+m.from+';moment<'+m.to)}&limit=1`),
          ])
        )
      : [];

    const monthlyHistory = histMonths.map((m, i) => {
      const cRows     = histResults[i*3]?.status === 'fulfilled' ? (histResults[i*3].value.rows || []) : [];
      const pRows     = histResults[i*3+1]?.status === 'fulfilled' ? (histResults[i*3+1].value.rows || []) : [];
      const demMeta   = histResults[i*3+2]?.status === 'fulfilled' ? histResults[i*3+2].value : null;
      const shipments = demMeta?.meta?.size ?? demMeta?.rows?.length ?? null;
      const revenue   = cRows.reduce((a, r) => a + (r.sellSum||0), 0) / 100;
      return {
        label: m.label,
        revenue,
        shipments,
        custs: cRows.filter(r => cpName(r)).map(r => ({ name: cpName(r), val: (r.sellSum||0)/100, orders: r.salesCount||0 })).sort((a,b) => b.val-a.val).slice(0,10),
        prods: pRows.filter(r => r.assortment?.name).map(r => ({ name: r.assortment.name, val: (r.sellSum||0)/100, qty: Math.round(r.sellQuantity||0) })).sort((a,b) => b.val-a.val).slice(0,10),
      };
    }).reverse(); // newest first

    // ── Detect business type from product names ──────────
    const productNames = topProdCur.map(p => p.name).join(', ');

    // ── Build prompt ─────────────────────────────────────
    const L   = [];
    const sec = t => L.push('', `── ${t} ──`);

    L.push(
      `You are WareSmart AI — an advanced Business Intelligence and Strategy Advisor for a distribution/trading company.`,
      ``,
      `YOUR CAPABILITIES:`,
      `1. LIVE MOYSKLAD DATA: Complete inventory, sales, customer, and order data is provided below — use it directly.`,
      `2. WEB SEARCH: You have a web_search tool. Use it proactively for: market trends, competitor analysis, pricing benchmarks, regulations, industry news, global data, and any external information.`,
      `3. BUSINESS EXPERTISE: Apply expert-level knowledge in supply chain, pricing strategy, customer retention, cash flow, demand forecasting, and distribution management.`,
      ``,
      `HOW TO RESPOND:`,
      `- Be CONCISE. No preamble, no explanations, no summaries. Just the answer.`,
      `- Lead with a markdown table whenever the answer has multiple rows or columns. No prose before the table.`,
      `- After the table, max 1-2 bullet points if a critical action is needed — otherwise nothing.`,
      `- For market/external questions: use web_search first, then give a tight table or 2-line summary.`,
      `- Numbers: ₹ format, L for lakhs, Cr for crores. Round to 2 decimal places.`,
      ``,
      `BUSINESS CONTEXT:`,
      `- Products in system: ${productNames.slice(0, 200)}`,
      `- Operating currency: Indian Rupees (₹)`,
      `- Current month: ${curMonthName} | Previous month: ${prevMonthName}`,
      `- Sales velocity basis: ${daysIntoMonth} days elapsed this month`,
      `- Today: ${today}`,
      ``,
      `DECISION FRAMEWORKS TO APPLY:`,
      `- ABC analysis: Rank customers/products by revenue contribution`,
      `- Stock health: Flag items running out vs. slow-movers accumulating`,
      `- Cash flow signals: Pending orders = revenue locked, delayed = risk`,
      `- Growth indicators: Month-over-month trends, top vs bottom performers`,
      `- Market context: Compare your metrics against industry benchmarks when asked`,
      ``,
      `${'═'.repeat(60)}`,
      `LIVE MOYSKLAD DATA SNAPSHOT — ${dateStr}`,
      `${'═'.repeat(60)}`
    );

    // INVENTORY
    sec(`INVENTORY`);
    L.push(`Total SKUs: ${stock.length} | In Stock: ${inStk} | Low Stock (≤100 pcs): ${lowStk} | Out of Stock: ${outStk}`);
    if (lowItems.length) { L.push(`\nLow Stock Items (${lowStk}):`); L.push(...lowItems); }
    if (outItems.length) { L.push(`\nOut of Stock (${outStk} items):`); L.push(...outItems); }

    // PREDICTIONS
    sec(`STOCK DEPLETION PREDICTIONS (running out within 45 days)`);
    if (runningOut.length) {
      L.push(`Calculated from ${daysIntoMonth}-day sales rate:`);
      runningOut.forEach(r => L.push(`  • ${r.name}: ${r.qty} pcs → ~${r.daysLeft} days left | Reorder: ${r.reorder} pcs`));
    } else { L.push(`No items predicted to run out within 45 days.`); }

    sec(`SLOW-MOVING ITEMS (in stock, zero sales in ${curMonthName})`);
    if (slowMoving.length) {
      slowMoving.forEach(r => L.push(`  • ${r.name}: ${r.quantity} pcs idle`));
    } else { L.push(`All items have had sales activity this month.`); }

    // SALES — THIS MONTH
    sec(`SALES — ${curMonthName} (CURRENT MONTH)`);
    const mom = prevRevenue > 0 ? ` (${Number(pct(curRevenue, prevRevenue)) >= 0 ? '+' : ''}${pct(curRevenue, prevRevenue)} vs last month)` : '';
    L.push(
      `Shipments: ${demCur.length} | Revenue: ${fmtS(curRevenue)}${mom}`,
      `Avg per shipment: ${demCur.length ? fmtS(curRevenue / demCur.length) : '—'}`,
      `Today (${today}): ${todayDemands.length} shipments | ${fmtS(todayRevenue)}`
    );

    // SALES — LAST MONTH
    sec(`SALES — ${prevMonthName} (PREVIOUS MONTH)`);
    L.push(`Shipments: ${demPrev.length} | Revenue: ${fmtS(prevRevenue)}`);

    // TOP PRODUCTS — CURRENT
    sec(`TOP PRODUCTS BY REVENUE — ${curMonthName}`);
    if (topProdCur.length) {
      topProdCur.forEach((p, i) => L.push(`${i+1}. ${p.name} — ${fmtS(p.val)}${p.margin !== null ? ` (${p.margin}% margin)` : ''} | ${p.qty.toLocaleString('en-IN')} pcs`));
    } else { L.push(`No product sales data this month.`); }

    sec(`TOP PRODUCTS BY QTY SOLD — ${curMonthName}`);
    if (topProdByQty.length) {
      topProdByQty.forEach((p, i) => L.push(`${i+1}. ${p.name} — ${p.qty.toLocaleString('en-IN')} pcs | ${fmtS(p.val)}`));
    }

    // TOP PRODUCTS — LAST MONTH
    sec(`TOP PRODUCTS BY REVENUE — ${prevMonthName} (LAST MONTH)`);
    if (topProdPrev.length) {
      topProdPrev.forEach((p, i) => L.push(`${i+1}. ${p.name} — ${fmtS(p.val)} | ${p.qty.toLocaleString('en-IN')} pcs`));
    } else { L.push(`No data.`); }

    // HIGH MARGIN
    sec(`MOST PROFITABLE PRODUCTS (by gross margin %)`);
    if (highMargin.length) {
      highMargin.forEach((p, i) => L.push(`${i+1}. ${p.name} — ${p.margin}% margin | ${fmtS(p.val)}`));
    } else { L.push(`Margin data unavailable (buy prices may not be set in MoySklad).`); }

    // CUSTOMERS — CURRENT MONTH
    sec(`TOP CUSTOMERS BY REVENUE — ${curMonthName}`);
    if (topCustCurFixed.length) {
      topCustCurFixed.forEach((c, i) => L.push(`${i+1}. ${c.name} — ${fmtS(c.val)} | ${c.orders} orders | ${c.qty.toLocaleString('en-IN')} pcs`));
    } else { L.push(`No counterparty revenue data this month.`); }

    sec(`TOP CUSTOMERS BY ORDER COUNT — ${curMonthName}`);
    if (topCustByOrdersFixed.length) {
      topCustByOrdersFixed.forEach((c, i) => L.push(`${i+1}. ${c.name} — ${c.orders} orders | ${fmtS(c.val)}`));
    }

    // CUSTOMERS — LAST MONTH
    sec(`TOP CUSTOMERS BY REVENUE — ${prevMonthName} (LAST MONTH)`);
    if (topCustPrev.length) {
      topCustPrev.forEach((c, i) => L.push(`${i+1}. ${c.name} — ${fmtS(c.val)} | ${c.orders} orders`));
    } else { L.push(`No data.`); }

    // HISTORICAL MONTHLY DATA
    if (monthlyHistory.length > 0) {
      sec(`COMPLETE MONTHLY HISTORY — Nov 2025 to ${prevMonthName}`);
      monthlyHistory.forEach(m => {
        const shipStr = m.shipments !== null ? `${m.shipments} shipments` : 'shipments: N/A';
        L.push(``, `${m.label.toUpperCase()} — Revenue: ${fmtS(m.revenue)} | ${shipStr} | Avg/shipment: ${m.shipments ? fmtS(m.revenue / m.shipments) : '—'}`);
        if (m.custs.length) {
          L.push(`  Top Customers: ` + m.custs.map((c,i) => `${i+1}. ${c.name} (${fmtS(c.val)}, ${c.orders} orders)`).join(' | '));
        } else { L.push(`  Top Customers: No data`); }
        if (m.prods.length) {
          L.push(`  Top Products:  ` + m.prods.map((p,i) => `${i+1}. ${p.name} (${fmtS(p.val)}, ${p.qty} pcs)`).join(' | '));
        } else { L.push(`  Top Products:  No data`); }
      });
    }

    // PENDING
    sec(`PENDING ORDERS (${pendingOrders.length} not yet dispatched)`);
    if (pendingOrders.length) {
      pendingOrders.slice(0, 25).forEach(o => {
        const state = resolveState(o, stateMap) || '—';
        L.push(`  • ${o.name||'—'} | Customer: ${o.agent?.name||'—'} | State: ${state} | ${fmtS((o.sum||0)/100)}`);
      });
      if (pendingOrders.length > 25) L.push(`  ... and ${pendingOrders.length - 25} more`);
    } else { L.push(`No pending orders.`); }

    // DELAYED
    sec(`DELAYED ORDERS (past planned delivery date)`);
    if (delayedOrders.length) {
      delayedOrders.slice(0, 15).forEach(o => {
        L.push(`  • ${o.name} | ${o.customer} | ${o.daysLate} days overdue | Planned: ${o.planned} | State: ${o.state} | ${fmtS(o.val)}`);
      });
    } else { L.push(`No delayed orders.`); }

    return L.join('\n');
  });
}

// ── Web search via DuckDuckGo (no API key needed) ────────
async function webSearch(query) {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'WareSmart-AI/1.0' },
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

// ── Chat tools definition ─────────────────────────────────
const CHAT_TOOLS = [{
  name: 'web_search',
  description: 'Search the internet for real-time information: market trends, industry news, regulations, competitor data, global pricing, product reviews, government policies, economic indicators. Use this whenever the question goes beyond the MoySklad business data provided in the system prompt.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'A focused, specific search query. Example: "vaping market India 2025 trends" or "e-cigarette regulations India GST"'
      }
    },
    required: ['query']
  }
}];

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
        max_tokens: 2048,
        system: systemPrompt,
        tools: CHAT_TOOLS,
        messages: msgHistory
      });

      // If Claude wants to use tools, execute ALL tool calls in this response in parallel
      if (response.stop_reason === 'tool_use') {
        const toolUses = response.content.filter(c => c.type === 'tool_use');
        if (toolUses.length > 0) {
          // Run every search simultaneously
          const searchResults = await Promise.all(
            toolUses.map(t => t.name === 'web_search' ? webSearch(t.input.query) : Promise.resolve('Tool not supported.'))
          );
          // Return one tool_result per tool_use — order and IDs must match
          const toolResults = toolUses.map((t, i) => ({
            type: 'tool_result',
            tool_use_id: t.id,
            content: searchResults[i]
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
app.get('/tally', async (req, res) => {
  const c = await common();
  const result = {
    connected: false, company: TALLY_COMPANY || '', error: null,
    tallyUrl: TALLY_BASE,
    totalSales: 0, totalPurchases: 0, totalExpenses: 0, totalOutstanding: 0,
    cashBalance: 0, bankBalance: 0, supplierDues: 0,
    debtors: [], creditors: [], recentVouchers: []
  };

  try {
    // Fetch all ledgers — this also confirms Tally is reachable
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

    result.debtors         = result.debtors.filter(d => d.balance > 0).sort((a,b) => b.balance - a.balance).slice(0, 15);
    result.creditors       = result.creditors.filter(c => c.balance > 0).sort((a,b) => b.balance - a.balance).slice(0, 15);
    result.totalOutstanding = result.debtors.reduce((a, r) => a + r.balance, 0);
    result.supplierDues    = result.creditors.reduce((a, r) => a + r.balance, 0);

    // Recent vouchers (current month)
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

  } catch(e) {
    result.connected = false;
    result.error = (e.cause?.code === 'ECONNREFUSED' || e.message.includes('ECONNREFUSED') || e.name === 'AbortError')
      ? `Cannot reach Tally at ${TALLY_BASE} — open TallyPrime and enable HTTP server (F12 → Advanced Config → port 9000)`
      : e.message;
  }

  res.render('tally', { ...c, active: 'tally', ...result });
});

// ════════════════════════════════════════════════════════
//  START
// ════════════════════════════════════════════════════════
// Returns [today, yesterday, ..., n-1 days ago] — newest first, no overflow into wrong bucket
function buildDailyCounts(items, n) {
  const map = {};
  items.forEach(r => {
    const date = (r.moment || '').slice(0, 10);
    if (date) map[date] = (map[date] || 0) + 1;
  });
  const now = new Date();
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    return map[localDateStr(d)] || 0;
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
    console.log(`\n  WareSmart running`);
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
