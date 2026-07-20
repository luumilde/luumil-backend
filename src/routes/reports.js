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
      query(`SELECT COUNT(*) as count, COALESCE(SUM(total),0) as total_mxn,
             COUNT(CASE WHEN status NOT IN ('draft','cancelled') THEN 1 END) as active FROM purchase_orders`),
      query('SELECT COUNT(*) as count FROM receptions'),
    ]);
    res.json({
      suppliers: parseInt(suppliers.rows[0].count),
      products: parseInt(products.rows[0].count),
      fragileProducts: parseInt(products.rows[0].fragile),
      orders: parseInt(orders.rows[0].count),
      activeOrders: parseInt(orders.rows[0].active),
      totalOrdersMxn: parseFloat(orders.rows[0].total_mxn),
      receptions: parseInt(receptions.rows[0].count),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to run summary' });
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
        po.folio as order_folio, po.status as order_status, po.delivery_date
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
