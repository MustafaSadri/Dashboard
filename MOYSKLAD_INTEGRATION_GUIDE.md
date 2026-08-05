# MoySklad Integration — Complete Guide for Coding Agents

This document covers everything about how MoySklad JSON API is used in the PLATINA dashboard.
Read this fully before writing any MoySklad-related code.

---

## 1. Authentication & Setup

```
Base URL : https://api.moysklad.ru/api/remap/1.2
Auth     : Bearer token (stored in .env as TOKEN)
```

Every request must include:
```js
headers: {
  'Authorization': 'Bearer ' + TOKEN,
  'Accept': 'application/json;charset=utf-8'
}
```

---

## 2. Core Fetch Helpers

### `ms(path)` — single request with retry
```js
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
      continue; // exponential backoff: 1s, 2s, 4s
    }
    if (!r.ok) throw new Error('MS API ' + r.status + ' ' + path);
    return r.json();
  }
}
```

### `msAll(endpoint)` — auto-paginate (handles >1000 records)
```js
async function msAll(endpoint, maxRecords = 10000) {
  const sep = endpoint.includes('?') ? '&' : '?';
  const first = await ms(`${endpoint}${sep}limit=1000&offset=0`);
  const total = first.meta?.size || 0;
  let rows = first.rows || [];

  if (total > 1000) {
    const pages = [];
    for (let offset = 1000; offset < Math.min(total, maxRecords); offset += 1000)
      pages.push(ms(`${endpoint}${sep}limit=1000&offset=${offset}`));
    const settled = await Promise.allSettled(pages);
    settled.forEach(r => { if (r.status === 'fulfilled') rows = rows.concat(r.value.rows || []); });
  }
  return { rows, total };
}
```

---

## 3. In-Memory Cache (TTL)

All heavy API calls are wrapped in `cached(key, ttlMs, fn)`.
This prevents duplicate calls when multiple routes need the same data.

```js
// Shared cached fetchers used across all routes:
const getStock         = () => cached('stock_all',      3*60*1000, () => ms('/report/stock/all?limit=1000').then(r => r.rows || []));
const getRecentDemands = () => cached('demands_200',      90*1000, () => ms('/entity/demand?limit=200&order=moment,desc').then(r => r.rows || []));
const getAllOrders      = () => cached('orders_all_v3',  2*60*1000, () => ms('/entity/customerorder?limit=1000&order=moment,desc&expand=state').then(r => r.rows || []));
```

Cache TTLs:
- Stock: 3 min
- Orders: 2 min
- Recent shipments: 90 sec
- State map: 15 min
- Employee map: 15 min
- Profit reports: 5 min

---

## 4. All Entities and What They Return

### `/entity/customerorder` — Sales Orders
```
Fields returned: id, name, moment (datetime), sum (kopecks), payedSum (kopecks),
  state{id, name, meta{href}}, agent{name, meta{href}}, owner{meta{href}},
  deliveryPlannedMoment, customerOrder (null for orders)
```
- `sum / 100` = order value in ₽
- `payedSum / 100` = amount paid so far
- `moment` format: `"2025-05-01 10:30:00.000"` — use `.slice(0,10)` for date

### `/entity/customerorder/{id}/positions` — Order Line Items
```
Fields: quantity, price (kopecks per unit), discount (%), assortment{meta{href}, name}
```
⚠ **CRITICAL TRICK**: Do NOT use `expand=assortment` on positions.
MoySklad silently caps page size to ~25 rows when expand is active, even if you set limit=1000.
Instead, fetch positions without expand, then resolve names via a separate assortment map.

### `/entity/demand` — Shipments (Outgoing Deliveries)
```
Fields: id, name, moment, sum, agent{name}, owner{meta{href}},
  customerOrder{meta{href}}   ← links back to the parent sales order
```
- A demand is created when an order is shipped out
- One order can have multiple demands (partial shipments)
- `demand.customerOrder.meta.href` → extract last URL segment = parent order ID

### `/entity/demand/{id}/positions` — Shipment Line Items
Same structure as order positions. Same trick applies — no expand=assortment.

### `/entity/counterparty/{id}` — Single Customer
```
Fields: id, name, phone, email, description, meta{href}
```

### `/entity/counterparty?limit=1000` — All Customers
Returns `{rows: [...], meta: {size: N}}`

### `/entity/employee?limit=1000` — All Employees / Salesmen
```
Fields: id, name, shortFio, uid, position, meta{href}
```
Extract UUID from `meta.href` (last URL segment) to build an ID→name map.

### `/entity/customerorder/metadata` — Order State Definitions
```
Returns: { states: {rows: [{id, name, meta{href}}, ...]} }
```
⚠ **TRICK**: `meta.states` is sometimes a plain array, sometimes `{rows:[]}`.
Always handle both:
```js
const statesArr = Array.isArray(meta.states) ? meta.states : (meta.states?.rows || []);
```

### `/entity/assortment?limit=1000` — All Products & Variants
```
Fields: id, name, meta{href, type}  (type = 'product' or 'variant')
```
Use this to build `href → name` map for resolving product names in positions
without needing expand=assortment.

### `/context/employee` — Logged-in User Info
Returns current user's name, position. Used to show employee name in navbar.

---

## 5. Reports

### `/report/stock/all?limit=1000` — Current Stock Levels
```
Each row: name, quantity, price, assortment{meta{href, type}, name}, folder{name}
```
- `quantity <= 0` = out of stock
- `quantity < 100` = low stock alert

### `/report/profit/byproduct` — Profit per Product
```
?momentFrom=2025-01-01 00:00:00&momentTo=2025-01-31 23:59:59&limit=10
Each row: assortment{name, meta{href}}, sellSum (kopecks), sellQuantity, profit
```
- `sellSum / 100` = actual revenue

### `/report/profit/bycounterparty` — Profit per Customer
```
?momentFrom=2025-01-01 00:00:00&momentTo=2025-01-31 23:59:59&limit=10
Each row: counterparty{name, meta{href}}, sellSum, profit
```

---

## 6. Filtering Syntax

Always URL-encode filter values with `encodeURIComponent()`.

```js
const enc = s => encodeURIComponent(s);

// Date range
?filter=${enc('moment>=2025-01-01 00:00:00;moment<=2025-01-31 23:59:59')}

// Semicolon = AND inside the filter string
// Greater than / less than (not >= for exclusive range)
?filter=${enc('moment>2025-01-01 00:00:00')}

// By customer (use full href)
?filter=${enc(`agent=${MS_BASE}/entity/counterparty/${customerId}`)}

// Combine with order and expand
/entity/demand?filter=${enc(filterStr)}&order=moment,desc&expand=agent
```

---

## 7. Order States — How to Resolve

MoySklad does not always return `state.name` directly. Sometimes it only returns `state.meta.href`.

**Build a state map first:**
```js
const meta = await ms('/entity/customerorder/metadata');
const statesArr = Array.isArray(meta.states) ? meta.states : (meta.states?.rows || []);
const stateMap = {};
statesArr.forEach(s => { if (s.id && s.name) stateMap[s.id] = s.name; });
```

**Resolve state for any order:**
```js
function resolveState(order, stateMap) {
  if (!order.state) return '';
  if (order.state.name) return order.state.name;   // already expanded
  const id = (order.state.meta?.href || '').split('/').pop().split('?')[0];
  return stateMap[id] || '';
}
```

**When fetching orders with `expand=state`**, `state.name` is usually present directly.
But `expand=state` does not always work consistently — always have the fallback map.

---

## 8. Order Status Classification

```js
// Draft = no state or state named "Draft"/"Черновик"
const isDraft = !order.state || /^draft$|черновик/i.test(resolveState(order, stateMap));

// Dispatched = shipped
const isDispatched = /dispatched|отгруж/i.test(stateName);

// Declined / cancelled
const isCancelled = /declin|cancel|отмен|отклон|аннул/i.test(stateName);

// Pending = has state + not dispatched + not cancelled + not draft
const isPending = !isDraft && !isDispatched && !isCancelled;
```

---

## 9. Salesman Attribution — The Tricky Part

**Rule:** Revenue is attributed to the salesman who owns the **sales order** (customerorder),
not the shipment (demand). This is because salesmen create orders; warehouse creates shipments.

**Problem:** Demands don't carry the salesman directly. The demand links to the parent order
via `demand.customerOrder.meta.href`. You must fetch the parent order to get its `owner`.

**Fallback:** Some demands have no parent order (standalone deliveries). In that case use
`demand.owner` instead.

```js
const orderOwnerUUID  = (parentOrder?.owner?.meta?.href || '').split('/').pop().split('?')[0];
const demandOwnerUUID = (demand.owner?.meta?.href       || '').split('/').pop().split('?')[0];
const ownerUUID = orderOwnerUUID || demandOwnerUUID;
const salesmanName = empMap[ownerUUID] || 'Unassigned';
```

**Performance trick:** Batch-fetch parent orders in groups of 30 with `Promise.allSettled`
to avoid N+1 calls.

---

## 10. Product Name Matching — Variants Trick

MoySklad products can have variants (e.g., "Shampoo (500ml)", "Shampoo (1L)").
Profit reports and stock sometimes return the base name, sometimes the variant name.

**Strip variant suffix to get base name:**
```js
const baseName = rawName.replace(/\s*\([^)]*\)\s*$/, '').trim() || rawName;
```

**Match both base name and all variants:**
```js
function nameMatches(name) {
  return name === rawName || name === baseName ||
         name.startsWith(baseName + ' ') ||
         name.startsWith(baseName + '/') ||
         name.startsWith(baseName + '(');
}
```

---

## 11. Positions Fetching — The `expand=assortment` Bug

**The bug:** When you use `expand=assortment` on `/positions`, MoySklad silently caps
results to ~25 rows per page regardless of `limit=1000`. You get no error — just missing data.

**The fix:** Fetch positions WITHOUT expand, then resolve product names via assortment map.

```js
// Build map once (cached 30 min)
async function getNameMap() {
  const { rows } = await msAll('/entity/assortment');
  const map = {};
  rows.forEach(a => { if (a.meta?.href && a.name) map[a.meta.href] = a.name; });
  return map;
}

// Fetch positions without expand
const positions = await ms(`/entity/demand/${id}/positions?limit=1000`);

// Resolve name
const nameMap = await getNameMap();
positions.rows.forEach(pos => {
  const name = nameMap[pos.assortment?.meta?.href] || pos.assortment?.name || '—';
});
```

---

## 12. Monetary Values

**All amounts in MoySklad are in kopecks (1/100 of a ruble).**
Always divide by 100 before displaying:

```js
const value = (order.sum || 0) / 100;      // ₽
const paid  = (order.payedSum || 0) / 100; // ₽
const price = (pos.price || 0) / 100;      // price per unit in ₽
```

For line item total:
```js
const lineTotal = (pos.quantity * pos.price * (1 - pos.discount / 100)) / 100;
```

---

## 13. Date Helpers

```js
// Today as YYYY-MM-DD (local time, not UTC)
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};

// First day of current month as "YYYY-MM-01 00:00:00"
const monthStart = () => {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-01 00:00:00`;
};

// Moment field slicing
const date = (order.moment || '').slice(0, 10);  // "2025-05-01"
const month = (order.moment || '').slice(0, 7);  // "2025-05"
```

---

## 14. All Dashboard Routes & What MoySklad Data They Use

| Route | MoySklad Calls |
|---|---|
| `GET /` Dashboard | demands (recent 200), customerorders (all 1000), stock, profit/byproduct, profit/bycounterparty, state map |
| `GET /orders-status` | customerorders + demands (from Dec 2025), state map, employees |
| `GET /inventory` | stock/all |
| `GET /salesman` | demands (filtered), customerorders (filtered), employees |
| `GET /customers` | counterparty list, profit/bycounterparty |
| `GET /shipments` | demands (all), counterparty count |
| `GET /sku-analysis` | demands (filtered), profit/byproduct, stock/all |
| `GET /customer-analytics/:id` | counterparty, customerorders (by customer), profit/byproduct (by customer) |
| `GET /product-analytics` | entity (product/variant), stock/all, profit/byproduct (per month), demand positions |
| `GET /api/orders/daily` | customerorders (filtered by date) |
| `GET /api/order-shipment-mismatch` | customerorders + demands (recent) |

---

## 15. Rate Limiting

MoySklad returns **HTTP 429** when you exceed the rate limit.
The `ms()` helper handles this automatically with exponential backoff (1s → 2s → 4s).

For parallel batch calls always use `Promise.allSettled` not `Promise.all` —
so one failed call doesn't crash the whole batch:

```js
const results = await Promise.allSettled(
  ids.map(id => ms(`/entity/customerorder/${id}`))
);
results.forEach((r, i) => {
  if (r.status === 'fulfilled') { /* use r.value */ }
  // failed ones are simply skipped
});
```

---

## 16. Pre-warming Cache on Login

On login, a loading screen shows while `GET /api/warm` pre-fetches all heavy data in parallel.
This ensures the dashboard loads instantly instead of waiting for API calls on first render.

```js
await Promise.allSettled([
  common(),                              // employee info + stock alerts
  getStock(),                            // all stock
  getAllOrders(),                         // all orders
  getRecentDemands(),                    // recent shipments
  getOrderStateMap(),                    // order state definitions
  getProfitByProduct(monthStart()),      // top products this month
  getProfitByCounterparty(monthStart()), // top customers this month
  getDemandsFromDec25(),                 // historical demands for charts
]);
```

---

## 17. Quick Reference — Common Mistakes to Avoid

| Mistake | Correct Approach |
|---|---|
| `expand=assortment` on positions | Never. Use assortment name map instead |
| `Promise.all` for batch calls | Use `Promise.allSettled` — one failure won't crash all |
| Displaying `order.sum` directly | Always divide by 100 (kopecks → rubles) |
| Checking `order.state.name` directly | Use `resolveState()` — name may not be expanded |
| Assuming `meta.states` is an array | It can be `{rows:[]}` — handle both |
| Building filters without encodeURIComponent | Always `enc()` the filter string |
| Fetching all data on every request | Wrap in `cached()` with appropriate TTL |
| Attributing revenue to shipment owner | Use parent customerorder's owner for salesman |
| Matching product names exactly | Strip variant suffix, use `startsWith(baseName)` |
| `order.state === null` = draft only | Also check if state name is "Draft"/"Черновик" |
