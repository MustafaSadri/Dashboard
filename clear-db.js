require('dotenv').config();
const { MongoClient } = require('mongodb');

const URI = process.env.MONGODB_URI;
const DB  = process.env.MONGODB_DB_NAME || 'tally_sync';

async function main() {
  if (!URI) { console.error('MONGODB_URI not set in .env'); process.exit(1); }

  const client = new MongoClient(URI);
  await client.connect();
  console.log('Connected to MongoDB Atlas');

  const db = client.db(DB);
  const collections = await db.listCollections().toArray();

  if (collections.length === 0) {
    console.log('Database is already empty.');
  } else {
    for (const col of collections) {
      await db.collection(col.name).drop();
      console.log(`Dropped collection: ${col.name}`);
    }
    console.log(`\nAll ${collections.length} collection(s) cleared from "${DB}".`);
  }

  await client.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });
