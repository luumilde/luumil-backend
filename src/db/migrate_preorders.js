import { pool } from './pool.js';

async function migrate() {
  console.log('Running pre-orders migration...');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS preorders (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL DEFAULT 'Pre-order',
      status TEXT DEFAULT 'draft', -- draft, converted
      created_by TEXT,
      updated_by TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    )
  `);
  console.log('  ✅ preorders table');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS preorder_lines (
      id SERIAL PRIMARY KEY,
      preorder_id INTEGER REFERENCES preorders(id) ON DELETE CASCADE,
      product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
      quantity NUMERIC NOT NULL DEFAULT 1,
      unit_price_mxn NUMERIC,
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(preorder_id, product_id)
    )
  `);
  console.log('  ✅ preorder_lines table');

  console.log('✅ Pre-orders migration complete');
  await pool.end();
}

migrate().catch(e => { console.error(e); process.exit(1); });
