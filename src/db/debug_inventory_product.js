import { query } from './pool.js';

// Diagnóstico: por qué un producto no aparece en "Sin bodega" de Inventario.
// Uso: node src/db/debug_inventory_product.js LUM-0095

const sku = process.argv[2];
if (!sku) { console.log('Uso: node src/db/debug_inventory_product.js <SKU>'); process.exit(1); }

async function run() {
  const prodRes = await query('SELECT id, sku, name_es FROM products WHERE sku=$1', [sku]);
  if (!prodRes.rows.length) { console.log(`No existe ningún producto con SKU ${sku}`); process.exit(0); }
  const product = prodRes.rows[0];
  console.log(`Producto: ${product.sku} (id=${product.id}) — ${product.name_es}`);

  const lines = await query(`
    SELECT pol.id AS line_id, pol.product_id, pol.line_status, pol.quantity_ordered, pol.quantity_received,
      po.id AS order_id, po.folio, po.status AS order_status
    FROM purchase_order_lines pol
    JOIN purchase_orders po ON po.id = pol.purchase_order_id
    WHERE pol.product_id = $1
    ORDER BY po.created_at
  `, [product.id]);
  console.log(`\nLíneas de orden de compra vinculadas a este producto: ${lines.rows.length}`);
  lines.rows.forEach(l => {
    console.log(`  ${l.folio} (order status: ${l.order_status}) · línea ${l.line_id} · line_status=${l.line_status} · ${l.quantity_received}/${l.quantity_ordered} recibidas`);
  });
  if (lines.rows.length === 0) {
    console.log('  ⚠️ No hay ninguna línea de orden de compra con product_id apuntando a este producto.');
    console.log('     Esto explicaría por qué no aparece en "Sin bodega": la orden puede existir');
    console.log('     pero su línea no está vinculada al catálogo (product_id NULL), por ejemplo si');
    console.log('     se escribió a mano en vez de elegirlo del buscador de productos.');
  }

  const nonCancelled = lines.rows.filter(l => l.order_status !== 'cancelled');
  console.log(`\nLíneas en órdenes NO canceladas: ${nonCancelled.length}`);

  const stockRes = await query(`
    SELECT l.name AS location_name,
      COALESCE(SUM(CASE WHEN sm.to_location_id=l.id THEN sm.quantity WHEN sm.from_location_id=l.id THEN -sm.quantity ELSE 0 END),0) AS qty
    FROM inventory_locations l
    LEFT JOIN stock_movements sm ON sm.product_id=$1 AND (sm.to_location_id=l.id OR sm.from_location_id=l.id)
    WHERE l.is_active=TRUE
    GROUP BY l.id, l.name
  `, [product.id]);
  const totalQty = stockRes.rows.reduce((s,r)=>s+parseFloat(r.qty), 0);
  console.log(`\nStock actual por ubicación:`);
  stockRes.rows.forEach(r => console.log(`  ${r.location_name}: ${r.qty}`));
  console.log(`Total: ${totalQty}`);

  // Réplica exacta de la condición HAVING del endpoint /inventory/stock
  const wouldShow = totalQty > 0 || nonCancelled.length > 0;
  console.log(`\n¿Debería aparecer en la lista de Inventario (con stock o con orden no cancelada)? ${wouldShow ? 'SÍ' : 'NO'}`);
  console.log(`¿Debería aparecer bajo el filtro "Sin bodega"? ${wouldShow && totalQty === 0 ? 'SÍ' : 'NO'}`);

  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
