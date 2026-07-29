import express from 'express';
import { query } from '../db/pool.js';

const router = express.Router();

// Asegura que exista una fila de reglas de costeo para cada categoría conocida
// (usadas en productos o proveedores), más una fila 'Sin categoría' de respaldo.
async function ensureCategoryRules() {
  const cats = await query(`
    SELECT DISTINCT val FROM (
      SELECT unnest(categories) AS val FROM products WHERE categories IS NOT NULL
      UNION
      SELECT unnest(categories) AS val FROM suppliers WHERE categories IS NOT NULL
      UNION
      SELECT 'Sin categoría' AS val
    ) x WHERE val IS NOT NULL
  `);
  for (const row of cats.rows) {
    await query(
      `INSERT INTO category_pricing_rules (category) VALUES ($1) ON CONFLICT (category) DO NOTHING`,
      [row.val]
    );
  }
}

// GET /api/pricing/settings — tipo de cambio + reglas de costeo por categoría
router.get('/settings', async (req, res) => {
  try {
    await ensureCategoryRules();
    const rate = await query(`SELECT value FROM app_settings WHERE key='eur_mxn_rate'`);
    const rules = await query(`SELECT * FROM category_pricing_rules ORDER BY category`);
    res.json({
      exchangeRate: parseFloat(rate.rows[0]?.value) || 0,
      rules: rules.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch pricing settings' });
  }
});

// PUT /api/pricing/settings — guarda tipo de cambio y/o reglas de costeo
router.put('/settings', async (req, res) => {
  try {
    const { exchangeRate, rules } = req.body;
    if (exchangeRate != null && exchangeRate !== '') {
      await query(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ('eur_mxn_rate', $1, now())
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
        [String(exchangeRate)]
      );
    }
    for (const r of (rules || [])) {
      await query(
        `INSERT INTO category_pricing_rules
           (category, packaging_shipping_pct, fair_costs_pct, marketing_pct, other_costs_pct, updated_at)
         VALUES ($1,$2,$3,$4,$5, now())
         ON CONFLICT (category) DO UPDATE SET
           packaging_shipping_pct = $2, fair_costs_pct = $3, marketing_pct = $4, other_costs_pct = $5, updated_at = now()`,
        [
          r.category,
          parseFloat(r.packaging_shipping_pct) || 0,
          parseFloat(r.fair_costs_pct) || 0,
          parseFloat(r.marketing_pct) || 0,
          parseFloat(r.other_costs_pct) || 0,
        ]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save pricing settings' });
  }
});

// GET /api/pricing/products — precio calculado (MXN y EUR) por producto
router.get('/products', async (req, res) => {
  try {
    const { search, category } = req.query;
    const rateRow = await query(`SELECT value FROM app_settings WHERE key='eur_mxn_rate'`);
    const exchangeRate = parseFloat(rateRow.rows[0]?.value) || 0;

    let sql = `
      SELECT p.id, p.sku, p.name_es, p.photos, p.purchase_price_mxn, p.sale_price_eur,
        p.categories, s.name AS supplier_name,
        COALESCE(r.packaging_shipping_pct,0) AS packaging_shipping_pct,
        COALESCE(r.fair_costs_pct,0) AS fair_costs_pct,
        COALESCE(r.marketing_pct,0) AS marketing_pct,
        COALESCE(r.other_costs_pct,0) AS other_costs_pct
      FROM products p
      LEFT JOIN suppliers s ON s.id = p.supplier_id
      LEFT JOIN category_pricing_rules r ON r.category = COALESCE(p.categories[1], 'Sin categoría')
    `;
    const conditions = [];
    const params = [];
    if (search) { params.push(`%${search}%`); conditions.push(`(p.name_es ILIKE $${params.length} OR p.sku ILIKE $${params.length})`); }
    if (category) { params.push(category); conditions.push(`COALESCE(p.categories[1], 'Sin categoría') = $${params.length}`); }
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY p.name_es';

    const result = await query(sql, params);
    const rows = result.rows.map(p => {
      const pct = Number(p.packaging_shipping_pct) + Number(p.fair_costs_pct) + Number(p.marketing_pct) + Number(p.other_costs_pct);
      const purchasePrice = parseFloat(p.purchase_price_mxn) || 0;
      const costoTotalMxn = purchasePrice * (1 + pct / 100);
      const precioSugeridoEur = exchangeRate > 0 ? costoTotalMxn / exchangeRate : null;
      return {
        ...p,
        totalPct: pct,
        costoTotalMxn: Math.round(costoTotalMxn * 100) / 100,
        precioSugeridoEur: precioSugeridoEur != null ? Math.round(precioSugeridoEur * 100) / 100 : null,
        exchangeRate,
      };
    });
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch product pricing' });
  }
});

export default router;
