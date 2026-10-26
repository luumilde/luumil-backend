import { query } from './pool.js';

// Borra los precios definidos a mano:
//  1) fair_products.sale_price_eur  → precio final de cada producto en TODAS las ferias
//  2) products.sale_price_eur       → "Precio EUR asignado" de Pricing → General
// Después de esto el precio base vuelve a ser el calculado, y cada feria muestra
// propuestas nuevas (redondeadas a la decena) para aceptar o cambiar.
// Antes de borrar guarda copias en fair_products_price_backup y products_price_backup.
// Uso:  node src/db/clear_all_prices.js           (simulación, no cambia nada)
//       node src/db/clear_all_prices.js --apply   (ejecuta)

async function run() {
  const apply = process.argv.includes('--apply');

  const fp = (await query(`SELECT COUNT(*)::int AS n FROM fair_products WHERE sale_price_eur IS NOT NULL`)).rows[0].n;
  const pr = (await query(`SELECT COUNT(*)::int AS n FROM products WHERE sale_price_eur IS NOT NULL`)).rows[0].n;
  console.log(`Precios finales por feria con valor: ${fp}`);
  console.log(`Productos con "Precio EUR asignado": ${pr}`);

  if (!fp && !pr) { console.log('Nada que borrar.'); process.exit(0); }
  if (!apply) {
    console.log('Simulación: no se cambió nada. Para ejecutar: node src/db/clear_all_prices.js --apply');
    process.exit(0);
  }

  await query(`CREATE TABLE IF NOT EXISTS fair_products_price_backup (
    fair_id INT, product_id INT, sale_price_eur NUMERIC, backed_up_at TIMESTAMPTZ DEFAULT now())`);
  await query(`INSERT INTO fair_products_price_backup (fair_id, product_id, sale_price_eur)
               SELECT fair_id, product_id, sale_price_eur FROM fair_products WHERE sale_price_eur IS NOT NULL`);
  await query(`CREATE TABLE IF NOT EXISTS products_price_backup (
    product_id INT, sale_price_eur NUMERIC, backed_up_at TIMESTAMPTZ DEFAULT now())`);
  await query(`INSERT INTO products_price_backup (product_id, sale_price_eur)
               SELECT id, sale_price_eur FROM products WHERE sale_price_eur IS NOT NULL`);
  console.log('  ✅ copias guardadas (fair_products_price_backup, products_price_backup)');

  await query(`UPDATE fair_products SET sale_price_eur = NULL WHERE sale_price_eur IS NOT NULL`);
  await query(`UPDATE products SET sale_price_eur = NULL WHERE sale_price_eur IS NOT NULL`);
  console.log(`✅ Borrados ${fp} precio(s) final(es) de feria y ${pr} precio(s) asignado(s) de producto.`);
  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
