import express from 'express';
import { query } from '../db/pool.js';

const router = express.Router();

// Productos por proveedor
router.get('/products-by-supplier', async (req, res) => {
  try {
    const result = await query(`
      SELECT
        s.id, s.name, s.state, s.technique, s.contact_name,
        COUNT(p.id) as product_count,
        SUM(CASE WHEN p.fragile THEN 1 ELSE 0 END) as fragile_count,
        ROUND(AVG(p.purchase_price_mxn)::numeric, 2) as avg_purchase_price,
        ROUND(AVG(p.sale_price_eur)::numeric, 2) as avg_sale_price,
        array_agg(DISTINCT cat) FILTER (WHERE cat IS NOT NULL) as all_categories
      FROM suppliers s
      LEFT JOIN products p ON p.supplier_id = s.id
      LEFT JOIN LATERAL unnest(p.categories) cat ON true
      GROUP BY s.id, s.name, s.state, s.technique, s.contact_name
      ORDER BY s.name ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to run report' });
  }
});

// Resumen general
router.get('/summary', async (req, res) => {
  try {
    const [suppliers, products, orders, receptions] = await Promise.all([
      query('SELECT COUNT(*) as count FROM suppliers'),
      query('SELECT COUNT(*) as count, COUNT(CASE WHEN fragile THEN 1 END) as fragile FROM products'),
      query(`SELECT
        COUNT(*) as total,
        COUNT(CASE WHEN status='draft' THEN 1 END) as draft_count,
        COALESCE(SUM(CASE WHEN status='draft' THEN total ELSE 0 END),0) as draft_value,
        COUNT(CASE WHEN status NOT IN ('draft','cancelled','paid') THEN 1 END) as active_count,
        COALESCE(SUM(CASE WHEN status NOT IN ('draft','cancelled','paid') THEN total ELSE 0 END),0) as active_value
        FROM purchase_orders`),
      query('SELECT COUNT(*) as count FROM receptions'),
    ]);
    res.json({
      suppliers: parseInt(suppliers.rows[0].count),
      products: parseInt(products.rows[0].count),
      fragileProducts: parseInt(products.rows[0].fragile),
      draftOrders: parseInt(orders.rows[0].draft_count),
      draftOrdersValue: parseFloat(orders.rows[0].draft_value),
      activeOrders: parseInt(orders.rows[0].active_count),
      activeOrdersValue: parseFloat(orders.rows[0].active_value),
      receptions: parseInt(receptions.rows[0].count),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to run summary' });
  }
});

// Pagos por persona — quién pagó cada pago registrado, con detalle por
// orden de compra / proveedor. Solo cuenta lo efectivamente pagado (is_paid=true);
// el agrupamiento por persona y por orden se resuelve en el frontend a partir
// de esta lista plana, para poder reutilizarla en distintas vistas.
router.get('/payments-by-person', async (req, res) => {
  try {
    const result = await query(`
      SELECT
        pay.id, pay.paid_by, pay.amount_mxn, pay.payment_date, pay.concept,
        pay.payment_method, pay.reference,
        po.id as order_id, po.folio, po.status as order_status,
        s.id as supplier_id, s.name as supplier_name
      FROM payments pay
      JOIN purchase_orders po ON pay.purchase_order_id = po.id
      LEFT JOIN suppliers s ON po.supplier_id = s.id
      WHERE pay.is_paid = true
      ORDER BY pay.paid_by NULLS LAST, po.folio, pay.payment_date
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to run report' });
  }
});

// Stock por categoría: piezas por bodega + piezas pendientes de recibir
// (órdenes de compra vivas, no canceladas, no completas).
router.get('/stock-by-category', async (req, res) => {
  try {
    const result = await query(`
      WITH cats AS (
        SELECT DISTINCT COALESCE(categories[1], 'Sin categoría') AS categoria FROM products
      ),
      stock AS (
        SELECT
          COALESCE(p.categories[1], 'Sin categoría') AS categoria,
          l.name AS bodega,
          COALESCE(SUM(
            CASE WHEN sm.to_location_id = l.id THEN sm.quantity
                 WHEN sm.from_location_id = l.id THEN -sm.quantity
                 ELSE 0 END
          ), 0) AS qty
        FROM products p
        CROSS JOIN inventory_locations l
        LEFT JOIN stock_movements sm ON sm.product_id = p.id AND (sm.to_location_id = l.id OR sm.from_location_id = l.id)
        WHERE l.is_active = TRUE
        GROUP BY categoria, l.id, l.name
      ),
      stock_piv AS (
        SELECT categoria,
          SUM(CASE WHEN bodega = 'Bodega MX (CDMX)' THEN qty ELSE 0 END) AS bodega_mx,
          SUM(CASE WHEN bodega = 'En tránsito (MX→DE)' THEN qty ELSE 0 END) AS en_transito,
          SUM(CASE WHEN bodega = 'Bodega Munich' THEN qty ELSE 0 END) AS bodega_munich,
          SUM(qty) AS total_en_bodega
        FROM stock
        GROUP BY categoria
      ),
      pending AS (
        SELECT
          COALESCE(p.categories[1], 'Sin categoría') AS categoria,
          SUM(GREATEST(pol.quantity_ordered - pol.quantity_received, 0)) AS pendiente
        FROM purchase_order_lines pol
        JOIN purchase_orders po ON po.id = pol.purchase_order_id
        JOIN products p ON p.id = pol.product_id
        WHERE po.status != 'cancelled' AND pol.line_status != 'complete'
        GROUP BY categoria
      )
      SELECT
        c.categoria,
        COALESCE(sp.bodega_mx, 0) AS bodega_mx,
        COALESCE(sp.en_transito, 0) AS en_transito,
        COALESCE(sp.bodega_munich, 0) AS bodega_munich,
        COALESCE(sp.total_en_bodega, 0) AS total_en_bodega,
        COALESCE(pe.pendiente, 0) AS pendiente,
        COALESCE(sp.total_en_bodega, 0) + COALESCE(pe.pendiente, 0) AS gran_total
      FROM cats c
      LEFT JOIN stock_piv sp ON sp.categoria = c.categoria
      LEFT JOIN pending pe ON pe.categoria = c.categoria
      ORDER BY c.categoria
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to run report' });
  }
});

// Productos en proceso de compra (en pedidos activos)
router.get('/products-in-progress', async (req, res) => {
  try {
    const result = await query(`
      SELECT
        p.id, p.sku, p.name_es, p.name_de, p.photos, p.purchase_price_mxn, p.sale_price_eur,
        p.fragile, p.categories, p.materials,
        s.name as supplier_name, s.contact_name as supplier_contact,
        pol.id as line_id, pol.quantity_ordered, pol.quantity_received,
        pol.quantity_ordered - pol.quantity_received as quantity_pending,
        pol.unit_price_mxn, pol.line_status, pol.purchase_order_id,
        po.folio as order_folio, po.status as order_status, po.delivery_date, po.iva_pct
      FROM purchase_order_lines pol
      JOIN purchase_orders po ON pol.purchase_order_id = po.id
      JOIN products p ON pol.product_id = p.id
      LEFT JOIN suppliers s ON p.supplier_id = s.id
      WHERE po.status NOT IN ('cancelled', 'paid')
        AND pol.line_status NOT IN ('cancelled', 'complete')
      ORDER BY s.name, p.name_es
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to run report' });
  }
});

export default router;
