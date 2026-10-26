import { query } from './pool.js';

// Crea la bodega "Baja" para mover productos dañados o que ya no sirven.
// Es una ubicación de tipo 'writeoff': las piezas ahí NO cuentan como inventario
// disponible (ni para ferias, ni para totales).
// Uso: node src/db/migrate_baja_location.js

async function migrate() {
  await query(`
    INSERT INTO inventory_locations (name, type, country, sort_order, is_active)
    VALUES ('Baja', 'writeoff', 'MX', 99, TRUE)
    ON CONFLICT (name) DO UPDATE SET type = 'writeoff', is_active = TRUE
  `);
  console.log('✅ Bodega "Baja" lista');
  process.exit(0);
}

migrate().catch(err => { console.error(err); process.exit(1); });
