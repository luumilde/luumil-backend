import { query } from './pool.js';

// Detecta productos con stock NEGATIVO en alguna bodega (señal de movimientos
// capturados de más, como el traslado de 7 piezas cuando solo había 5).
// Uso: node src/db/find_negative_stock.js

async function run() {
  const r = await query(`
    SELECT p.sku, p.name_es, l.name AS bodega,
      SUM(CASE WHEN sm.to_location_id = l.id THEN sm.quantity
               WHEN sm.from_location_id = l.id THEN -sm.quantity ELSE 0 END) AS qty
    FROM stock_movements sm
    JOIN products p ON p.id = sm.product_id
    JOIN inventory_locations l ON l.id IN (sm.to_location_id, sm.from_location_id)
    GROUP BY p.sku, p.name_es, l.id, l.name
    HAVING SUM(CASE WHEN sm.to_location_id = l.id THEN sm.quantity
                    WHEN sm.from_location_id = l.id THEN -sm.quantity ELSE 0 END) < 0
    ORDER BY p.sku, l.name
  `);
  if (!r.rows.length) { console.log('✅ No hay productos con stock negativo'); process.exit(0); }
  console.log(`⚠️ ${r.rows.length} combinación(es) producto/bodega con stock negativo:`);
  r.rows.forEach(x => console.log(`  ${x.sku} · ${x.name_es} · ${x.bodega}: ${x.qty}`));
  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
