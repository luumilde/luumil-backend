import { query } from './pool.js';

// Antes de este fix, registrar una Recepción física actualizaba
// purchase_order_lines (quantity_received / line_status) pero NUNCA creaba
// un movimiento de inventario — por eso productos ya "Fully received" (como
// LUM-0096 de Raweli, orden PC-0016) aparecían sin bodega asignada en
// reportes / inventario. Este script reconstruye esos movimientos históricos
// a partir de las recepciones ya registradas.

const mapDeliveryPlace = (place) => {
  const map = {
    'Bodega MX (CDMX)': 'Bodega MX (CDMX)',
    'Bodega Munich': 'Bodega Munich',
    'En tránsito (MX→DE)': 'En tránsito (MX→DE)',
    'Workshop pickup': 'Bodega MX (CDMX)',
    'Courier': 'Bodega MX (CDMX)',
    'Store purchase': 'Bodega MX (CDMX)',
  };
  return map[place] || 'Bodega MX (CDMX)';
};

async function run() {
  console.log('Buscando recepciones sin movimiento de inventario...');

  const rows = await query(`
    SELECT rl.id AS reception_line_id, rl.quantity_received,
      pol.product_id, po.id AS order_id, po.folio AS order_folio,
      r.reception_place, r.folio AS reception_folio, r.reception_date
    FROM reception_lines rl
    JOIN receptions r ON r.id = rl.reception_id
    JOIN purchase_order_lines pol ON pol.id = rl.purchase_order_line_id
    JOIN purchase_orders po ON po.id = pol.purchase_order_id
    WHERE rl.quantity_received > 0
      AND NOT EXISTS (
        SELECT 1 FROM stock_movements sm
        WHERE sm.product_id = pol.product_id AND sm.reference = po.folio
      )
    ORDER BY r.reception_date
  `);

  console.log(`Encontradas ${rows.rows.length} línea(s) de recepción sin movimiento.`);
  if (rows.rows.length === 0) { console.log('Nada que corregir. ✅'); process.exit(0); }

  // Agrupar por producto+orden+ubicación, sumando cantidades (una orden puede
  // tener varias recepciones parciales del mismo producto al mismo lugar).
  const groups = {};
  for (const r of rows.rows) {
    const locName = mapDeliveryPlace(r.reception_place);
    const key = `${r.product_id}|${r.order_folio}|${locName}`;
    if (!groups[key]) groups[key] = {
      productId: r.product_id, orderFolio: r.order_folio, locName,
      qty: 0, receptionFolios: new Set(), date: r.reception_date,
    };
    groups[key].qty += parseFloat(r.quantity_received) || 0;
    groups[key].receptionFolios.add(r.reception_folio);
    if (r.reception_date > groups[key].date) groups[key].date = r.reception_date;
  }

  let created = 0;
  for (const g of Object.values(groups)) {
    const loc = await query('SELECT id FROM inventory_locations WHERE name=$1', [g.locName]);
    if (!loc.rows.length) { console.log(`  ⚠️ Ubicación no encontrada: ${g.locName}, se omite producto ${g.productId}`); continue; }
    await query(
      `INSERT INTO stock_movements
        (product_id, from_location_id, to_location_id, quantity, movement_type, reference, notes, movement_date, created_by)
       VALUES ($1, NULL, $2, $3, 'reception', $4, $5, $6, 'system')`,
      [
        g.productId, loc.rows[0].id, g.qty, g.orderFolio,
        `Backfill recepciones históricas (${[...g.receptionFolios].join(', ')})`,
        g.date ? new Date(g.date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
      ]
    );
    console.log(`  ✅ ${g.orderFolio} · producto ${g.productId} · ${g.qty} pza(s) → ${g.locName}`);
    created++;
  }

  console.log(`✅ ${created} movimiento(s) de inventario creado(s).`);
  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
