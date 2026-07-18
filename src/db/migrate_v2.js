import { pool } from './pool.js';

async function migrate() {
  console.log('Running v2 migration...');

  // Nuevos campos en suppliers
  const supplierCols = [
    ['invoices', 'BOOLEAN DEFAULT false'],
    ['invoice_surcharge_pct', 'NUMERIC'],
    ['ships', 'BOOLEAN DEFAULT false'],
    ['bulk_discount', 'BOOLEAN DEFAULT false'],
    ['bulk_discount_min_pct', 'NUMERIC'],
    ['bulk_discount_max_pct', 'NUMERIC'],
    ['has_video', 'BOOLEAN DEFAULT false'],
    ['video_url', 'TEXT'],
  ];

  for (const [col, type] of supplierCols) {
    await pool.query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS ${col} ${type}`);
    console.log(`  ✅ suppliers.${col}`);
  }

  console.log('✅ Migration v2 complete');
  await pool.end();
}

migrate().catch(err => { console.error('❌ Migration failed:', err); process.exit(1); });
