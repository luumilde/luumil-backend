import express from 'express';
import { query } from '../db/pool.js';

const router = express.Router();

// GET todas las pre-órdenes activas
router.get('/', async (req, res) => {
  try {
    const result = await query(`
      SELECT po.*, COUNT(pol.id) as line_count,
        COALESCE(SUM(pol.quantity * pol.unit_price_mxn), 0) as total_mxn
      FROM preorders po
      LEFT JOIN preorder_lines pol ON pol.preorder_id = po.id
      WHERE po.status = 'draft'
      GROUP BY po.id
      ORDER BY po.updated_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch preorders' });
  }
});

// GET una pre-orden con sus líneas
router.get('/:id', async (req, res) => {
  try {
    const poRes = await query('SELECT * FROM preorders WHERE id=$1', [req.params.id]);
    if (poRes.rows.length === 0) return res.status(404).json({ error: 'Preorder not found' });

    const linesRes = await query(`
      SELECT pol.*, p.sku, p.name_es, p.name_de, p.supplier_id, p.photos,
        p.purchase_price_mxn, p.sale_price_eur, p.fragile, p.categories, p.materials,
        s.name as supplier_name, s.contact_name as supplier_contact
      FROM preorder_lines pol
      JOIN products p ON pol.product_id = p.id
      LEFT JOIN suppliers s ON p.supplier_id = s.id
      WHERE pol.preorder_id = $1
      ORDER BY s.name, p.name_es
    `, [req.params.id]);

    res.json({ ...poRes.rows[0], lines: linesRes.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch preorder' });
  }
});

// POST crear pre-orden
router.post('/', async (req, res) => {
  try {
    const { name, lines } = req.body;
    const poRes = await query(
      `INSERT INTO preorders (name, status, created_by, updated_by)
       VALUES ($1, 'draft', $2, $2) RETURNING *`,
      [name || 'Pre-order', req.user?.userName]
    );
    const po = poRes.rows[0];

    if (lines && lines.length > 0) {
      for (const line of lines) {
        await query(
          `INSERT INTO preorder_lines (preorder_id, product_id, quantity, unit_price_mxn)
           VALUES ($1, $2, $3, $4) ON CONFLICT (preorder_id, product_id)
           DO UPDATE SET quantity=$3, unit_price_mxn=$4`,
          [po.id, line.productId, line.qty || 1, line.unitPrice || null]
        );
      }
    }

    const full = await query(`
      SELECT pol.*, p.sku, p.name_es, p.supplier_id, p.photos, p.purchase_price_mxn,
        s.name as supplier_name, s.contact_name as supplier_contact
      FROM preorder_lines pol
      JOIN products p ON pol.product_id = p.id
      LEFT JOIN suppliers s ON p.supplier_id = s.id
      WHERE pol.preorder_id = $1 ORDER BY s.name, p.name_es
    `, [po.id]);

    res.status(201).json({ ...po, lines: full.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create preorder' });
  }
});

// PUT actualizar línea (cantidad o precio)
router.put('/:id/lines/:lineId', async (req, res) => {
  try {
    const { qty, unitPrice } = req.body;
    await query(
      `UPDATE preorder_lines SET quantity=$1, unit_price_mxn=$2 WHERE id=$3 AND preorder_id=$4`,
      [qty, unitPrice, req.params.lineId, req.params.id]
    );
    await query(
      `UPDATE preorders SET updated_by=$1, updated_at=now() WHERE id=$2`,
      [req.user?.userName, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update line' });
  }
});

// DELETE eliminar línea
router.delete('/:id/lines/:lineId', async (req, res) => {
  try {
    await query('DELETE FROM preorder_lines WHERE id=$1 AND preorder_id=$2', [req.params.lineId, req.params.id]);
    await query(`UPDATE preorders SET updated_by=$1, updated_at=now() WHERE id=$2`, [req.user?.userName, req.params.id]);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete line' });
  }
});

// POST convertir pre-orden en órdenes formales por proveedor
router.post('/:id/convert', async (req, res) => {
  try {
    const { discounts } = req.body; // { supplierId: pct }
    const poRes = await query('SELECT * FROM preorders WHERE id=$1', [req.params.id]);
    if (poRes.rows.length === 0) return res.status(404).json({ error: 'Preorder not found' });

    const linesRes = await query(`
      SELECT pol.*, p.supplier_id, s.name as supplier_name
      FROM preorder_lines pol
      JOIN products p ON pol.product_id = p.id
      LEFT JOIN suppliers s ON p.supplier_id = s.id
      WHERE pol.preorder_id = $1
    `, [req.params.id]);

    // Agrupar por proveedor
    const bySupplier = {};
    for (const line of linesRes.rows) {
      const sid = line.supplier_id;
      if (!bySupplier[sid]) bySupplier[sid] = { supplierId: sid, lines: [] };
      bySupplier[sid].lines.push(line);
    }

    const created = [];
    const today = new Date().toISOString().split('T')[0];

    for (const group of Object.values(bySupplier)) {
      // Crear pedido
      const orderRes = await query(
        `INSERT INTO purchase_orders (folio, supplier_id, order_date, status, iva_pct, advance_pct, created_by)
         VALUES (
           (SELECT CONCAT('PC-', LPAD((current_value+1)::text, 4, '0')) FROM sequences WHERE prefix='PC'),
           $1, $2, 'draft', 16, 50, $3
         ) RETURNING *`,
        [group.supplierId, today, req.user?.userName]
      );
      await query(
        `UPDATE sequences SET current_value = current_value + 1 WHERE prefix = 'PC'`
      );
      const order = orderRes.rows[0];

      for (const line of group.lines) {
        const disc = parseFloat(discounts?.[group.supplierId]) || 0;
        const price = parseFloat(line.unit_price_mxn || line.purchase_price_mxn || 0);
        const effectivePrice = disc > 0 ? price * (1 - disc/100) : price;

        await query(
          `INSERT INTO purchase_order_lines (purchase_order_id, product_id, quantity_ordered, unit_price_mxn, line_status)
           VALUES ($1, $2, $3, $4, 'pending')`,
          [order.id, line.product_id, line.quantity, effectivePrice]
        );
      }

      // Recalcular totales
      const linesTotal = await query(
        'SELECT quantity_ordered, unit_price_mxn FROM purchase_order_lines WHERE purchase_order_id=$1',
        [order.id]
      );
      const subtotal = linesTotal.rows.reduce((s,l) => s + parseFloat(l.quantity_ordered)*parseFloat(l.unit_price_mxn), 0);
      const iva = subtotal * 0.16;
      await query(
        'UPDATE purchase_orders SET subtotal=$1, iva_amount=$2, total=$3 WHERE id=$4',
        [subtotal, iva, subtotal+iva, order.id]
      );

      created.push(order);
    }

    // Marcar pre-orden como convertida
    await query(`UPDATE preorders SET status='converted', updated_by=$1, updated_at=now() WHERE id=$2`,
      [req.user?.userName, req.params.id]);

    res.json({ created: created.length, orders: created });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to convert preorder: ' + err.message });
  }
});

export default router;
