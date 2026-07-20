import { pool } from './pool.js';

async function migrate() {
  console.log('Running payments migration...');
  const cols = [
    ['payment_method', "TEXT DEFAULT 'transfer'"],
    ['paid_by', 'TEXT'],
  ];
  for (const [col, type] of cols) {
    await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS ${col} ${type}`);
    console.log(`  ✅ payments.${col}`);
  }
  console.log('✅ Done');
  await pool.end();
}
migrate().catch(e => { console.error(e); process.exit(1); });
