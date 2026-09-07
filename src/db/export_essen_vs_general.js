import { query } from './pool.js';

// Imprime en CSV (para copiar/pegar) el precio general vs el precio de la
// feria "Essen" por producto. Uso: node src/db/export_essen_vs_general.js

async function run() {
  const result = await query(`
    WITH settings AS (
      SELECT
        MAX(CASE WHEN key='eur_mxn_rate' THEN value::numeric END) AS exchange_rate,
        MAX(CASE WHEN key='packaging_shipping_pct' THEN value::numeric END) AS packaging_pct,
        MAX(CASE WHEN key='marketing_pct' THEN value::numeric END) AS marketing_pct,
        MAX(CASE WHEN key='other_costs_pct' THEN value::numeric END) AS other_pct,
        MAX(CASE WHEN key='general_multiplier' THEN value::numeric END) AS general_multiplier
      FROM app_settings
    ),
    fair AS (
      SELECT id, name, total_cost_eur FROM fairs WHERE name ILIKE '%Essen%' ORDER BY created_at DESC LIMIT 1
    ),
    fair_qty AS (
      SELECT COALESCE(SUM(quantity),0) AS total_qty FROM fair_products WHERE fair_id = (SELECT id FROM fair)
    ),
    assigned AS (
      SELECT p.id AS product_id, p.sku, p.name_es, p.sale_price_eur, p.purchase_price_mxn,
        COALESCE(p.categories[1],'Sin categoría') AS categoria
      FROM fair_products fp
      JOIN products p ON p.id = fp.product_id
      WHERE fp.fair_id = (SELECT id FROM fair)
    ),
    priced AS (
      SELECT
        a.sku, a.name_es, s.exchange_rate,
        CASE WHEN a.sale_price_eur IS NOT NULL THEN a.sale_price_eur
             ELSE (a.purchase_price_mxn * (1 + (s.packaging_pct+s.marketing_pct+s.other_pct)/100) * s.general_multiplier) / NULLIF(s.exchange_rate,0)
        END AS general_eur,
        COALESCE(fcm.multiplier, s.general_multiplier) AS fair_multiplier,
        (SELECT total_cost_eur FROM fair) AS fair_total_cost_eur,
        (SELECT total_qty FROM fair_qty) AS fair_total_qty
      FROM assigned a
      CROSS JOIN settings s
      LEFT JOIN fair_category_multipliers fcm ON fcm.fair_id = (SELECT id FROM fair) AND fcm.category = a.categoria
    )
    SELECT
      sku, name_es,
      ROUND(general_eur * exchange_rate, 2) AS precio_general_mxn,
      ROUND(general_eur, 2) AS precio_general_eur,
      ROUND(((general_eur * exchange_rate) + (fair_total_cost_eur / NULLIF(fair_total_qty,0)) * exchange_rate) * fair_multiplier, 2) AS precio_essen_mxn,
      ROUND((((general_eur * exchange_rate) + (fair_total_cost_eur / NULLIF(fair_total_qty,0)) * exchange_rate) * fair_multiplier) / NULLIF(exchange_rate,0), 2) AS precio_essen_eur
    FROM priced
    ORDER BY sku
  `);

  if (result.rows.length === 0) {
    console.log('Sin productos asignados a una feria con "Essen" en el nombre.');
    process.exit(0);
  }

  const cols = ['sku','name_es','precio_general_mxn','precio_general_eur','precio_essen_mxn','precio_essen_eur'];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
  };
  console.log(cols.join(','));
  for (const row of result.rows) {
    console.log(cols.map(c => esc(row[c])).join(','));
  }
  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
