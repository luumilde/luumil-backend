import express from 'express';
import { query } from '../db/pool.js';
import { getGlobalSettings } from './pricing.js';

const router = express.Router();
const round2 = n => Math.round(n * 100) / 100;

// GET /api/fairs — lista de ferias con total de productos asignados
router.get('/', async (req, res) => {
  try {
    const r = await query(`
      SELECT f.*, COUNT(fp.id)::int AS product_count
      FROM fairs f
      LEFT JOIN fair_products fp ON fp.fair_id = f.id
      GROUP BY f.id
      ORDER BY f.created_at DESC
    `);
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch fairs' });
  }
});

// GET /api/fairs/assignable-products — productos que pueden asignarse a una feria:
// los que ya están en inventario (current_stock) o en alguna orden de compra
router.get('/assignable-products', async (req, res) => {
  try {
    const r = await query(`
      SELECT p.id, p.sku, p.name_es, p.categories, p.photos, p.purchase_price_mxn, s.name AS supplier_name
      FROM products p
      LEFT JOIN suppliers s ON s.id = p.supplier_id
      WHERE EXISTS (SELECT 1 FROM purchase_order_lines pol WHERE pol.product_id = p.id)
         OR EXISTS (SELECT 1 FROM current_stock cs WHERE cs.product_id = p.id)
      ORDER BY p.name_es
    `);
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch assignable products' });
  }
});

// POST /api/fairs
router.post('/', async (req, res) => {
  try {
    const { name, totalCostEur, notes } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
    const r = await query(
      `INSERT INTO fairs (name, total_cost_eur, notes) VALUES ($1,$2,$3) RETURNING *`,
      [name.trim(), parseFloat(totalCostEur) || 0, notes || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create fair' });
  }
});

// PUT /api/fairs/:id
router.put('/:id', async (req, res) => {
  try {
    const { name, totalCostEur, notes } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
    const r = await query(
      `UPDATE fairs SET name=$1, total_cost_eur=$2, notes=$3, updated_at=now() WHERE id=$4 RETURNING *`,
      [name.trim(), parseFloat(totalCostEur) || 0, notes || null, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Fair not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update fair' });
  }
});

// DELETE /api/fairs/:id
router.delete('/:id', async (req, res) => {
  try {
    await query(`DELETE FROM fairs WHERE id=$1`, [req.params.id]);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete fair' });
  }
});

// GET /api/fairs/:id/products — productos asignados, con precio calculado
// prorrateando el costo total de la feria entre el total de PIEZAS asignadas
// (no entre el número de SKUs)
router.get('/:id/products', async (req, res) => {
  try {
    const fairRes = await query(`SELECT * FROM fairs WHERE id=$1`, [req.params.id]);
    if (!fairRes.rows.length) return res.status(404).json({ error: 'Fair not found' });
    const fair = fairRes.rows[0];

    const settings = await getGlobalSettings();
    const basePct = settings.packagingShippingPct + settings.marketingPct + settings.otherCostsPct;

    const assigned = await query(`
      SELECT fp.product_id AS assignment_product_id, fp.sale_price_eur AS fair_sale_price_eur,
        fp.quantity,
        p.id, p.sku, p.name_es, p.photos, p.purchase_price_mxn, p.categories, s.name AS supplier_name,
        COALESCE(m.multiplier,1) AS multiplier
      FROM fair_products fp
      JOIN products p ON p.id = fp.product_id
      LEFT JOIN suppliers s ON s.id = p.supplier_id
      LEFT JOIN category_pricing_multipliers m ON m.category = COALESCE(p.categories[1], 'Sin categoría')
      WHERE fp.fair_id = $1
      ORDER BY p.name_es
    `, [req.params.id]);

    const productCount = assigned.rows.length;
    const totalQuantity = assigned.rows.reduce((sum, p) => sum + (parseInt(p.quantity) || 0), 0);
    // El costo de la feria se captura en EUR (se paga en Alemania); se prorratea
    // en EUR entre el total de piezas y se convierte a MXN con el tipo de cambio
    // para sumarlo al costo base — es el mismo monto por pieza para todos los productos.
    const fairCostPerUnitEur = totalQuantity > 0 ? (parseFloat(fair.total_cost_eur) || 0) / totalQuantity : 0;
    const fairCostPerUnitMxn = fairCostPerUnitEur * settings.exchangeRate;

    const products = assigned.rows.map(p => {
      const purchasePrice = parseFloat(p.purchase_price_mxn) || 0;
      // Costo base: el mismo cálculo (y el mismo número) que se ve en Pricing → General,
      // sin el costo de esta feria. Se muestra aparte para que ambas pantallas cuadren.
      const costoBaseMxn = purchasePrice * (1 + basePct / 100);
      const costoTotalMxn = costoBaseMxn + fairCostPerUnitMxn;
      const precioCalculadoMxn = costoTotalMxn * (parseFloat(p.multiplier) || 1);
      const costoBaseEur = settings.exchangeRate > 0 ? costoBaseMxn / settings.exchangeRate : null;
      const costoTotalEur = settings.exchangeRate > 0 ? costoTotalMxn / settings.exchangeRate : null;
      const precioCalculadoEur = settings.exchangeRate > 0 ? precioCalculadoMxn / settings.exchangeRate : null;
      return {
        ...p,
        fairCostPerUnitEur: round2(fairCostPerUnitEur),
        costoBaseMxn: round2(costoBaseMxn),
        costoBaseEur: costoBaseEur != null ? round2(costoBaseEur) : null,
        costoTotalMxn: round2(costoTotalMxn),
        costoTotalEur: costoTotalEur != null ? round2(costoTotalEur) : null,
        precioCalculadoMxn: round2(precioCalculadoMxn),
        precioCalculadoEur: precioCalculadoEur != null ? round2(precioCalculadoEur) : null,
        exchangeRate: settings.exchangeRate,
      };
    });

    res.json({
      fair: { ...fair, productCount, totalQuantity, fairCostPerUnitEur: round2(fairCostPerUnitEur) },
      products,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch fair products' });
  }
});

// POST /api/fairs/:id/products — asignar un producto a la feria
router.post('/:id/products', async (req, res) => {
  try {
    const { productId } = req.body;
    if (!productId) return res.status(400).json({ error: 'productId es requerido' });
    const r = await query(
      `INSERT INTO fair_products (fair_id, product_id) VALUES ($1,$2)
       ON CONFLICT (fair_id, product_id) DO NOTHING RETURNING *`,
      [req.params.id, productId]
    );
    res.status(201).json(r.rows[0] || { ok: true, alreadyAssigned: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to assign product' });
  }
});

// POST /api/fairs/:id/products/bulk — asignar varios productos de un jalón (selección masiva)
router.post('/:id/products/bulk', async (req, res) => {
  try {
    const { productIds } = req.body;
    if (!Array.isArray(productIds) || !productIds.length) return res.status(400).json({ error: 'productIds es requerido' });
    await query(
      `INSERT INTO fair_products (fair_id, product_id)
       SELECT $1, unnest($2::int[])
       ON CONFLICT (fair_id, product_id) DO NOTHING`,
      [req.params.id, productIds]
    );
    res.json({ ok: true, added: productIds.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to bulk assign products' });
  }
});

// DELETE /api/fairs/:id/products/:productId — quitar producto de la feria
router.delete('/:id/products/:productId', async (req, res) => {
  try {
    await query(`DELETE FROM fair_products WHERE fair_id=$1 AND product_id=$2`, [req.params.id, req.params.productId]);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to remove product from fair' });
  }
});

// PUT /api/fairs/:id/products/:productId/quantity — piezas de este producto para esta feria
router.put('/:id/products/:productId/quantity', async (req, res) => {
  try {
    const { quantity } = req.body;
    const qty = parseInt(quantity);
    if (!qty || qty < 1) return res.status(400).json({ error: 'La cantidad debe ser al menos 1' });
    const r = await query(
      `UPDATE fair_products SET quantity=$1 WHERE fair_id=$2 AND product_id=$3 RETURNING *`,
      [qty, req.params.id, req.params.productId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Assignment not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update quantity' });
  }
});

// PUT /api/fairs/:id/products/:productId/price — precio EUR ajustado específico de esta feria
router.put('/:id/products/:productId/price', async (req, res) => {
  try {
    const { salePriceEur } = req.body;
    const r = await query(
      `UPDATE fair_products SET sale_price_eur=$1 WHERE fair_id=$2 AND product_id=$3 RETURNING *`,
      [salePriceEur === '' || salePriceEur == null ? null : parseFloat(salePriceEur), req.params.id, req.params.productId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Assignment not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update fair price' });
  }
});

export default router;
