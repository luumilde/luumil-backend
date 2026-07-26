import express from 'express';
import { query } from '../db/pool.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();
router.use(authMiddleware);

// GET /api/inventory/locations
router.get('/locations', async (req, res) => {
  try {
    const r = await query(`SELECT * FROM inventory_locations WHERE is_active=TRUE ORDER BY sort_order`);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/inventory/stock — stock actual por producto y ubicación
router.get('/stock', async (req, res) => {
  try {
    const { location, search } = req.query;
    let sql = `
      SELECT
        p.id AS product_id, p.sku, p.name_es,
        array_to_string(p.categories,';') AS categories,
        array_to_string(p.materials,';') AS materials,
        p.photos, p.purchase_price_mxn,
        s.name AS supplier_name,
        json_object_agg(l.name, cs.qty) FILTER (WHERE cs.qty > 0) AS stock_by_location,
        SUM(cs.qty) AS total_qty
      FROM products p
      LEFT JOIN suppliers s ON p.supplier_id = s.id
      CROSS JOIN inventory_locations l
      LEFT JOIN (
        SELECT product_id, to_location_id AS loc_id, SUM(quantity) AS qty
        FROM stock_movements GROUP BY product_id, to_location_id
      ) ins ON ins.product_id = p.id AND ins.loc_id = l.id
      LEFT JOIN (
        SELECT product_id, from_location_id AS loc_id, SUM(quantity) AS qty
        FROM stock_movements WHERE from_location_id IS NOT NULL GROUP BY product_id, from_location_id
      ) outs ON outs.product_id = p.id AND outs.loc_id = l.id
      CROSS JOIN LATERAL (SELECT COALESCE(ins.qty,0) - COALESCE(outs.qty,0) AS qty) cs
      WHERE l.is_active = TRUE
      GROUP BY p.id, p.sku, p.name_es, p.categories, p.materials, p.photos, p.purchase_price_mxn, s.name
      HAVING SUM(cs.qty) > 0
    `;
    const params = [];
    const conditions = [];
    if (search) { params.push(`%${search}%`); conditions.push(`(p.name_es ILIKE $${params.length} OR p.sku ILIKE $${params.length})`); }
    if (conditions.length) sql = sql.replace('HAVING', `AND ${conditions.join(' AND ')} HAVING`);
    sql += ' ORDER BY s.name, p.name_es';
    const r = await query(sql, params);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/inventory/movements/:productId
router.get('/movements/:productId', async (req, res) => {
  try {
    const r = await query(`
      SELECT sm.*, 
        fl.name AS from_location, tl.name AS to_location,
        p.sku, p.name_es
      FROM stock_movements sm
      LEFT JOIN inventory_locations fl ON fl.id = sm.from_location_id
      LEFT JOIN inventory_locations tl ON tl.id = sm.to_location_id
      JOIN products p ON p.id = sm.product_id
      WHERE sm.product_id = $1
      ORDER BY sm.movement_date DESC, sm.created_at DESC
    `, [req.params.productId]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/inventory/movements — registrar movimiento
router.post('/movements', async (req, res) => {
  try {
    const { productId, fromLocationId, toLocationId, quantity, movementType, reference, notes, movementDate } = req.body;
    if (!productId || !toLocationId || !quantity || quantity <= 0)
      return res.status(400).json({ error: 'productId, toLocationId y quantity son requeridos' });

    const r = await query(`
      INSERT INTO stock_movements
        (product_id, from_location_id, to_location_id, quantity, movement_type, reference, notes, movement_date, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
    `, [productId, fromLocationId||null, toLocationId, quantity, movementType||'adjustment', reference||null, notes||null, movementDate||new Date().toISOString().split('T')[0], req.user?.userName]);
    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/inventory/all-stock — stock de todos los productos incluyendo los en cero (para ajuste inicial)
router.get('/all-stock', async (req, res) => {
  try {
    const r = await query(`
      SELECT p.id AS product_id, p.sku, p.name_es,
        array_to_string(p.categories,';') AS categories,
        p.photos, s.name AS supplier_name,
        COALESCE(
          (SELECT json_object_agg(l.name, GREATEST(0,
            COALESCE((SELECT SUM(sm2.quantity) FROM stock_movements sm2 WHERE sm2.product_id=p.id AND sm2.to_location_id=l.id),0) -
            COALESCE((SELECT SUM(sm3.quantity) FROM stock_movements sm3 WHERE sm3.product_id=p.id AND sm3.from_location_id=l.id),0)
          ))
          FROM inventory_locations l WHERE l.is_active=TRUE
          AND (
            EXISTS(SELECT 1 FROM stock_movements sm4 WHERE sm4.product_id=p.id AND (sm4.to_location_id=l.id OR sm4.from_location_id=l.id))
          )), '{}'::json
        ) AS stock_by_location
      FROM products p
      LEFT JOIN suppliers s ON p.supplier_id=s.id
      ORDER BY s.name, p.name_es
    `);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

export default router;

// Mapear delivery_place a nombre de ubicación en BD
function mapDeliveryPlace(deliveryPlace) {
  const map = {
    'Bodega MX (CDMX)': 'Bodega MX (CDMX)',
    'Bodega Munich': 'Bodega Munich',
    'En tránsito (MX→DE)': 'En tránsito (MX→DE)',
    'Workshop pickup': 'Bodega MX (CDMX)',
    'Courier': 'Bodega MX (CDMX)',
    'Store purchase': 'Bodega MX (CDMX)',
  };
  return map[deliveryPlace] || 'Bodega MX (CDMX)';
}

// POST /api/inventory/sync-from-orders — sincronizar órdenes paid que no tienen movimiento
router.post('/sync-from-orders', async (req, res) => {
  try {
    // Órdenes paid sin movimiento de inventario registrado
    const orders = await query(`
      SELECT po.id, po.folio, po.delivery_place, po.delivery_date,
        pol.product_id, pol.quantity_ordered
      FROM purchase_orders po
      JOIN purchase_order_lines pol ON pol.purchase_order_id = po.id
      WHERE po.status = 'paid'
        AND pol.product_id IS NOT NULL
        AND pol.quantity_ordered > 0
        AND NOT EXISTS (
          SELECT 1 FROM stock_movements sm
          WHERE sm.product_id = pol.product_id
            AND sm.reference = po.folio
            AND sm.movement_type = 'order_paid'
        )
    `);

    if (orders.rows.length === 0) return res.json({ synced: 0, message: 'Todo al día' });

    let synced = 0;
    for (const row of orders.rows) {
      const locName = mapDeliveryPlace(row.delivery_place);
      const loc = await query(`SELECT id FROM inventory_locations WHERE name=$1`, [locName]);
      if (!loc.rows.length) continue;

      await query(`
        INSERT INTO stock_movements
          (product_id, from_location_id, to_location_id, quantity, movement_type, reference, notes, movement_date, created_by)
        VALUES ($1, NULL, $2, $3, 'order_paid', $4, $5, $6, 'system')
      `, [
        row.product_id, loc.rows[0].id, row.quantity_ordered,
        row.folio,
        `Sincronizado desde orden ${row.folio}`,
        row.delivery_date ? row.delivery_date.toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
      ]);
      synced++;
    }

    res.json({ synced, message: `${synced} líneas sincronizadas` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Hook en purchase_orders: llamar al marcar paid (desde purchaseOrders.js si se quiere automático)
// Por ahora se llama manualmente desde el frontend

