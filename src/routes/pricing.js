import express from 'express';
import { query } from '../db/pool.js';

const router = express.Router();

const GLOBAL_PCT_KEYS = ['packaging_shipping_pct', 'fair_costs_pct', 'marketing_pct', 'other_costs_pct'];

// Asegura que exista un multiplicador para cada categoría conocida
// (usada en productos o proveedores), más una fila 'Sin categoría' de respaldo.
async function ensureCategoryMultipliers() {
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
      `INSERT INTO category_pricing_multipliers (category) VALUES ($1) ON CONFLICT (category) DO NOTHING`,
      [row.val]
    );
  }
}

async function getGlobalSettings() {
  const r = await query(`SELECT key, value FROM app_settings`);
  const map = Object.fromEntries(r.rows.map(row => [row.key, parseFloat(row.value) || 0]));
  return {
    exchangeRate: map.eur_mxn_rate || 0,
    packagingShippingPct: map.packaging_shipping_pct || 0,
    fairCostsPct: map.fair_costs_pct || 0,
    marketingPct: map.marketing_pct || 0,
    otherCostsPct: map.other_costs_pct || 0,
  };
}

// GET /api/pricing/settings — configuración global de costos + multiplicador por categoría
router.get('/settings', async (req, res) => {
  try {
    await ensureCategoryMultipliers();
    const settings = await getGlobalSettings();
    const multipliers = await query(`SELECT category, multiplier FROM category_pricing_multipliers ORDER BY category`);
    res.json({ ...settings, multipliers: multipliers.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch pricing settings' });
  }
});

// PUT /api/pricing/settings — guarda configuración global y/o multiplicadores por categoría
router.put('/settings', async (req, res) => {
  try {
    const { exchangeRate, packagingShippingPct, fairCostsPct, marketingPct, otherCostsPct, multipliers } = req.body;

    const kv = {
      eur_mxn_rate: exchangeRate,
      packaging_shipping_pct: packagingShippingPct,
      fair_costs_pct: fairCostsPct,
      marketing_pct: marketingPct,
      other_costs_pct: otherCostsPct,
    };
    for (const [key, value] of Object.entries(kv)) {
      if (value === undefined) continue;
      await query(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ($1,$2, now())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
        [key, String(parseFloat(value) || 0)]
      );
    }

    for (const m of (multipliers || [])) {
      await query(
        `INSERT INTO category_pricing_multipliers (category, multiplier, updated_at)
         VALUES ($1,$2, now())
         ON CONFLICT (category) DO UPDATE SET multiplier = $2, updated_at = now()`,
        [m.category, parseFloat(m.multiplier) || 1]
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
    const { search, category, supplierId } = req.query;
    const settings = await getGlobalSettings();
    const totalPct = settings.packagingShippingPct + settings.fairCostsPct + settings.marketingPct + settings.otherCostsPct;

    // Solo productos que ya están en al menos una orden de compra
    let sql = `
      SELECT p.id, p.sku, p.name_es, p.photos, p.purchase_price_mxn, p.sale_price_eur,
        p.categories, s.id AS supplier_id, s.name AS supplier_name,
        COALESCE(m.multiplier, 1) AS multiplier
      FROM products p
      LEFT JOIN suppliers s ON s.id = p.supplier_id
      LEFT JOIN category_pricing_multipliers m ON m.category = COALESCE(p.categories[1], 'Sin categoría')
      WHERE EXISTS (SELECT 1 FROM purchase_order_lines pol WHERE pol.product_id = p.id)
    `;
    const conditions = [];
    const params = [];
    if (search) { params.push(`%${search}%`); conditions.push(`(p.name_es ILIKE $${params.length} OR p.sku ILIKE $${params.length})`); }
    if (category) { params.push(category); conditions.push(`COALESCE(p.categories[1], 'Sin categoría') = $${params.length}`); }
    if (supplierId) { params.push(supplierId); conditions.push(`s.id = $${params.length}`); }
    if (conditions.length) sql += ' AND ' + conditions.join(' AND ');
    sql += ' ORDER BY p.name_es';

    const result = await query(sql, params);
    const rows = result.rows.map(p => {
      const purchasePrice = parseFloat(p.purchase_price_mxn) || 0;
      const costoConCargosMxn = purchasePrice * (1 + totalPct / 100);
      const costoFinalMxn = costoConCargosMxn * (parseFloat(p.multiplier) || 1);
      const precioSugeridoEur = settings.exchangeRate > 0 ? costoFinalMxn / settings.exchangeRate : null;
      return {
        ...p,
        totalPct,
        costoFinalMxn: Math.round(costoFinalMxn * 100) / 100,
        precioSugeridoEur: precioSugeridoEur != null ? Math.round(precioSugeridoEur * 100) / 100 : null,
        exchangeRate: settings.exchangeRate,
      };
    });
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch product pricing' });
  }
});

export default router;
