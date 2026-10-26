import fs from 'fs';
import { query } from './pool.js';

// Actualiza products.name_de con "Beschreibung – Material" a partir de
// src/db/data/name_de.json (generado de "Etiquetas productos.xlsx").
// - Los SKUs de HOLD se saltan hasta que se resuelvan las dudas de traducción.
// - Antes de escribir guarda los valores actuales en products_name_de_backup.
// Uso:  node src/db/update_name_de.js           (simulación, no cambia nada)
//       node src/db/update_name_de.js --apply   (ejecuta)

// SKUs con dudas de traducción/consistencia (ver revisión): se actualizan cuando se confirmen.
const HOLD = new Set([
  'LUM-0072', 'LUM-0073', 'LUM-0107', 'LUM-0156', 'LUM-0165',
  'LUM-0273', 'LUM-0294',
  'LUM-0298', 'LUM-0299',
  'LUM-0315', 'LUM-0316', 'LUM-0318',
  'LUM-0353', 'LUM-0354',
]);

async function run() {
  const apply = process.argv.includes('--apply');
  const data = JSON.parse(fs.readFileSync(new URL('./data/name_de.json', import.meta.url), 'utf8'));

  const dbRes = await query(`SELECT id, sku, name_de FROM products`);
  const bySku = new Map(dbRes.rows.map(r => [r.sku, r]));

  const toUpdate = [], notFound = [], held = [];
  for (const d of data) {
    if (HOLD.has(d.sku)) { held.push(d.sku); continue; }
    const p = bySku.get(d.sku);
    if (!p) { notFound.push(d.sku); continue; }
    toUpdate.push({ id: p.id, sku: d.sku, old: p.name_de, name: `${d.beschreibung} – ${d.material}` });
  }
  const overwriting = toUpdate.filter(u => u.old && u.old.trim() && u.old !== u.name);
  const unchanged = toUpdate.filter(u => u.old === u.name);

  console.log(`En el archivo: ${data.length} · se actualizarán: ${toUpdate.length - unchanged.length} · ya iguales: ${unchanged.length}`);
  console.log(`Reemplazan un nombre alemán existente: ${overwriting.length}`);
  console.log(`En espera (HOLD): ${held.length} → ${held.join(', ')}`);
  console.log(`SKUs del archivo que NO existen en la base: ${notFound.length}${notFound.length ? ' → ' + notFound.join(', ') : ''}`);
  overwriting.slice(0, 8).forEach(u => console.log(`   ${u.sku}: "${u.old}"  →  "${u.name}"`));

  if (!apply) { console.log('Simulación: no se cambió nada. Para ejecutar: node src/db/update_name_de.js --apply'); process.exit(0); }

  await query(`CREATE TABLE IF NOT EXISTS products_name_de_backup (product_id INT, sku TEXT, name_de TEXT, backed_up_at TIMESTAMPTZ DEFAULT now())`);
  let n = 0;
  for (const u of toUpdate) {
    if (u.old === u.name) continue;
    await query(`INSERT INTO products_name_de_backup (product_id, sku, name_de) VALUES ($1,$2,$3)`, [u.id, u.sku, u.old]);
    await query(`UPDATE products SET name_de = $1 WHERE id = $2`, [u.name, u.id]);
    n++;
  }
  console.log(`✅ ${n} nombre(s) en alemán actualizados (copia previa en products_name_de_backup).`);
  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
