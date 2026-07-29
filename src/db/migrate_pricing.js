import { query } from './pool.js';

async function migrate() {
  console.log('Running pricing migration...');

  // Multiplicador por categoría — se aplica al costo final ya calculado
  await query(`
    CREATE TABLE IF NOT EXISTS category_pricing_multipliers (
      category TEXT PRIMARY KEY,
      multiplier NUMERIC NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ DEFAULT now()
    )
  `);
  console.log('  ✅ category_pricing_multipliers');

  // Si existe la tabla vieja de reglas por categoría (versión anterior de este
  // módulo, nunca desplegada a producción), la eliminamos para no dejar basura.
  await query(`DROP TABLE IF EXISTS category_pricing_rules`);

  // Configuración global — aplica igual a todas las categorías
  await query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMPTZ DEFAULT now()
    )
  `);
  console.log('  ✅ app_settings');

  await query(`
    INSERT INTO app_settings (key, value) VALUES
      ('eur_mxn_rate', '20'),
      ('packaging_shipping_pct', '0'),
      ('fair_costs_pct', '0'),
      ('marketing_pct', '0'),
      ('other_costs_pct', '0')
    ON CONFLICT (key) DO NOTHING
  `);
  console.log('  ✅ seeds de configuración global (ajústalos en la pantalla de configuración)');

  console.log('✅ Done');
  process.exit(0);
}

migrate().catch(err => { console.error(err); process.exit(1); });
