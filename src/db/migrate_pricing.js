import { query } from './pool.js';

async function migrate() {
  console.log('Running pricing migration...');

  // Reglas de costeo por categoría — porcentajes sobre el precio de compra
  await query(`
    CREATE TABLE IF NOT EXISTS category_pricing_rules (
      category TEXT PRIMARY KEY,
      packaging_shipping_pct NUMERIC NOT NULL DEFAULT 0,
      fair_costs_pct NUMERIC NOT NULL DEFAULT 0,
      marketing_pct NUMERIC NOT NULL DEFAULT 0,
      other_costs_pct NUMERIC NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT now()
    )
  `);
  console.log('  ✅ category_pricing_rules');

  // Configuración general (tipo de cambio, y a futuro otros ajustes globales)
  await query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMPTZ DEFAULT now()
    )
  `);
  console.log('  ✅ app_settings');

  await query(`
    INSERT INTO app_settings (key, value) VALUES ('eur_mxn_rate', '20')
    ON CONFLICT (key) DO NOTHING
  `);
  console.log('  ✅ eur_mxn_rate seed (default 20, ajústalo en la pantalla de configuración)');

  console.log('✅ Done');
  process.exit(0);
}

migrate().catch(err => { console.error(err); process.exit(1); });
