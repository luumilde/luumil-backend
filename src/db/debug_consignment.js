import { query } from './pool.js';

// Diagnóstico: órdenes en consignación, su lugar de entrega, y si ya tienen
// movimientos de inventario. Uso: node src/db/debug_consignment.js

async function run() {
  const r = await query(`
    SELECT po.folio, po.status, po.delivery_place, p.sku, pol.quantity_ordered, pol.quantity_received, pol.line_status,
      (SELECT COALESCE(SUM(sm.quantity),0) FROM stock_movements sm
        WHERE sm.product_id = pol.product_id AND sm.reference = po.folio) AS qty_en_movimientos
    FROM purchase_orders po
    JOIN purchase_order_lines pol ON pol.purchase_order_id = po.id
    LEFT JOIN products p ON p.id = pol.product_id
    WHERE po.is_consignment = TRUE
    ORDER BY po.folio, p.sku
  `);
  if (!r.rows.length) console.log('⚠️ No hay ninguna orden marcada como consignación (is_consignment).');
  r.rows.forEach(x => console.log(
    `${x.folio} | estado=${x.status} | entrega="${x.delivery_place}" | ${x.sku} | pedido=${x.quantity_ordered} recibido=${x.quantity_received} línea=${x.line_status} | en movimientos=${x.qty_en_movimientos}`));
  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
