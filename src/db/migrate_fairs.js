import { query } from './pool.js';

async function migrate() {
  console.log('Running fairs migration...');

  // Feria/evento: nombre y costo total en EUR (stand, viaje, etc. — se paga en
  // Alemania) a prorratear entre los productos que se le asignen.
  await query(`
    CREATE TABLE IF NOT EXISTS fairs (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      total_cost_eur NUMERIC NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    )
  `);
  console.log('  ✅ fairs');

  // Si la tabla ya existía de una versión anterior con la columna en MXN,
  // la renombramos a EUR sin perder los datos.
  await query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='fairs' AND column_name='total_cost_mxn')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='fairs' AND column_name='total_cost_eur')
      THEN
        ALTER TABLE fairs RENAME COLUMN total_cost_mxn TO total_cost_eur;
      END IF;
    END $$;
  `);
  console.log('  ✅ renombrado total_cost_mxn → total_cost_eur (si aplicaba)');

  // Productos asignados a cada feria, con su precio EUR ajustado específico
  // para esa feria (un mismo producto puede tener un precio distinto por feria)
  // y la cantidad de piezas que se llevan — el costo de la feria se prorratea
  // entre el total de piezas, no entre el número de SKUs.
  await query(`
    CREATE TABLE IF NOT EXISTS fair_products (
      id SERIAL PRIMARY KEY,
      fair_id INTEGER NOT NULL REFERENCES fairs(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      quantity INTEGER NOT NULL DEFAULT 1,
      sale_price_eur NUMERIC,
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(fair_id, product_id)
    )
  `);
  console.log('  ✅ fair_products');

  await query(`ALTER TABLE fair_products ADD COLUMN IF NOT EXISTS quantity INTEGER NOT NULL DEFAULT 1`);
  console.log('  ✅ fair_products.quantity');

  // Multiplicador por categoría, propio de cada feria (reemplaza el multiplicador
  // por categoría que antes vivía en Pricing → General, ahora un solo multiplicador
  // general ahí — el detalle por categoría se configura feria por feria).
  await query(`
    CREATE TABLE IF NOT EXISTS fair_category_multipliers (
      id SERIAL PRIMARY KEY,
      fair_id INTEGER NOT NULL REFERENCES fairs(id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      multiplier NUMERIC NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(fair_id, category)
    )
  `);
  console.log('  ✅ fair_category_multipliers');

  console.log('✅ Done');
  process.exit(0);
}

migrate().catch(err => { console.error(err); process.exit(1); });
