import express from 'express';
import { query } from '../db/pool.js';
import { getGlobalSettings } from './pricing.js';

const router = express.Router();
const round2 = n => Math.round(n * 100) / 100;

// Precio intercompany vigente de un producto: el de la transferencia más
// reciente (por fecha, luego por creación). Si no hay ninguna transferencia,
// el producto sigue siendo propiedad de Luumil México y usa el costo del
// proveedor como base (lógica ya existente en pricing.js / fairs.js).
export async function getLatestIntercompanyPrice(productId) {
  const r = await query(
    `SELECT price_eur, transfer_date FROM intercompany_transfers
     WHERE product_id = $1 ORDER BY transfer_date DESC, created_at DESC LIMIT 1`,
    [productId]
  );
  return r.rows[0] || null;
}

// GET /api/intercompany/transfers — historial, más reciente primero
router.get('/transfers', async (req, res) => {
  try {
    const { productId } = req.query;
    let sql = `
      SELECT it.*, p.sku, p.name_es, p.photos, l.name AS location_name
      FROM intercompany_transfers it
      JOIN products p ON p.id = it.product_id
      LEFT JOIN inventory_locations l ON l.id = it.location_id
    `;
    const params = [];
    if (productId) { params.push(productId); sql += ` WHERE it.product_id = $${params.length}`; }
    sql += ` ORDER BY it.transfer_date DESC, it.created_at DESC`;
    const r = await query(sql, params);
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch transfers' });
  }
});

// GET /api/intercompany/products — productos con su estado de propiedad actual
// (México si nunca se transfirió, Alemania si ya tiene al menos una
// transferencia) y el precio base vigente que se usará en Pricing.
router.get('/products', async (req, res) => {
  try {
    const { search } = req.query;
    let sql = `
      SELECT p.id, p.sku, p.name_es, p.photos, p.purchase_price_mxn, p.categories,
        s.name AS supplier_name,
        latest.price_eur AS intercompany_price_eur,
        latest.transfer_date AS intercompany_transfer_date,
        latest.quantity AS intercompany_last_quantity,
        (SELECT COALESCE(SUM(quantity),0) FROM intercompany_transfers WHERE product_id = p.id) AS total_transferred
      FROM products p
      LEFT JOIN suppliers s ON s.id = p.supplier_id
      LEFT JOIN LATERAL (
        SELECT price_eur, transfer_date, quantity FROM intercompany_transfers
        WHERE product_id = p.id ORDER BY transfer_date DESC, created_at DESC LIMIT 1
      ) latest ON true
      WHERE EXISTS (SELECT 1 FROM purchase_order_lines pol WHERE pol.product_id = p.id)
    `;
    const params = [];
    if (search) {
      params.push(`%${search}%`);
      sql += ` AND (p.name_es ILIKE $${params.length} OR p.sku ILIKE $${params.length})`;
    }
    sql += ` ORDER BY p.name_es`;
    const r = await query(sql, params);
    res.json(r.rows.map(row => ({
      ...row,
      owner: row.intercompany_price_eur != null ? 'DE' : 'MX',
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch intercompany products' });
  }
});

// POST /api/intercompany/transfers — registrar una transferencia (venta intercompany).
// Se pregunta la ubicación física de los productos al momento de la transferencia
// (Bodega MX, En tránsito, Bodega Munich) — la propiedad y la ubicación son cosas
// distintas, pero queremos dejar constancia de dónde estaban en ese momento.
router.post('/transfers', async (req, res) => {
  try {
    const { productId, quantity, priceEur, locationId, transferDate, notes } = req.body;
    if (!productId) return res.status(400).json({ error: 'productId es requerido' });
    if (!quantity || quantity <= 0) return res.status(400).json({ error: 'La cantidad debe ser mayor a 0' });
    if (priceEur == null || priceEur < 0) return res.status(400).json({ error: 'El precio EUR es requerido' });
    if (!locationId) return res.status(400).json({ error: 'La ubicación de los productos es requerida' });
    const r = await query(
      `INSERT INTO intercompany_transfers (product_id, quantity, price_eur, location_id, transfer_date, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [productId, quantity, priceEur, locationId, transferDate || null, notes || null, req.user?.userName]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create transfer' });
  }
});

// POST /api/intercompany/transfers/bulk — setup general: aplica el mismo % de
// incremento sobre el precio de compra (MXN) a varios productos a la vez, con
// la misma cantidad, ubicación y fecha para todo el lote. Calcula el precio en
// MXN y en EUR (con el tipo de cambio vigente de Pricing > Configuración) y
// registra una transferencia intercompany por cada producto seleccionado.
router.post('/transfers/bulk', async (req, res) => {
  try {
    const { productIds, pct, quantity, locationId, transferDate, notes } = req.body;
    if (!Array.isArray(productIds) || !productIds.length) return res.status(400).json({ error: 'Selecciona al menos un producto' });
    const pctNum = parseFloat(pct);
    if (pct === undefined || pct === null || isNaN(pctNum)) return res.status(400).json({ error: 'El % es requerido' });
    if (!quantity || quantity <= 0) return res.status(400).json({ error: 'La cantidad debe ser mayor a 0' });
    if (!locationId) return res.status(400).json({ error: 'La ubicación de los productos es requerida' });

    const settings = await getGlobalSettings();
    if (!settings.exchangeRate || settings.exchangeRate <= 0) {
      return res.status(400).json({ error: 'Configura el tipo de cambio en Pricing > Configuración antes de continuar' });
    }

    const created = [];
    for (const productId of productIds) {
      const prod = await query('SELECT purchase_price_mxn FROM products WHERE id=$1', [productId]);
      if (!prod.rows.length) continue;
      const purchasePrice = parseFloat(prod.rows[0].purchase_price_mxn) || 0;
      const costoMxn = purchasePrice * (1 + pctNum / 100);
      const costoEur = costoMxn / settings.exchangeRate;
      const r = await query(
        `INSERT INTO intercompany_transfers (product_id, quantity, price_eur, location_id, transfer_date, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [productId, quantity, round2(costoEur), locationId, transferDate || null, notes || null, req.user?.userName]
      );
      created.push({ ...r.rows[0], costoMxn: round2(costoMxn) });
    }
    res.status(201).json({ created: created.length, transfers: created });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create bulk transfers' });
  }
});

// DELETE /api/intercompany/transfers/:id — corregir un registro capturado por error
router.delete('/transfers/:id', async (req, res) => {
  try {
    await query('DELETE FROM intercompany_transfers WHERE id=$1', [req.params.id]);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete transfer' });
  }
});

export default router;
