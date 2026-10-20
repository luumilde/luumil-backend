import { query } from './pool.js';

// Diagnóstico: lista TODOS los movimientos de inventario de un producto, junto
// con lo comprado y recibido, para ver de dónde sale una cantidad en bodega
// mayor a la comprada (movimientos duplicados, traslados repetidos, etc.).
// Uso: node src/db/debug_stock_movements.js LUM-0297

const sku = process.argv[2];
if (!sku) { console.log('Uso: node src/db/debug_stock_movements.js <SKU>'); process.exit(1); }

async function run() {
  const prodRes = await query('SELECT id, sku, name_es FROM products WHERE sku=$1', [sku]);
  if (!prodRes.rows.length) { console.log(`No existe ningún producto con SKU ${sku}`); process.exit(0); }
  const product = prodRes.rows[0];
  console.log(`Producto: ${product.sku} (id=${product.id}) — ${product.name_es}`);

  const lines = await query(`
    SELECT po.folio, po.status AS order_status, pol.quantity_ordered, pol.quantity_received, pol.line_status
    FROM purchase_order_lines pol JOIN purchase_orders po ON po.id = pol.purchase_order_id
    WHERE pol.product_id = $1 ORDER BY po.created_at
  `, [product.id]);
  console.log(`\nCOMPRADO: ${lines.rows.length} línea(s)`);
  lines.rows.forEach(l => console.log(`  ${l.folio} (${l.order_status}) · pedidas ${l.quantity_ordered} · recibidas ${l.quantity_received} · ${l.line_status}`));

  const mv = await query(`
    SELECT sm.id, sm.movement_date, sm.created_at, sm.movement_type, sm.quantity, sm.reference, sm.notes, sm.created_by,
      lf.name AS from_loc, lt.name AS to_loc
    FROM stock_movements sm
    LEFT JOIN inventory_locations lf ON lf.id = sm.from_location_id
    LEFT JOIN inventory_locations lt ON lt.id = sm.to_location_id
    WHERE sm.product_id = $1
    ORDER BY sm.created_at, sm.id
  `, [product.id]);
  console.log(`\nMOVIMIENTOS DE INVENTARIO: ${mv.rows.length}`);
  mv.rows.forEach(m => {
    console.log(`  #${m.id} · ${m.movement_date?.toISOString?.().split('T')[0] || m.movement_date} · ${m.movement_type} · qty ${m.quantity} · ${m.from_loc || '—'} → ${m.to_loc || '—'} · ref=${m.reference || '—'} · por ${m.created_by || '—'}${m.notes ? ' · ' + m.notes : ''}`);
  });

  const stock = await query(`
    SELECT l.name,
      COALESCE(SUM(CASE WHEN sm.to_location_id=l.id THEN sm.quantity WHEN sm.from_location_id=l.id THEN -sm.quantity ELSE 0 END),0) AS qty
    FROM inventory_locations l
    LEFT JOIN stock_movements sm ON sm.product_id=$1 AND (sm.to_location_id=l.id OR sm.from_location_id=l.id)
    GROUP BY l.id, l.name ORDER BY l.name
  `, [product.id]);
  console.log(`\nSTOCK RESULTANTE:`);
  stock.rows.forEach(r => console.log(`  ${r.name}: ${r.qty}`));

  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
