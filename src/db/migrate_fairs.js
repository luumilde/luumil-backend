import { query } from './pool.js';

async function migrate() {
  console.log('Running fairs migration...');

  // Feria/evento: nombre y costo total (stand, viaje, etc.) a prorratear entre
  // los productos que se le asignen.
  await query(`
    CREATE TABLE IF NOT EXISTS fairs (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      total_cost_mxn NUMERIC NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    )
  `);
  console.log('  ✅ fairs');

  // Productos asignados a cada feria, con su precio EUR ajustado específico
  // para esa feria (un mismo producto puede tener un precio distinto por feria).
  await query(`
    CREATE TABLE IF NOT EXISTS fair_products (
      id SERIAL PRIMARY KEY,
      fair_id INTEGER NOT NULL REFERENCES fairs(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      sale_price_eur NUMERIC,
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(fair_id, product_id)
    )
  `);
  console.log('  ✅ fair_products');

  console.log('✅ Done');
  process.exit(0);
}

migrate().catch(err => { console.error(err); process.exit(1); });
