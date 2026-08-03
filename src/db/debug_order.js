import { query } from './pool.js';

// Diagnóstico: revisa las líneas de una orden de compra y si están
// correctamente vinculadas a un producto del catálogo.
// Uso: node src/db/debug_order.js PC-0005

const folio = process.argv[2];
if (!folio) { console.log('Uso: node src/db/debug_order.js <folio>'); process.exit(1); }

async function run() {
  const orderRes = await query(`
    SELECT po.*, s.name AS supplier_name FROM purchase_orders po
    LEFT JOIN suppliers s ON s.id = po.supplier_id
    WHERE po.folio = $1
  `, [folio]);
  if (!orderRes.rows.length) { console.log(`No existe ninguna orden con folio ${folio}`); process.exit(0); }
  const order = orderRes.rows[0];
  console.log(`Orden ${order.folio} — status: ${order.status} — proveedor: ${order.supplier_name || '—'}`);

  const lines = await query(`
    SELECT pol.id AS line_id, pol.product_id, pol.variant, pol.quantity_ordered, pol.quantity_received, pol.line_status,
      p.sku, p.name_es
    FROM purchase_order_lines pol
    LEFT JOIN products p ON p.id = pol.product_id
    WHERE pol.purchase_order_id = $1
    ORDER BY pol.id
  `, [order.id]);

  console.log(`\nLíneas de esta orden: ${lines.rows.length}`);
  lines.rows.forEach(l => {
    if (l.product_id) {
      console.log(`  línea ${l.line_id} · vinculada a ${l.sku} (${l.name_es}) · ${l.quantity_received}/${l.quantity_ordered} · line_status=${l.line_status}`);
    } else {
      console.log(`  línea ${l.line_id} · ⚠️ SIN producto vinculado (product_id=NULL) · variant/descripción="${l.variant||''}" · ${l.quantity_received}/${l.quantity_ordered} · line_status=${l.line_status}`);
    }
  });

  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
