import { query } from './pool.js';

// Diagnóstico: revisa por qué el reporte de catálogo no muestra el folio/monto
// del recibo simplificado para los productos de una orden — imprime las líneas
// de la orden (con su product_id), los fiscal_documents ligados a esa orden, y
// corre la MISMA subquery que usa /api/reports/product-catalog para cada
// producto de la orden, para ver exactamente qué devuelve.
// Uso: node src/db/debug_fiscal_documents.js PC-0016

const folio = process.argv[2];
if (!folio) { console.log('Uso: node src/db/debug_fiscal_documents.js <folio>'); process.exit(1); }

async function run() {
  const orderRes = await query(`SELECT * FROM purchase_orders WHERE folio = $1`, [folio]);
  if (!orderRes.rows.length) { console.log(`No existe ninguna orden con folio ${folio}`); process.exit(0); }
  const order = orderRes.rows[0];
  console.log(`Orden ${order.folio} (id=${order.id}) — status: ${order.status}`);

  const lines = await query(`
    SELECT pol.id AS line_id, pol.product_id, p.sku, p.name_es
    FROM purchase_order_lines pol
    LEFT JOIN products p ON p.id = pol.product_id
    WHERE pol.purchase_order_id = $1
    ORDER BY pol.id
  `, [order.id]);
  console.log(`\nLíneas de esta orden: ${lines.rows.length}`);
  lines.rows.forEach(l => {
    console.log(l.product_id
      ? `  línea ${l.line_id} · producto ${l.sku} (${l.name_es}) · product_id=${l.product_id}`
      : `  línea ${l.line_id} · ⚠️ SIN producto vinculado (product_id=NULL)`);
  });

  const docs = await query(`SELECT * FROM fiscal_documents WHERE purchase_order_id = $1 ORDER BY created_at`, [order.id]);
  console.log(`\nFiscal documents de esta orden: ${docs.rows.length}`);
  docs.rows.forEach(d => {
    console.log(`  id=${d.id} · doc_type="${d.doc_type}" · status="${d.status}" · folio="${d.folio}" · amount_mxn=${d.amount_mxn}`);
  });

  console.log(`\nResultado de la subquery del reporte (por producto):`);
  for (const l of lines.rows) {
    if (!l.product_id) continue;
    const r = await query(`
      SELECT STRING_AGG(
        fd.folio || CASE WHEN fd.amount_mxn IS NOT NULL THEN ' ($' || fd.amount_mxn || ')' ELSE '' END,
        ', ' ORDER BY fd.doc_date NULLS LAST
      ) AS recibo_info
      FROM purchase_order_lines pol
      JOIN purchase_orders po ON po.id = pol.purchase_order_id
      JOIN fiscal_documents fd ON fd.purchase_order_id = po.id
      WHERE pol.product_id = $1 AND fd.doc_type = 'recibo' AND fd.status != 'cancelado'
    `, [l.product_id]);
    console.log(`  ${l.sku}: recibo_info = ${JSON.stringify(r.rows[0].recibo_info)}`);
  }

  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
