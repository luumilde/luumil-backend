import express from 'express';
import { query, nextFolio } from '../db/pool.js';

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const result = await query(
      `SELECT r.*, po.folio as order_folio, s.name as supplier_name
       FROM receptions r
       LEFT JOIN purchase_orders po ON r.purchase_order_id = po.id
       LEFT JOIN suppliers s ON po.supplier_id = s.id
       ORDER BY r.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch receptions' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const recRes = await query(
      `SELECT r.*, po.folio as order_folio, s.name as supplier_name
       FROM receptions r
       LEFT JOIN purchase_orders po ON r.purchase_order_id = po.id
       LEFT JOIN suppliers s ON po.supplier_id = s.id
       WHERE r.id = $1`,
      [req.params.id]
    );
    if (recRes.rows.length === 0) return res.status(404).json({ error: 'Reception not found' });

    const linesRes = await query(
      `SELECT rl.*, pol.quantity_ordered, pol.variant, p.sku, p.name_es
       FROM reception_lines rl
       LEFT JOIN purchase_order_lines pol ON rl.purchase_order_line_id = pol.id
       LEFT JOIN products p ON pol.product_id = p.id
       WHERE rl.reception_id = $1`,
      [req.params.id]
    );
    res.json({ ...recRes.rows[0], lines: linesRes.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch reception detail' });
  }
});

// Get orders eligible for receiving (status in production/ready/receiving/confirmed)
router.get('/eligible-orders/list', async (req, res) => {
  try {
    const result = await query(
      `SELECT po.*, s.name as supplier_name FROM purchase_orders po
       LEFT JOIN suppliers s ON po.supplier_id = s.id
       WHERE po.status IN ('confirmed','production','ready','receiving')
       ORDER BY po.delivery_date ASC NULLS LAST`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch eligible orders' });
  }
});

router.post('/', async (req, res) => {
  try {
    const b = req.body;
    const folio = await nextFolio('REC');
    const result = await query(
      `INSERT INTO receptions
        (folio, purchase_order_id, reception_date, received_by, reception_place, general_observations, pending_actions, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        folio, b.purchaseOrderId, b.receptionDate || null, b.receivedBy,
        b.receptionPlace || 'Bodega MX (CDMX)', b.generalObservations, b.pendingActions, req.user?.userName,
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create reception' });
  }
});

// Add a reception line AND update the related purchase_order_line quantities/status
router.post('/:id/lines', async (req, res) => {
  try {
    const b = req.body;
    const lineRes = await query(
      `INSERT INTO reception_lines
        (reception_id, purchase_order_line_id, quantity_received, quality, quality_notes, photos)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.id, b.purchaseOrderLineId, b.quantityReceived || 0, b.quality || 'ok', b.qualityNotes, JSON.stringify(b.photos || {})]
    );

    // Update the order line: add to quantity_received, compute new status
    const polRes = await query('SELECT * FROM purchase_order_lines WHERE id=$1', [b.purchaseOrderLineId]);
    const pol = polRes.rows[0];
    if (pol) {
      const newQtyReceived = parseFloat(pol.quantity_received || 0) + parseFloat(b.quantityReceived || 0);
      const ordered = parseFloat(pol.quantity_ordered);
      const newStatus = newQtyReceived <= 0 ? 'pending' : newQtyReceived >= ordered ? 'complete' : 'partial';
      await query(
        'UPDATE purchase_order_lines SET quantity_received=$1, line_status=$2 WHERE id=$3',
        [newQtyReceived, newStatus, b.purchaseOrderLineId]
      );

      // Recompute parent order status
      const allLines = await query('SELECT line_status FROM purchase_order_lines WHERE purchase_order_id=$1', [pol.purchase_order_id]);
      const statuses = allLines.rows.map(l => l.line_status);
      let orderNewStatus = null;
      if (statuses.every(s => s === 'complete')) orderNewStatus = 'completed';
      else if (statuses.some(s => s === 'partial' || s === 'complete')) orderNewStatus = 'receiving';
      if (orderNewStatus) {
        await query(
          `UPDATE purchase_orders SET status=$1, updated_at=now()
           WHERE id=$2 AND status NOT IN ('draft','cancelled','paid')`,
          [orderNewStatus, pol.purchase_order_id]
        );
      }
    }

    res.status(201).json(lineRes.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add reception line' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const b = req.body;
    const result = await query(
      `UPDATE receptions SET reception_date=$1, received_by=$2, reception_place=$3,
       general_observations=$4, pending_actions=$5 WHERE id=$6 RETURNING *`,
      [b.receptionDate, b.receivedBy, b.receptionPlace, b.generalObservations, b.pendingActions, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Reception not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update reception' });
  }
});

export default router;
