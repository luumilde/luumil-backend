import { query } from './pool.js';

// Modo de distribución del costo de cada feria: per_piece (por defecto, como siempre),
// by_price o none; más cost_categories: categorías que absorben el costo. Uso: node src/db/migrate_fair_cost_distribution.js
async function migrate() {
  await query(`ALTER TABLE fairs ADD COLUMN IF NOT EXISTS cost_distribution VARCHAR(20) NOT NULL DEFAULT 'per_piece'`);
  await query(`UPDATE fairs SET cost_distribution='per_piece' WHERE cost_distribution='by_category'`);
  await query(`ALTER TABLE fairs ADD COLUMN IF NOT EXISTS cost_categories TEXT[]`);
  console.log('✅ fairs.cost_distribution (por defecto: per_piece) y fairs.cost_categories (vacío = todas) listos');
  process.exit(0);
}
migrate().catch(err => { console.error(err); process.exit(1); });
