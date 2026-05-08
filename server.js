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
app.use(express.static(path.join(__dirname, 'public')));
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

// ── Common data (employee name, date) ────────────────────
async function common() {
  let empName = 'Admin', empLetter = 'A', empRole = 'Moysklad';
  try {
    const emp = await ms('/context/employee');
    empName   = emp.name || 'Admin';
    empLetter = empName[0].toUpperCase();
    empRole   = emp.position || 'Moysklad';
  } catch (_) {}
  return {
    empName, empLetter, empRole,
    date: new Date().toLocaleDateString('en-IN', { day:'2-digit', month:'long', year:'numeric' }),
    time: new Date().toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' })
  };
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
  try {
    const meta = await ms('/entity/customerorder/metadata');
    const map = {};
    (meta.states || []).forEach(s => { map[s.id] = s.name; });
    return map;
  } catch(_) { return {}; }
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

    const [shipRes, ordRes, stkRes, prodRes, custRes, stateMapRes] = await Promise.allSettled([
      ms('/entity/demand?limit=200&order=moment,desc'),
      ms('/entity/customerorder?limit=1000&order=moment,desc'),
      ms('/report/stock/all?limit=1000'),
      ms(`/report/profit/byproduct?momentFrom=${enc(from)}&limit=10`),
      ms(`/report/profit/bycounterparty?momentFrom=${enc(from)}&limit=10`),
      getOrderStateMap()
    ]);

    const shipments = shipRes.status==='fulfilled' ? (shipRes.value.rows || []) : [];
    const orders    = ordRes.status==='fulfilled'  ? (ordRes.value.rows  || []) : [];
    const stock     = stkRes.status==='fulfilled'  ? (stkRes.value.rows  || []) : [];
    const products  = prodRes.status==='fulfilled' ? (prodRes.value.rows || []).sort((a,b)=>(b.sellSum||0)-(a.sellSum||0)) : [];
    const customers = custRes.status==='fulfilled' ? (custRes.value.rows || []).sort((a,b)=>(b.sellSum||0)-(a.sellSum||0)) : [];
    const stateMap  = stateMapRes.status==='fulfilled' ? stateMapRes.value : {};

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
      if (q<=0) outStock++; else if (q<=5) { lowStock++; inStock++; } else inStock++;
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

    // Fetch orders (no expand=owner — silently fails in many token configs), demands, and state map
    const [ordRes, demRes, smRes] = await Promise.allSettled([
      msAll(`/entity/customerorder?filter=${enc(df)}&order=moment,desc&expand=agent,store,state`),
      msAll(`/entity/demand?filter=${enc(df)}&order=moment,desc`),
      getOrderStateMap()
    ]);

    const rawOrders = ordRes.status === 'fulfilled' ? ordRes.value.rows  : [];
    const demands   = demRes.status === 'fulfilled' ? demRes.value.rows  : [];
    const stateMap  = smRes.status  === 'fulfilled' ? smRes.value        : {};

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
    const c = await common();
    const data = await ms('/report/stock/all?limit=1000');
    const rows = data.rows||[];
    const folders = new Set(rows.map(r=>r.folder?.name).filter(Boolean));
    const filterFolder = req.query.folder||'';
    const filtered = filterFolder ? rows.filter(r=>r.folder?.name===filterFolder) : rows;
    let low=0, inStk=0, outStk=0, totalVal=0, totalQty=0;
    rows.forEach(r=>{
      const q=r.quantity||0; totalQty+=q; totalVal+=q*(r.price||0);
      if(q<=0) outStk++; else if(q<=5) {low++;inStk++;} else inStk++;
    });
    res.render('inventory', {
      ...c, active: 'inventory',
      items: filtered.map(r=>({
        name:r.name||'—', code:r.code||'—',
        qty:r.quantity||0, price:(r.price||0)/100,
        val:((r.quantity||0)*(r.price||0))/100,
        folder:r.folder?.name||'—',
        stockDays:Math.round(r.stockDays||0),
        status: (r.quantity||0)<=0?'Out of Stock':(r.quantity||0)<=5?'Low Stock':'In Stock'
      })),
      totalSKU:rows.length, low, inStk, outStk,
      totalVal:totalVal/100, totalQty,
      folders:[...folders], filterFolder
    });
  } catch(e) { res.status(500).render('error',{message:e.message}); }
});

// ── PURCHASES ────────────────────────────────────────────
app.get('/purchases', async (req, res) => {
  try {
    const c = await common();
    const page = parseInt(req.query.page)||1;
    const limit=50, offset=(page-1)*limit;
    const data = await ms(`/entity/purchaseorder?limit=${limit}&offset=${offset}&order=moment,desc&expand=state,agent`);
    const rows = data.rows||[];
    const total = data.meta?.size||0;
    res.render('purchases', {
      ...c, active: 'purchases',
      purchases: rows.map(r=>({
        name:r.name||'—', supplier:agentName(r),
        date:(r.moment||'').slice(0,10),
        sum:(r.sum||0)/100, state:stateName(r)
      })),
      total, page, pages:Math.ceil(total/limit)
    });
  } catch(e) { res.status(500).render('error',{message:e.message}); }
});


// ── CUSTOMERS ────────────────────────────────────────────
app.get('/customers', async (req, res) => {
  try {
    const c = await common();
    const from = monthStart();
    const [custData, profitData] = await Promise.allSettled([
      ms('/entity/counterparty?limit=100&order=name,asc'),
      ms(`/report/profit/bycounterparty?momentFrom=${enc(from)}&limit=100`)
    ]);
    const customers = custData.status==='fulfilled' ? (custData.value.rows||[]) : [];
    const profit = profitData.status==='fulfilled' ? (profitData.value.rows||[]) : [];
    const profitMap = {};
    profit.forEach(r=>{ if(r.counterparty?.name) profitMap[r.counterparty.name]={sales:r.salesCount||0, val:(r.sellSum||0)/100, profit:(r.profit||0)/100}; });
    res.render('customers', {
      ...c, active: 'customers',
      customers: customers.map(r=>({
        name:r.name||'—', phone:r.phone||'—', email:r.email||'—',
        type:r.companyType||'—', city:(r.actualAddress?.city||'—'),
        ...(profitMap[r.name]||{sales:'—',val:0,profit:0})
      })),
      total: customers.length
    });
  } catch(e) { res.status(500).render('error',{message:e.message}); }
});

// ── SUPPLIERS ────────────────────────────────────────────
app.get('/suppliers', async (req, res) => {
  try {
    const c = await common();
    const data = await ms('/entity/counterparty?limit=200&order=name,asc');
    const rows = data.rows||[];
    res.render('suppliers', {
      ...c, active: 'suppliers',
      suppliers: rows.map(r=>({
        name:r.name||'—', phone:r.phone||'—', email:r.email||'—',
        type:r.companyType||'—', inn:r.inn||'—', code:r.code||'—'
      })),
      total: rows.length
    });
  } catch(e) { res.status(500).render('error',{message:e.message}); }
});

// ── REPORTS ──────────────────────────────────────────────
app.get('/reports', async (req, res) => {
  try {
    const c = await common();
    const from = monthStart();
    const [prodData, custData] = await Promise.allSettled([
      ms(`/report/profit/byproduct?momentFrom=${enc(from)}&limit=15`),
      ms(`/report/profit/bycounterparty?momentFrom=${enc(from)}&limit=10`)
    ]);
    const products  = prodData.status==='fulfilled'?(prodData.value.rows||[]).sort((a,b)=>(b.sellSum||0)-(a.sellSum||0)):[];
    const customers = custData.status==='fulfilled'?(custData.value.rows||[]).sort((a,b)=>(b.sellSum||0)-(a.sellSum||0)):[];
    const totalSell = products.reduce((a,r)=>a+(r.sellSum||0),0);
    const totalProfit = products.reduce((a,r)=>a+(r.profit||0),0);
    res.render('reports', {
      ...c, active: 'reports',
      products: products.map(r=>({name:r.assortment?.name||'—', qty:Math.round(r.sellQuantity||0), sell:(r.sellSum||0)/100, cost:(r.sellCostSum||0)/100, profit:(r.profit||0)/100, margin:((r.margin||0)*100).toFixed(1)+'%'})),
      customers: customers.map(r=>({name:r.counterparty?.name||'—', orders:r.salesCount||0, val:(r.sellSum||0)/100, profit:(r.profit||0)/100})),
      totalSell:totalSell/100, totalProfit:totalProfit/100,
      prodChartLabels: JSON.stringify(products.slice(0,8).map(r=>(r.assortment?.name||'?').split(' ').slice(0,2).join(' '))),
      prodChartData:   JSON.stringify(products.slice(0,8).map(r=>Math.round((r.sellSum||0)/100))),
      custChartLabels: JSON.stringify(customers.slice(0,8).map(r=>r.counterparty?.name||'?')),
      custChartData:   JSON.stringify(customers.slice(0,8).map(r=>Math.round((r.sellSum||0)/100)))
    });
  } catch(e) { res.status(500).render('error',{message:e.message}); }
});

// ── ALERTS ───────────────────────────────────────────────
app.get('/alerts', async (req, res) => {
  try {
    const c = await common();
    const [stkData, invData, ordData] = await Promise.allSettled([
      ms('/report/stock/all?limit=1000'),
      ms('/entity/invoiceout?limit=200&order=moment,desc'),
      ms('/entity/customerorder?limit=100&order=moment,desc&expand=state')
    ]);
    const stock = stkData.status==='fulfilled'?(stkData.value.rows||[]):[];
    const invoices = invData.status==='fulfilled'?(invData.value.rows||[]):[];
    const orders = ordData.status==='fulfilled'?(ordData.value.rows||[]):[];
    const now = Date.now();
    const alerts = [];
    orders.filter(r=>stateName(r).toUpperCase()==='NEW').forEach(r=>
      alerts.push({t:'r',i:'fa-shopping-cart',title:'New order: '+r.name, desc:`Amount: ₹${Math.round((r.sum||0)/100).toLocaleString('en-IN')}`, time:(r.moment||'').slice(0,10)}));
    invoices.forEach(r=>{
      const out=(r.sum||0)-(r.payedSum||0);
      if(out<=0) return;
      const d=Math.floor((now-new Date(r.moment))/86400000);
      if(d>30) alerts.push({t:'b',i:'fa-clock',title:'Overdue invoice: '+r.name, desc:`Overdue by ${d} days — ₹${Math.round(out/100).toLocaleString('en-IN')}`, time:(r.moment||'').slice(0,10)});
    });
    stock.filter(r=>(r.quantity||0)<=0).forEach(r=>
      alerts.push({t:'r',i:'fa-box-open',title:'Out of stock: '+r.name, desc:'Zero quantity available', time:'Now'}));
    stock.filter(r=>(r.quantity||0)>0&&(r.quantity||0)<=5).forEach(r=>
      alerts.push({t:'o',i:'fa-exclamation-triangle',title:'Low stock: '+r.name, desc:`Only ${r.quantity} unit(s) left`, time:'Now'}));
    res.render('alerts', { ...c, active:'alerts', alerts, total:alerts.length });
  } catch(e) { res.status(500).render('error',{message:e.message}); }
});

// ── SETTINGS ─────────────────────────────────────────────
app.get('/settings', async (req, res) => {
  const c = await common();
  res.render('settings', { ...c, active:'settings', token: TOKEN.slice(0,8)+'••••••••••••••••••••••••••••••••' });
});

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
    const lowCount     = stockItems.filter(r => (r.quantity || 0) > 0 && (r.quantity || 0) <= 5).length;

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
      status:   (r.quantity || 0) <= 0 ? 'Out of Stock' : (r.quantity || 0) <= 5 ? 'Low Stock' : 'In Stock'
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

// ── STOCK ALERTS PAGE ─────────────────────────────────────
app.get('/stock-alerts', async (req, res) => {
  try {
    const c = await common();
    const data = await ms('/report/stock/all?limit=1000');
    const rows = data.rows || [];

    const LOW_THRESHOLD = 5;

    // Separate alert items
    const outItems = rows.filter(r => (r.quantity || 0) <= 0);
    const lowItems = rows.filter(r => (r.quantity || 0) > 0 && (r.quantity || 0) <= LOW_THRESHOLD);
    const alertItems = [...outItems, ...lowItems];

    // Group by category (folder)
    const catMap = {};
    alertItems.forEach(r => {
      const cat = r.folder?.name || 'Uncategorized';
      if (!catMap[cat]) catMap[cat] = { name: cat, out: [], low: [] };
      const item = {
        name:     r.name || '—',
        code:     r.code || r.article || '—',
        quantity: r.quantity || 0,
        price:    (r.price || 0) / 100
      };
      if (item.quantity <= 0) catMap[cat].out.push(item);
      else catMap[cat].low.push(item);
    });

    // Sort items within each category by name; sort categories by severity
    const categories = Object.values(catMap).map(cat => ({
      ...cat,
      out: cat.out.sort((a, b) => a.name.localeCompare(b.name)),
      low: cat.low.sort((a, b) => a.name.localeCompare(b.name)),
      total: cat.out.length + cat.low.length
    })).sort((a, b) => b.out.length - a.out.length || b.low.length - a.low.length);

    res.render('stock-alerts', {
      ...c, active: 'stock-alerts',
      categories,
      outTotal:  outItems.length,
      lowTotal:  lowItems.length,
      totalSKU:  rows.length,
      threshold: LOW_THRESHOLD
    });
  } catch(e) { res.status(500).render('error', { message: e.message }); }
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
