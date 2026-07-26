import { query } from './pool.js';

async function migrate() {
  // Ubicaciones
  await query(`
    CREATE TABLE IF NOT EXISTS inventory_locations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL UNIQUE,
      type VARCHAR(30) NOT NULL DEFAULT 'warehouse',
      country VARCHAR(10) DEFAULT 'MX',
      is_active BOOLEAN DEFAULT TRUE,
      sort_order INT DEFAULT 0
    )
  `);

  // Insertar ubicaciones base
  await query(`
    INSERT INTO inventory_locations (name, type, country, sort_order) VALUES
      ('Bodega MX (CDMX)', 'warehouse', 'MX', 1),
      ('En tránsito (MX→DE)', 'transit', 'TR', 2),
      ('Bodega Munich', 'warehouse', 'DE', 3)
    ON CONFLICT (name) DO NOTHING
  `);

  // Movimientos de inventario
  await query(`
    CREATE TABLE IF NOT EXISTS stock_movements (
      id SERIAL PRIMARY KEY,
      product_id INT NOT NULL REFERENCES products(id),
      from_location_id INT REFERENCES inventory_locations(id),
      to_location_id INT REFERENCES inventory_locations(id),
      quantity INT NOT NULL CHECK (quantity > 0),
      movement_type VARCHAR(30) NOT NULL,
      reference VARCHAR(100),
      notes TEXT,
      movement_date DATE NOT NULL DEFAULT CURRENT_DATE,
      created_by VARCHAR(100),
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  // Vista de stock actual
  await query(`
    CREATE OR REPLACE VIEW current_stock AS
    SELECT
      p.id AS product_id,
      p.sku,
      p.name_es,
      array_to_string(p.categories, ';') AS categories,
      array_to_string(p.materials, ';') AS materials,
      p.photos,
      s.name AS supplier_name,
      l.id AS location_id,
      l.name AS location_name,
      l.type AS location_type,
      l.country,
      COALESCE(SUM(
        CASE
          WHEN sm.to_location_id = l.id THEN sm.quantity
          WHEN sm.from_location_id = l.id THEN -sm.quantity
          ELSE 0
        END
      ), 0) AS qty
    FROM inventory_locations l
    CROSS JOIN products p
    LEFT JOIN suppliers s ON p.supplier_id = s.id
    LEFT JOIN stock_movements sm ON sm.product_id = p.id
      AND (sm.to_location_id = l.id OR sm.from_location_id = l.id)
    WHERE l.is_active = TRUE
    GROUP BY p.id, p.sku, p.name_es, p.categories, p.materials, p.photos, s.name, l.id, l.name, l.type, l.country
    HAVING COALESCE(SUM(
      CASE
        WHEN sm.to_location_id = l.id THEN sm.quantity
        WHEN sm.from_location_id = l.id THEN -sm.quantity
        ELSE 0
      END
    ), 0) > 0
  `);

  console.log('✅ Inventory tables created');
  process.exit(0);
}

migrate().catch(err => { console.error(err); process.exit(1); });
