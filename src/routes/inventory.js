import express from 'express';
import { query } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();
router.use(requireAuth);

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
        s.id AS supplier_id, s.name AS supplier_name,
        json_object_agg(l.name, cs.qty) FILTER (WHERE cs.qty > 0) AS stock_by_location,
        SUM(cs.qty) AS total_qty,
        (
          -- Piezas todavía por recibir en órdenes vivas (no canceladas) — puede
          -- coexistir con stock ya recibido (ej. una orden ya llegó y otra
          -- todavía no), por eso se muestra aparte y no solo como "Sin bodega".
          SELECT COALESCE(SUM(GREATEST(pol.quantity_ordered - pol.quantity_received, 0)), 0)
          FROM purchase_order_lines pol
          JOIN purchase_orders po ON po.id = pol.purchase_order_id
          WHERE pol.product_id = p.id AND po.status != 'cancelled' AND pol.line_status != 'complete'
        ) AS pending_qty,
        (
          -- ¿Alguna de las órdenes de este producto es consignación (no cancelada)
          -- y todavía no está liquidada por completo? Ese stock no es "tuyo" hasta
          -- que se vende y se le paga al artesano por lo vendido.
          SELECT COALESCE(BOOL_OR(
            po.is_consignment AND po.status != 'cancelled' AND
            COALESCE((SELECT SUM(pay.amount_mxn) FROM payments pay WHERE pay.purchase_order_id = po.id AND pay.is_paid = true), 0) < COALESCE(po.total, 0)
          ), false)
          FROM purchase_order_lines pol
          JOIN purchase_orders po ON po.id = pol.purchase_order_id
          WHERE pol.product_id = p.id
        ) AS consignment_pending
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
      GROUP BY p.id, p.sku, p.name_es, p.categories, p.materials, p.photos, p.purchase_price_mxn, s.id, s.name
      HAVING SUM(cs.qty) > 0
        OR EXISTS (
          -- Aparece en la lista (con o sin bodega) si tiene una orden de compra viva
          -- (no cancelada), aunque ya tenga algo de stock de otra orden distinta.
          SELECT 1 FROM purchase_order_lines pol
          JOIN purchase_orders po ON po.id = pol.purchase_order_id
          WHERE pol.product_id = p.id AND po.status != 'cancelled'
        )
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

// GET /api/inventory/stock/:productId — stock disponible por bodega para un producto (para formulario de movimiento)
router.get('/stock/:productId', async (req, res) => {
  try {
    const r = await query(`
      SELECT l.id AS location_id, l.name AS location_name,
        COALESCE(SUM(
          CASE WHEN sm.to_location_id = l.id THEN sm.quantity
               WHEN sm.from_location_id = l.id THEN -sm.quantity
               ELSE 0 END
        ), 0)::int AS qty
      FROM inventory_locations l
      LEFT JOIN stock_movements sm ON sm.product_id = $1 AND (sm.to_location_id = l.id OR sm.from_location_id = l.id)
      WHERE l.is_active = TRUE
      GROUP BY l.id, l.name, l.sort_order
      HAVING COALESCE(SUM(
        CASE WHEN sm.to_location_id = l.id THEN sm.quantity
             WHEN sm.from_location_id = l.id THEN -sm.quantity
             ELSE 0 END
      ), 0) > 0
      ORDER BY l.sort_order
    `, [req.params.productId]);
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
    if (!productId || !quantity || quantity <= 0)
      return res.status(400).json({ error: 'productId y quantity son requeridos' });
    if (!fromLocationId && !toLocationId)
      return res.status(400).json({ error: 'Se requiere bodega origen y/o destino' });

    // No permitir mover más piezas de las disponibles en la bodega origen
    if (fromLocationId) {
      const avail = await query(`
        SELECT COALESCE(SUM(
          CASE WHEN to_location_id = $2 THEN quantity
               WHEN from_location_id = $2 THEN -quantity
               ELSE 0 END
        ), 0)::int AS qty
        FROM stock_movements WHERE product_id = $1
      `, [productId, fromLocationId]);
      const availableQty = avail.rows[0].qty;
      if (Number(quantity) > availableQty) {
        return res.status(400).json({ error: `Solo hay ${availableQty} pieza(s) disponibles en esa bodega` });
      }
    }

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

// Mapear delivery_place / reception_place a nombre de ubicación en BD
// (exportada para que receptions.js la reutilice al registrar recepciones)
export function mapDeliveryPlace(deliveryPlace) {
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
          -- Si ya se registró inventario para este producto+orden (ya sea porque
          -- se hizo una Recepción física o porque ya se sincronizó antes), no
          -- volver a agregar movimiento — evita duplicar piezas en bodega.
          SELECT 1 FROM stock_movements sm
          WHERE sm.product_id = pol.product_id
            AND sm.reference = po.folio
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

      // Al sincronizar el inventario de una orden paid, la línea de la orden
      // también debe reflejar que ya se recibió por completo — si no, la línea
      // se queda marcada "pending" para siempre aunque el producto ya tenga
      // bodega asignada (esto es lo que reportó Myriam).
      await query(`
        UPDATE purchase_order_lines
        SET quantity_received = quantity_ordered, line_status = 'complete'
        WHERE purchase_order_id = $1 AND product_id = $2 AND line_status != 'complete'
      `, [row.id, row.product_id]);

      synced++;
    }

    res.json({ synced, message: `${synced} líneas sincronizadas` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Hook en purchase_orders: llamar al marcar paid (desde purchaseOrders.js si se quiere automático)
// Por ahora se llama manualmente desde el frontend

