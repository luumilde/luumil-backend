import express from 'express';
import { query, nextFolio } from '../db/pool.js';
import { getGlobalSettings } from './pricing.js';

const router = express.Router();
const round2 = n => Math.round(n * 100) / 100;

// Qué bodega representa el stock vendible de cada entidad. Las ventas siempre
// son "fuera del ecosistema Luumil" (a un cliente real), así que sí descuentan
// inventario — a diferencia de una transferencia intercompany, que es interna
// y nunca toca stock_movements.
const ENTITY_LOCATION = { MX: 'Bodega MX (CDMX)', DE: 'Bodega Munich' };

async function getAvailableQty(productId, locationName) {
  const r = await query(`
    SELECT COALESCE(SUM(
      CASE WHEN sm.to_location_id = l.id THEN sm.quantity
           WHEN sm.from_location_id = l.id THEN -sm.quantity
           ELSE 0 END
    ), 0)::int AS qty
    FROM inventory_locations l
    LEFT JOIN stock_movements sm ON sm.product_id = $1 AND (sm.to_location_id = l.id OR sm.from_location_id = l.id)
    WHERE l.name = $2
    GROUP BY l.id
  `, [productId, locationName]);
  return r.rows[0]?.qty || 0;
}

// GET /api/sales/products — selector de productos para armar una orden de venta:
// busca por nombre/SKU, muestra fotos y cuánto stock vendible hay en la bodega
// de esa entidad (MX o DE), para poder validar cantidades desde el frontend.
router.get('/products', async (req, res) => {
  try {
    const { entity, search } = req.query;
    const locationName = ENTITY_LOCATION[entity] || ENTITY_LOCATION.DE;
    const params = [locationName];
    let searchSql = '';
    if (search) { params.push(`%${search}%`); searchSql = `AND (p.name_es ILIKE $${params.length} OR p.sku ILIKE $${params.length})`; }

    const result = await query(`
      SELECT p.id, p.sku, p.name_es, p.photos, p.sale_price_eur, p.purchase_price_mxn, p.categories,
        COALESCE(stock.qty, 0) AS available_qty
      FROM products p
      LEFT JOIN inventory_locations l ON l.name = $1
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(
          CASE WHEN sm.to_location_id = l.id THEN sm.quantity
               WHEN sm.from_location_id = l.id THEN -sm.quantity
               ELSE 0 END
        ), 0)::int AS qty
        FROM stock_movements sm
        WHERE sm.product_id = p.id AND (sm.to_location_id = l.id OR sm.from_location_id = l.id)
      ) stock ON true
      WHERE COALESCE(stock.qty, 0) > 0 ${searchSql}
      ORDER BY p.name_es
    `, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch sellable products' });
  }
});

// GET /api/sales — lista de órdenes de venta
router.get('/', async (req, res) => {
  try {
    const { entity, status } = req.query;
    let sql = `
      SELECT so.*, f.name AS fair_name,
        (SELECT COALESCE(SUM(quantity),0) FROM sales_order_lines WHERE sales_order_id = so.id) AS item_count
      FROM sales_orders so
      LEFT JOIN fairs f ON f.id = so.fair_id
    `;
    const conditions = [];
    const params = [];
    if (entity) { params.push(entity); conditions.push(`so.entity = $${params.length}`); }
    if (status) { params.push(status); conditions.push(`so.status = $${params.length}`); }
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY so.created_at DESC';
    const result = await query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch sales orders' });
  }
});

// GET /api/sales/:id — detalle con líneas
router.get('/:id', async (req, res) => {
  try {
    const orderRes = await query(`
      SELECT so.*, f.name AS fair_name
      FROM sales_orders so LEFT JOIN fairs f ON f.id = so.fair_id
      WHERE so.id = $1
    `, [req.params.id]);
    if (!orderRes.rows.length) return res.status(404).json({ error: 'Sales order not found' });

    const linesRes = await query(`
      SELECT sol.*, p.sku, p.name_es, p.photos
      FROM sales_order_lines sol
      LEFT JOIN products p ON p.id = sol.product_id
      WHERE sol.sales_order_id = $1
      ORDER BY sol.id
    `, [req.params.id]);

    res.json({ ...orderRes.rows[0], lines: linesRes.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch sales order detail' });
  }
});

// POST /api/sales — crear orden de venta: valida stock disponible por línea
// (no permite vender más de lo que hay en la bodega de esa entidad), calcula
// IVA/MwSt sobre el subtotal, genera folio, y descuenta el inventario vendido.
router.post('/', async (req, res) => {
  try {
    const b = req.body;
    const entity = b.entity === 'MX' ? 'MX' : 'DE';
    const locationName = ENTITY_LOCATION[entity];
    const lines = Array.isArray(b.lines) ? b.lines.filter(l => l.productId && parseFloat(l.quantity) > 0) : [];
    if (!lines.length) return res.status(400).json({ error: 'Agrega al menos un producto' });

    // Validar disponibilidad antes de crear nada
    for (const l of lines) {
      const available = await getAvailableQty(l.productId, locationName);
      if (parseFloat(l.quantity) > available) {
        const prod = await query('SELECT sku, name_es FROM products WHERE id=$1', [l.productId]);
        const name = prod.rows[0] ? `${prod.rows[0].sku} — ${prod.rows[0].name_es}` : `producto ${l.productId}`;
        return res.status(400).json({ error: `No hay suficiente stock de ${name}: disponible ${available}, solicitado ${l.quantity}` });
      }
    }

    const subtotal = lines.reduce((s, l) => s + parseFloat(l.quantity) * parseFloat(l.unitPrice || 0), 0);
    const vatPct = parseFloat(b.vatPct) || 0;
    const vatAmount = subtotal * (vatPct / 100);
    const total = subtotal + vatAmount;
    const folio = await nextFolio('VTA');

    const orderRes = await query(`
      INSERT INTO sales_orders
        (folio, entity, fair_id, customer_name, customer_contact, sale_date, vat_pct, currency,
         subtotal, vat_amount, total, payment_method, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *
    `, [
      folio, entity, b.fairId || null, b.customerName || null, b.customerContact || null,
      b.saleDate || null, vatPct, entity === 'MX' ? 'MXN' : 'EUR',
      round2(subtotal), round2(vatAmount), round2(total),
      b.paymentMethod || 'cash', b.notes || null, req.user?.userName,
    ]);
    const order = orderRes.rows[0];

    const loc = await query('SELECT id FROM inventory_locations WHERE name=$1', [locationName]);
    for (const l of lines) {
      const lineTotal = round2(parseFloat(l.quantity) * parseFloat(l.unitPrice || 0));
      await query(`
        INSERT INTO sales_order_lines (sales_order_id, product_id, quantity, unit_price, line_total)
        VALUES ($1,$2,$3,$4,$5)
      `, [order.id, l.productId, l.quantity, l.unitPrice || 0, lineTotal]);

      if (loc.rows.length) {
        await query(`
          INSERT INTO stock_movements
            (product_id, from_location_id, to_location_id, quantity, movement_type, reference, notes, movement_date, created_by)
          VALUES ($1,$2,NULL,$3,'sale',$4,$5,$6,$7)
        `, [
          l.productId, loc.rows[0].id, l.quantity, folio,
          `Venta ${folio}`, b.saleDate || new Date().toISOString().split('T')[0], req.user?.userName,
        ]);
      }
    }

    res.status(201).json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create sales order' });
  }
});

// DELETE /api/sales/:id — cancelar/borrar una venta capturada por error: revierte
// el inventario (borra los movimientos de stock ligados a este folio) y elimina la orden.
router.delete('/:id', async (req, res) => {
  try {
    const orderRes = await query('SELECT folio FROM sales_orders WHERE id=$1', [req.params.id]);
    if (!orderRes.rows.length) return res.status(404).json({ error: 'Sales order not found' });
    const { folio } = orderRes.rows[0];
    await query(`DELETE FROM stock_movements WHERE movement_type='sale' AND reference=$1`, [folio]);
    await query('DELETE FROM sales_orders WHERE id=$1', [req.params.id]);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete sales order' });
  }
});

export default router;
