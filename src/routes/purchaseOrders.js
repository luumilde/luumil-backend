import express from 'express';
import { query, nextFolio } from '../db/pool.js';

const router = express.Router();

// Helper: recompute order totals from its lines + iva/advance pct
async function recomputeOrderTotals(orderId) {
  const linesRes = await query(
    'SELECT quantity_ordered, unit_price_mxn FROM purchase_order_lines WHERE purchase_order_id=$1',
    [orderId]
  );
  const subtotal = linesRes.rows.reduce((s, l) => s + parseFloat(l.quantity_ordered) * parseFloat(l.unit_price_mxn), 0);
  const orderRes = await query('SELECT iva_pct FROM purchase_orders WHERE id=$1', [orderId]);
  const ivaPct = parseFloat(orderRes.rows[0]?.iva_pct || 16);
  const ivaAmount = subtotal * (ivaPct / 100);
  const total = subtotal + ivaAmount;
  await query(
    'UPDATE purchase_orders SET subtotal=$1, iva_amount=$2, total=$3, updated_at=now() WHERE id=$4',
    [subtotal, ivaAmount, total, orderId]
  );
  return { subtotal, ivaAmount, total };
}

// Helper: derive order status from line statuses (only when order isn't manually set to draft/confirmed/production/ready/cancelled)
async function maybeUpdateOrderStatusFromLines(orderId) {
  const order = await query('SELECT status FROM purchase_orders WHERE id=$1', [orderId]);
  const currentStatus = order.rows[0]?.status;
  if (['draft', 'cancelled'].includes(currentStatus)) return;

  const lines = await query('SELECT line_status FROM purchase_order_lines WHERE purchase_order_id=$1', [orderId]);
  const statuses = lines.rows.map(l => l.line_status);
  if (statuses.length === 0) return;

  let newStatus = currentStatus;
  if (statuses.every(s => s === 'complete')) newStatus = 'completed';
  else if (statuses.some(s => s === 'partial' || s === 'complete')) newStatus = 'receiving';

  if (newStatus !== currentStatus) {
    await query('UPDATE purchase_orders SET status=$1, updated_at=now() WHERE id=$2', [newStatus, orderId]);
  }
}

// ── ORDERS ──────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { status } = req.query;
    let sql = `SELECT po.*, s.name as supplier_name FROM purchase_orders po
               LEFT JOIN suppliers s ON po.supplier_id = s.id`;
    const params = [];
    if (status && status !== 'all') {
      sql += ' WHERE po.status = $1';
      params.push(status);
    }
    sql += ' ORDER BY po.created_at DESC';
    const result = await query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch purchase orders' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const orderRes = await query(
      `SELECT po.*, s.name as supplier_name FROM purchase_orders po
       LEFT JOIN suppliers s ON po.supplier_id = s.id WHERE po.id = $1`,
      [req.params.id]
    );
    if (orderRes.rows.length === 0) return res.status(404).json({ error: 'Order not found' });

    const linesRes = await query(
      `SELECT pol.*, p.sku, p.name_es, p.purchase_price_mxn as catalog_price
       FROM purchase_order_lines pol
       LEFT JOIN products p ON pol.product_id = p.id
       WHERE pol.purchase_order_id = $1 ORDER BY pol.id`,
      [req.params.id]
    );
    const paymentsRes = await query(
      'SELECT * FROM payments WHERE purchase_order_id = $1 ORDER BY created_at',
      [req.params.id]
    );
    const docsRes = await query(
      'SELECT * FROM fiscal_documents WHERE purchase_order_id = $1 ORDER BY created_at',
      [req.params.id]
    );

    res.json({
      ...orderRes.rows[0],
      lines: linesRes.rows,
      payments: paymentsRes.rows,
      fiscalDocuments: docsRes.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch order detail' });
  }
});

router.post('/', async (req, res) => {
  try {
    const b = req.body;
    const folio = await nextFolio('PC');
    const result = await query(
      `INSERT INTO purchase_orders
        (folio, supplier_id, order_date, delivery_date, delivery_place, status, iva_pct, advance_pct, instructions, internal_notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        folio, b.supplierId || null, b.orderDate || null, b.deliveryDate || null,
        b.deliveryPlace || 'Bodega MX (CDMX)', b.status || 'draft',
        b.ivaPct ?? 16, b.advancePct ?? 50, b.instructions, b.internalNotes, req.user?.userName,
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const b = req.body;
    const result = await query(
      `UPDATE purchase_orders SET
        supplier_id=$1, order_date=$2, delivery_date=$3, delivery_place=$4, status=$5,
        iva_pct=$6, advance_pct=$7, cancellation_resolution=$8, cancellation_reason=$9,
        instructions=$10, internal_notes=$11, updated_at=now()
       WHERE id=$12 RETURNING *`,
      [
        b.supplierId || null, b.orderDate || null, b.deliveryDate || null, b.deliveryPlace,
        b.status, b.ivaPct, b.advancePct, b.cancellationResolution, b.cancellationReason,
        b.instructions, b.internalNotes, req.params.id,
      ]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const totals = await recomputeOrderTotals(req.params.id);
    res.json({ ...result.rows[0], ...totals });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update order' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await query('DELETE FROM purchase_orders WHERE id = $1', [req.params.id]);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete order' });
  }
});

// ── ORDER LINES ─────────────────────────────────────────
router.post('/:id/lines', async (req, res) => {
  try {
    const b = req.body;
    const result = await query(
      `INSERT INTO purchase_order_lines
        (purchase_order_id, product_id, variant, quantity_ordered, unit_price_mxn, line_status)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.id, b.productId || null, b.variant, b.quantityOrdered || 0, b.unitPriceMxn || 0, b.lineStatus || 'pending']
    );
    const totals = await recomputeOrderTotals(req.params.id);
    res.status(201).json({ line: result.rows[0], totals });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add line' });
  }
});

router.put('/lines/:lineId', async (req, res) => {
  try {
    const b = req.body;
    const result = await query(
      `UPDATE purchase_order_lines SET
        product_id=$1, variant=$2, quantity_ordered=$3, quantity_received=$4,
        unit_price_mxn=$5, line_status=$6
       WHERE id=$7 RETURNING *`,
      [b.productId || null, b.variant, b.quantityOrdered, b.quantityReceived, b.unitPriceMxn, b.lineStatus, req.params.lineId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Line not found' });
    const orderId = result.rows[0].purchase_order_id;
    const totals = await recomputeOrderTotals(orderId);
    await maybeUpdateOrderStatusFromLines(orderId);
    res.json({ line: result.rows[0], totals });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update line' });
  }
});

router.delete('/lines/:lineId', async (req, res) => {
  try {
    const lineRes = await query('SELECT purchase_order_id FROM purchase_order_lines WHERE id=$1', [req.params.lineId]);
    const orderId = lineRes.rows[0]?.purchase_order_id;
    await query('DELETE FROM purchase_order_lines WHERE id = $1', [req.params.lineId]);
    if (orderId) await recomputeOrderTotals(orderId);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete line' });
  }
});

// ── PAYMENTS ────────────────────────────────────────────

// Helper: validate that paid payments don't exceed order total
async function validatePaymentsDontExceedTotal(orderId, paymentIdToExclude, candidateAmount, candidateIsPaid) {
  const orderRes = await query('SELECT total FROM purchase_orders WHERE id=$1', [orderId]);
  const orderTotal = parseFloat(orderRes.rows[0]?.total || 0);

  const paymentsRes = await query(
    'SELECT id, amount_mxn, is_paid FROM payments WHERE purchase_order_id=$1',
    [orderId]
  );
  let totalPaid = paymentsRes.rows
    .filter(p => p.is_paid && p.id !== paymentIdToExclude)
    .reduce((s, p) => s + parseFloat(p.amount_mxn || 0), 0);

  if (candidateIsPaid) totalPaid += parseFloat(candidateAmount || 0);

  if (orderTotal > 0 && totalPaid > orderTotal + 0.01) {
    const error = new Error(
      `Total paid (${totalPaid.toFixed(2)}) would exceed order total (${orderTotal.toFixed(2)})`
    );
    error.code = 'PAYMENT_EXCEEDS_TOTAL';
    throw error;
  }
}

router.post('/:id/payments', async (req, res) => {
  try {
    const b = req.body;
    await validatePaymentsDontExceedTotal(req.params.id, null, b.amountMxn, b.isPaid);
    const result = await query(
      `INSERT INTO payments (purchase_order_id, concept, amount_mxn, payment_date, reference, is_paid, attachment_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.params.id, b.concept || 'Anticipo', b.amountMxn || 0, b.paymentDate || null, b.reference, b.isPaid || false, b.attachmentUrl || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === 'PAYMENT_EXCEEDS_TOTAL') return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Failed to add payment' });
  }
});

router.put('/payments/:paymentId', async (req, res) => {
  try {
    const b = req.body;
    const existing = await query('SELECT purchase_order_id FROM payments WHERE id=$1', [req.params.paymentId]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Payment not found' });
    const orderId = existing.rows[0].purchase_order_id;

    await validatePaymentsDontExceedTotal(orderId, parseInt(req.params.paymentId), b.amountMxn, b.isPaid);

    const result = await query(
      `UPDATE payments SET concept=$1, amount_mxn=$2, payment_date=$3, reference=$4, is_paid=$5, attachment_url=$6
       WHERE id=$7 RETURNING *`,
      [b.concept, b.amountMxn, b.paymentDate, b.reference, b.isPaid, b.attachmentUrl, req.params.paymentId]
    );
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === 'PAYMENT_EXCEEDS_TOTAL') return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Failed to update payment' });
  }
});

router.delete('/payments/:paymentId', async (req, res) => {
  try {
    await query('DELETE FROM payments WHERE id = $1', [req.params.paymentId]);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete payment' });
  }
});

// ── FISCAL DOCUMENTS (CFDI / Recibo) ─────────────────────
router.post('/:id/fiscal-documents', async (req, res) => {
  try {
    const b = req.body;
    const result = await query(
      `INSERT INTO fiscal_documents
        (purchase_order_id, doc_type, status, folio, uuid, rfc, doc_date, amount_mxn, subtotal_mxn, iva_mxn, concept, attachment_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        req.params.id, b.docType, b.status || 'vigente', b.folio, b.uuid, b.rfc,
        b.docDate || null, b.amountMxn || 0, b.subtotalMxn || null, b.ivaMxn || null,
        b.concept, b.attachmentUrl || null,
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add fiscal document' });
  }
});

router.put('/fiscal-documents/:docId', async (req, res) => {
  try {
    const b = req.body;
    const result = await query(
      `UPDATE fiscal_documents SET
        doc_type=$1, status=$2, folio=$3, uuid=$4, rfc=$5, doc_date=$6,
        amount_mxn=$7, subtotal_mxn=$8, iva_mxn=$9, concept=$10, replaces_doc_id=$11, attachment_url=$12
       WHERE id=$13 RETURNING *`,
      [
        b.docType, b.status, b.folio, b.uuid, b.rfc, b.docDate,
        b.amountMxn, b.subtotalMxn, b.ivaMxn, b.concept, b.replacesDocId || null, b.attachmentUrl,
        req.params.docId,
      ]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Document not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update document' });
  }
});

// Cancel a fiscal document (keeps it visible, marks as cancelled)
router.post('/fiscal-documents/:docId/cancel', async (req, res) => {
  try {
    const result = await query(
      `UPDATE fiscal_documents SET status='cancelado' WHERE id=$1 RETURNING *`,
      [req.params.docId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Document not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to cancel document' });
  }
});

// Reconciliation summary: payments vs fiscal documents for an order
router.get('/:id/reconciliation', async (req, res) => {
  try {
    const paymentsRes = await query(
      'SELECT COALESCE(SUM(amount_mxn),0) as total FROM payments WHERE purchase_order_id=$1 AND is_paid=true',
      [req.params.id]
    );
    const docsRes = await query(
      `SELECT COALESCE(SUM(amount_mxn),0) as total FROM fiscal_documents
       WHERE purchase_order_id=$1 AND status != 'cancelado'`,
      [req.params.id]
    );
    const totalPaid = parseFloat(paymentsRes.rows[0].total);
    const totalDocumented = parseFloat(docsRes.rows[0].total);
    const difference = totalPaid - totalDocumented;
    res.json({
      totalPaid,
      totalDocumented,
      difference,
      status: Math.abs(difference) < 0.01 ? 'balanced' : difference > 0 ? 'missing_document' : 'missing_payment',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to compute reconciliation' });
  }
});

export default router;
