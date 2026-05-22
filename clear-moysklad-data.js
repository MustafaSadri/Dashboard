require('dotenv').config();
const { MongoClient } = require('mongodb');

const URI = process.env.MONGODB_URI;
const DB = process.env.MONGODB_DB_NAME || 'tally_sync';

const MOYSKLAD_COLLECTIONS = [
  'ms_customers',
  'ms_demands',
  'ms_orders',
  'ms_stock',
  'ms_sync_meta',
];

async function main() {
  if (!URI) {
    console.error('MONGODB_URI not set in .env');
    process.exit(1);
  }

  const client = new MongoClient(URI);
  await client.connect();

  try {
    const db = client.db(DB);
    const existing = new Set((await db.listCollections().toArray()).map(c => c.name));
    let dropped = 0;

    console.log(`Connected to MongoDB database "${DB}"`);
    console.log('Dropping MoySklad collections only...');

    for (const name of MOYSKLAD_COLLECTIONS) {
      if (!existing.has(name)) {
        console.log(`Skipped missing collection: ${name}`);
        continue;
      }
      await db.collection(name).drop();
      dropped++;
      console.log(`Dropped collection: ${name}`);
    }

    console.log(`\nDone. Dropped ${dropped} MoySklad collection(s).`);
    console.log('Tally collections were not touched.');
  } finally {
    await client.close();
  }
}

main().catch(e => {
  console.error(e.message);
  process.exit(1);
});
