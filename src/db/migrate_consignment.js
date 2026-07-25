import { query } from './pool.js';
async function migrate() {
  await query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS is_consignment BOOLEAN DEFAULT FALSE`);
  console.log('✅ is_consignment column added');
  process.exit(0);
}
migrate().catch(err => { console.error(err); process.exit(1); });
