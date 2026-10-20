import { query } from './pool.js';

// Corrección puntual: cambia la cantidad de UN movimiento de inventario.
// Uso: node src/db/fix_movement_quantity.js <id_movimiento> <nueva_cantidad>
// Ejemplo (LUM-0297, traslado #189 capturado con 7 en vez de 5):
//   node src/db/fix_movement_quantity.js 189 5

const id = parseInt(process.argv[2]);
const newQty = parseFloat(process.argv[3]);
if (!id || !(newQty > 0)) { console.log('Uso: node src/db/fix_movement_quantity.js <id_movimiento> <nueva_cantidad>'); process.exit(1); }

async function run() {
  const before = await query(`
    SELECT sm.id, sm.quantity, sm.movement_type, p.sku, lf.name AS from_loc, lt.name AS to_loc
    FROM stock_movements sm
    JOIN products p ON p.id = sm.product_id
    LEFT JOIN inventory_locations lf ON lf.id = sm.from_location_id
    LEFT JOIN inventory_locations lt ON lt.id = sm.to_location_id
    WHERE sm.id = $1
  `, [id]);
  if (!before.rows.length) { console.log(`No existe el movimiento #${id}`); process.exit(0); }
  const m = before.rows[0];
  console.log(`Movimiento #${m.id} · ${m.sku} · ${m.movement_type} · ${m.from_loc || '—'} → ${m.to_loc || '—'} · cantidad actual: ${m.quantity}`);

  await query('UPDATE stock_movements SET quantity = $1 WHERE id = $2', [newQty, id]);
  console.log(`✅ Cantidad cambiada de ${m.quantity} a ${newQty}`);
  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
