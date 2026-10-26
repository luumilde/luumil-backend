import { query } from './pool.js';

// Muestra los datos actuales en la base de los 14 SKUs con dudas de traducción.
// Uso: node src/db/check_pending_names.js
const SKUS = ['LUM-0072','LUM-0073','LUM-0107','LUM-0156','LUM-0165','LUM-0273','LUM-0294',
  'LUM-0298','LUM-0299','LUM-0315','LUM-0316','LUM-0318','LUM-0353','LUM-0354'];

async function run() {
  const r = await query(`
    SELECT sku, name_es, name_de, categories, materials, height_cm, width_cm, depth_cm, weight_g
    FROM products WHERE sku = ANY($1::text[]) ORDER BY sku`, [SKUS]);
  r.rows.forEach(p => {
    console.log(`${p.sku}`);
    console.log(`   ES: ${p.name_es}`);
    console.log(`   DE actual: ${p.name_de || '(vacío)'}`);
    console.log(`   Categorías: ${(p.categories || []).join('; ') || '—'} · Materiales: ${(p.materials || []).join('; ') || '—'}`);
    console.log(`   Medidas (cm): ${p.height_cm ?? '—'} x ${p.width_cm ?? '—'} x ${p.depth_cm ?? '—'} · Peso: ${p.weight_g ?? '—'} g`);
  });
  const missing = SKUS.filter(s => !r.rows.some(p => p.sku === s));
  if (missing.length) console.log(`⚠️ No encontrados en la base: ${missing.join(', ')}`);
  process.exit(0);
}
run().catch(err => { console.error(err); process.exit(1); });
