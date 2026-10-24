import { query } from './pool.js';

// Mete al inventario las líneas de órdenes en consignación (no borrador/canceladas)
// que todavía no tienen movimiento. Equivale a "Sincronizar órdenes" en la app.
// Uso: node src/db/sync_consignment.js

const PLACES = {
  'Bodega MX (CDMX)': 'Bodega MX (CDMX)',
  'Bodega Munich': 'Bodega Munich',
  'En tránsito (MX→DE)': 'En tránsito (MX→DE)',
};

async function run() {
  const rows = (await query(`
    SELECT po.id, po.folio, po.delivery_place, po.delivery_date, pol.product_id, pol.quantity_ordered
    FROM purchase_orders po
    JOIN purchase_order_lines pol ON pol.purchase_order_id = po.id
    WHERE po.is_consignment = TRUE AND po.status NOT IN ('draft','cancelled')
      AND pol.product_id IS NOT NULL AND pol.quantity_ordered > 0
      AND NOT EXISTS (SELECT 1 FROM stock_movements sm WHERE sm.product_id = pol.product_id AND sm.reference = po.folio)
  `)).rows;

  let n = 0;
  for (const r of rows) {
    const locName = PLACES[r.delivery_place] || 'Bodega MX (CDMX)';
    const loc = await query('SELECT id FROM inventory_locations WHERE name=$1', [locName]);
    if (!loc.rows.length) continue;
    await query(`
      INSERT INTO stock_movements (product_id, from_location_id, to_location_id, quantity, movement_type, reference, notes, movement_date, created_by)
      VALUES ($1, NULL, $2, $3, 'order_paid', $4, $5, $6, 'system')
    `, [r.product_id, loc.rows[0].id, r.quantity_ordered, r.folio, `Consignación ${r.folio}`,
        r.delivery_date ? r.delivery_date.toISOString().split('T')[0] : new Date().toISOString().split('T')[0]]);
    await query(`UPDATE purchase_order_lines SET quantity_received = quantity_ordered, line_status='complete'
                 WHERE purchase_order_id=$1 AND product_id=$2`, [r.id, r.product_id]);
    n++;
    console.log(`  ✅ ${r.folio} → ${locName}: ${r.quantity_ordered} pzas (producto ${r.product_id})`);
  }
  console.log(`✅ ${n} línea(s) sincronizadas`);
  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
