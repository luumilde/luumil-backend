import { query } from './pool.js';

// Costo de envío por lote (maletas, DHL, etc.): cada lote reparte su costo total (EUR)
// entre las piezas que entraron a Bodega Munich con ese envío. Cada producto queda con
// un costo de envío fijo por pieza que reemplaza el % de embalaje/envío en Pricing.
// Uso: node src/db/migrate_shipping_lots.js
async function migrate() {
  await query(`
    CREATE TABLE IF NOT EXISTS shipping_lots (
      id SERIAL PRIMARY KEY,
      name VARCHAR(150) NOT NULL,
      total_cost_eur NUMERIC NOT NULL,
      method VARCHAR(20) NOT NULL DEFAULT 'weight',
      notes TEXT,
      created_by VARCHAR(100),
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS shipping_lot_items (
      id SERIAL PRIMARY KEY,
      lot_id INT NOT NULL REFERENCES shipping_lots(id) ON DELETE CASCADE,
      product_id INT NOT NULL REFERENCES products(id),
      quantity INT NOT NULL,
      unit_cost_eur NUMERIC NOT NULL
    )
  `);
  await query(`ALTER TABLE shipping_lots ADD COLUMN IF NOT EXISTS price_pct NUMERIC NOT NULL DEFAULT 0`);
  await query(`CREATE INDEX IF NOT EXISTS idx_shipping_lot_items_product ON shipping_lot_items(product_id)`);
  console.log('✅ shipping_lots y shipping_lot_items listos');
  process.exit(0);
}
migrate().catch(err => { console.error(err); process.exit(1); });
