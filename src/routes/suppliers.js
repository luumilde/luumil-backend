import express from 'express';
import { query } from '../db/pool.js';

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const { search } = req.query;
    let sql = 'SELECT * FROM suppliers';
    const params = [];
    if (search) {
      sql += ' WHERE name ILIKE $1 OR technique ILIKE $1 OR state ILIKE $1 OR contact_name ILIKE $1';
      params.push(`%${search}%`);
    }
    sql += ' ORDER BY created_at DESC';
    const result = await query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch suppliers' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const result = await query('SELECT * FROM suppliers WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Supplier not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch supplier' });
  }
});

router.post('/', async (req, res) => {
  try {
    const b = req.body;
    const result = await query(
      `INSERT INTO suppliers
        (name, technique, state, municipality, street, city, zip_code, categories,
         contact_name, whatsapp, email, delivery_time, marketing_story,
         bank_name, account_holder, clabe, notes, photos,
         invoices, invoice_surcharge_pct, ships,
         bulk_discount, bulk_discount_min_pct, bulk_discount_max_pct,
         has_video, video_url, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
       RETURNING *`,
      [
        b.name, b.technique, b.state, b.municipality, b.street, b.city, b.zipCode,
        b.categories || [], b.contactName, b.whatsapp, b.email, b.deliveryTime,
        b.marketingStory, b.bankName, b.accountHolder, b.clabe, b.notes,
        JSON.stringify(b.photos || {}),
        b.invoices || false, b.invoiceSurchargePct || null, b.ships || false,
        b.bulkDiscount || false, b.bulkDiscountMinPct || null, b.bulkDiscountMaxPct || null,
        b.hasVideo || false, b.videoUrl || null, req.user?.userName,
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create supplier' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const b = req.body;
    const result = await query(
      `UPDATE suppliers SET
        name=$1, technique=$2, state=$3, municipality=$4, street=$5, city=$6, zip_code=$7,
        categories=$8, contact_name=$9, whatsapp=$10, email=$11, delivery_time=$12,
        marketing_story=$13, bank_name=$14, account_holder=$15, clabe=$16, notes=$17,
        photos=$18, invoices=$19, invoice_surcharge_pct=$20, ships=$21,
        bulk_discount=$22, bulk_discount_min_pct=$23, bulk_discount_max_pct=$24,
        has_video=$25, video_url=$26, updated_at=now()
       WHERE id=$27 RETURNING *`,
      [
        b.name, b.technique, b.state, b.municipality, b.street, b.city, b.zipCode,
        b.categories || [], b.contactName, b.whatsapp, b.email, b.deliveryTime,
        b.marketingStory, b.bankName, b.accountHolder, b.clabe, b.notes,
        JSON.stringify(b.photos || {}),
        b.invoices || false, b.invoiceSurchargePct || null, b.ships || false,
        b.bulkDiscount || false, b.bulkDiscountMinPct || null, b.bulkDiscountMaxPct || null,
        b.hasVideo || false, b.videoUrl || null, req.params.id,
      ]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Supplier not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update supplier' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await query('DELETE FROM suppliers WHERE id = $1', [req.params.id]);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete supplier' });
  }
});

export default router;
