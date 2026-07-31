import { query } from './pool.js';

// Corrige datos existentes: las órdenes con status 'paid' ya tienen sus
// productos con bodega asignada (vía el endpoint de sincronización de
// inventario), pero purchase_order_lines.line_status se quedó en 'pending'
// porque esa sincronización no actualizaba la línea de la orden. Este script
// marca esas líneas como 'complete' (recibidas por completo), que es lo que
// realmente refleja la realidad del inventario.

async function run() {
  console.log('Buscando líneas de órdenes paid que siguen marcadas pending/partial...');

  const before = await query(`
    SELECT pol.id, po.folio, pol.line_status, pol.quantity_ordered, pol.quantity_received
    FROM purchase_order_lines pol
    JOIN purchase_orders po ON po.id = pol.purchase_order_id
    WHERE po.status = 'paid' AND pol.line_status != 'complete'
  `);
  console.log(`Encontradas ${before.rows.length} línea(s) a corregir.`);
  before.rows.forEach(r => console.log(`  ${r.folio} · línea ${r.id} · estaba: ${r.line_status} (${r.quantity_received}/${r.quantity_ordered})`));

  if (before.rows.length === 0) {
    console.log('Nada que corregir. ✅');
    process.exit(0);
  }

  const result = await query(`
    UPDATE purchase_order_lines pol
    SET quantity_received = pol.quantity_ordered, line_status = 'complete'
    FROM purchase_orders po
    WHERE pol.purchase_order_id = po.id
      AND po.status = 'paid'
      AND pol.line_status != 'complete'
    RETURNING pol.id
  `);
  console.log(`✅ ${result.rows.length} línea(s) actualizada(s) a 'complete'.`);
  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
