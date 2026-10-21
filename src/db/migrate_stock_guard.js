import { query } from './pool.js';

// Candado a nivel base de datos: ningún movimiento de inventario puede sacar
// más piezas de una bodega de las que tiene. Aplica a TODOS los caminos
// (traslados, ajustes, ventas, scripts) y es atómico: bloquea por producto
// mientras revisa, así que dos capturas simultáneas no pueden pasarse del stock.
// Las entradas (sin bodega origen) no se validan.
// Uso: node src/db/migrate_stock_guard.js

async function migrate() {
  console.log('Instalando candado de stock negativo...');

  await query(`
    CREATE OR REPLACE FUNCTION prevent_negative_stock() RETURNS trigger AS $$
    DECLARE
      avail NUMERIC;
    BEGIN
      IF NEW.from_location_id IS NULL THEN
        RETURN NEW;
      END IF;

      PERFORM pg_advisory_xact_lock(NEW.product_id);

      SELECT COALESCE(SUM(
        CASE WHEN to_location_id = NEW.from_location_id THEN quantity
             WHEN from_location_id = NEW.from_location_id THEN -quantity
             ELSE 0 END
      ), 0) INTO avail
      FROM stock_movements WHERE product_id = NEW.product_id;

      IF NEW.quantity > avail THEN
        RAISE EXCEPTION 'Stock insuficiente: solo hay % pieza(s) disponibles en esa bodega', avail
          USING ERRCODE = 'P0001';
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  console.log('  ✅ función prevent_negative_stock');

  await query(`DROP TRIGGER IF EXISTS trg_prevent_negative_stock ON stock_movements`);
  await query(`
    CREATE TRIGGER trg_prevent_negative_stock
    BEFORE INSERT ON stock_movements
    FOR EACH ROW EXECUTE FUNCTION prevent_negative_stock()
  `);
  console.log('  ✅ trigger trg_prevent_negative_stock');

  console.log('✅ Done');
  process.exit(0);
}

migrate().catch(err => { console.error(err); process.exit(1); });
