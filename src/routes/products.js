import express from 'express';
import { query, nextFolio } from '../db/pool.js';

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const { search } = req.query;
    let sql = `SELECT p.*, s.name as supplier_name FROM products p
               LEFT JOIN suppliers s ON p.supplier_id = s.id`;
    const params = [];
    if (search) {
      sql += ' WHERE p.name_es ILIKE $1 OR p.sku ILIKE $1';
      params.push(`%${search}%`);
    }
    sql += ' ORDER BY p.created_at DESC';
    const result = await query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const result = await query(
      `SELECT p.*, s.name as supplier_name FROM products p
       LEFT JOIN suppliers s ON p.supplier_id = s.id WHERE p.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch product' });
  }
});

router.post('/', async (req, res) => {
  try {
    const b = req.body;
    const sku = await nextFolio('LUM');
    const result = await query(
      `INSERT INTO products
        (sku, supplier_id, name_es, name_de, categories, materials,
         height_cm, width_cm, depth_cm, weight_g, fragile,
         purchase_price_mxn, last_paid_price_mxn, sale_price_eur,
         hs_code, regulatory_status, requires_cites, requires_phytosanitary,
         customs_description_de, notes, photos, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       RETURNING *`,
      [
        sku, b.supplierId || null, b.nameEs, b.nameDe, b.categories || [], b.materials || [],
        b.heightCm || null, b.widthCm || null, b.depthCm || null, b.weightG || null, b.fragile || false,
        parseFloat(b.purchasePriceMxn) || null, parseFloat(b.purchasePriceMxn) || null, parseFloat(b.salePriceEur) || null,
        b.hsCode, b.regulatoryStatus || 'green', b.requiresCites || false, b.requiresPhytosanitary || false,
        b.customsDescriptionDe, b.notes, JSON.stringify(b.photos || {}), req.user?.userName,
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const b = req.body;

    // Determinar si el precio cambió para actualizar last_paid_price_mxn
    const existing = await query('SELECT purchase_price_mxn FROM products WHERE id=$1', [req.params.id]);
    const oldPrice = parseFloat(existing.rows[0]?.purchase_price_mxn) || 0;
    const newPrice = parseFloat(b.purchasePriceMxn) || 0;
    const lastPaidPrice = newPrice !== oldPrice ? newPrice : oldPrice;

    const result = await query(
      `UPDATE products SET
        supplier_id=$1, name_es=$2, name_de=$3, categories=$4, materials=$5,
        height_cm=$6, width_cm=$7, depth_cm=$8, weight_g=$9, fragile=$10,
        purchase_price_mxn=$11, last_paid_price_mxn=$12, sale_price_eur=$13,
        hs_code=$14, regulatory_status=$15, requires_cites=$16, requires_phytosanitary=$17,
        customs_description_de=$18, notes=$19, photos=$20, updated_at=now()
       WHERE id=$21 RETURNING *`,
      [
        b.supplierId || null, b.nameEs, b.nameDe, b.categories || [], b.materials || [],
        b.heightCm || null, b.widthCm || null, b.depthCm || null, b.weightG || null, b.fragile || false,
        newPrice || null, lastPaidPrice || null, parseFloat(b.salePriceEur) || null,
        b.hsCode, b.regulatoryStatus || 'green', b.requiresCites || false, b.requiresPhytosanitary || false,
        b.customsDescriptionDe, b.notes, JSON.stringify(b.photos || {}), req.params.id,
      ]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await query('DELETE FROM products WHERE id = $1', [req.params.id]);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

export default router;
