import { query } from './pool.js';

// Quita el precio intercompany de TODOS los productos que lo tengan: el costo
// base vuelve a ser el precio de compra del proveedor.
// Antes de borrar guarda una copia en la tabla intercompany_transfers_backup
// (por si hay que restaurar). Sin --apply solo muestra lo que haría.
// Uso:  node src/db/clear_intercompany_prices.js           (simulación)
//       node src/db/clear_intercompany_prices.js --apply   (ejecuta)

async function run() {
  const apply = process.argv.includes('--apply');

  const summary = await query(`
    SELECT COUNT(*)::int AS transfers, COUNT(DISTINCT product_id)::int AS products
    FROM intercompany_transfers
  `);
  const { transfers, products } = summary.rows[0];
  console.log(`Hay ${transfers} traslado(s) intercompany en ${products} producto(s).`);

  if (!transfers) { console.log('Nada que quitar.'); process.exit(0); }

  if (!apply) {
    console.log('Simulación: no se cambió nada. Para ejecutar: node src/db/clear_intercompany_prices.js --apply');
    process.exit(0);
  }

  await query(`CREATE TABLE IF NOT EXISTS intercompany_transfers_backup AS SELECT *, now() AS backed_up_at FROM intercompany_transfers WHERE false`);
  await query(`INSERT INTO intercompany_transfers_backup SELECT *, now() FROM intercompany_transfers`);
  console.log(`  ✅ copia guardada en intercompany_transfers_backup (${transfers} filas)`);

  await query(`DELETE FROM intercompany_transfers`);
  console.log(`✅ Precio intercompany quitado de ${products} producto(s). El costo base es ahora el precio de compra.`);
  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
