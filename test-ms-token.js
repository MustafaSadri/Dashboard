'use strict';
require('dotenv').config();

const TOKEN = process.env.TOKEN || '';
const BASE  = 'https://api.moysklad.ru/api/remap/1.2';

if (!TOKEN) { console.error('ERROR: TOKEN not set in .env'); process.exit(1); }

async function msGet(path) {
  const r = await fetch(`${BASE}${path}`, {
    headers: { 'Authorization': `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(15000)
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`HTTP ${r.status}: ${body.slice(0, 300)}`);
  }
  return r.json();
}

async function main() {
  console.log('='.repeat(55));
  console.log('MoySklad API Token Test');
  console.log(`Token: ${TOKEN.slice(0, 8)}...${TOKEN.slice(-4)}`);
  console.log('='.repeat(55));

  // 1. Check who the token belongs to
  console.log('\n[1] Checking token identity (context/employee)...');
  const me = await msGet('/context/employee');
  console.log(`    Name     : ${me.fullName || me.name}`);
  console.log(`    Account  : ${me.accountId}`);

  // 2. Fetch latest 5 customer orders (salesorder)
  console.log('\n[2] Fetching latest 5 customer orders...');
  const ordersData = await msGet('/entity/customerorder?limit=5&order=moment,desc&expand=agent,state');
  const orders = ordersData.rows || [];

  if (!orders.length) {
    console.log('    No orders found.');
  } else {
    console.log(`    Total orders in account: ${ordersData.meta?.size ?? '?'}\n`);
    console.log('    #  | Order Number      | Date       | Customer                    | Amount (₽)  | Status');
    console.log('    ---|-------------------|------------|-----------------------------|-------------|-------');
    orders.forEach((o, i) => {
      const num      = (o.name || '—').padEnd(17);
      const date     = (o.moment || '').slice(0, 10);
      const customer = (o.agent?.name || '—').slice(0, 27).padEnd(27);
      const amount   = ((o.sum || 0) / 100).toFixed(2).padStart(11);
      const status   = o.state?.name || '—';
      console.log(`    ${i+1}  | ${num} | ${date} | ${customer} | ${amount} | ${status}`);
    });
  }

  // 3. Fetch latest 5 demands (shipments)
  console.log('\n[3] Fetching latest 5 shipments (demands)...');
  const demandsData = await msGet('/entity/demand?limit=5&order=moment,desc&expand=agent,state');
  const demands = demandsData.rows || [];

  if (!demands.length) {
    console.log('    No shipments found.');
  } else {
    console.log(`    Total shipments in account: ${demandsData.meta?.size ?? '?'}\n`);
    console.log('    #  | Shipment Number   | Date       | Customer                    | Amount (₽)');
    console.log('    ---|-------------------|------------|-----------------------------|------------');
    demands.forEach((d, i) => {
      const num      = (d.name || '—').padEnd(17);
      const date     = (d.moment || '').slice(0, 10);
      const customer = (d.agent?.name || '—').slice(0, 27).padEnd(27);
      const amount   = ((d.sum || 0) / 100).toFixed(2).padStart(11);
      console.log(`    ${i+1}  | ${num} | ${date} | ${customer} | ${amount}`);
    });
  }

  console.log('\n' + '='.repeat(55));
  console.log('Token is VALID. API is reachable.');
  console.log('='.repeat(55));
}

main().catch(e => {
  console.error('\nTEST FAILED:', e.message);
  process.exit(1);
});
