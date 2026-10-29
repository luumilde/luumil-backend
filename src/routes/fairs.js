import express from 'express';
import { query } from '../db/pool.js';
import { getGlobalSettings, getCategoryList, getShippingUnitCostMap } from './pricing.js';

const router = express.Router();
const DIST_MODES = ['per_piece', 'by_price', 'none'];
// costCategories: lista de categorías que SÍ absorben costo de feria (null/[] = todas)
const cleanCats = (c) => Array.isArray(c) && c.length ? c.map(String) : null;
const round2 = n => Math.round(n * 100) / 100;

// IVA alemán (MwSt) para el precio al público: 19% general, 7% para objetos de arte/cultura.
// Los precios de feria se calculan SIN IVA; el precio final (etiqueta) se guarda CON IVA.
const VAT_GENERAL_PCT = 19;
const VAT_REDUCED_PCT = 7;
const VAT_REDUCED_CATEGORIES = []; // por ahora 19% para todo (antes: ['Art'] al 7%)
const vatPctFor = (categories) => VAT_REDUCED_CATEGORIES.includes((categories || [])[0]) ? VAT_REDUCED_PCT : VAT_GENERAL_PCT;

// GET /api/fairs/categories-list — categorías disponibles (para elegir cuáles absorben el costo)
router.get('/categories-list', async (req, res) => {
  try { res.json(await getCategoryList()); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Failed to fetch categories' }); }
});

// GET /api/fairs/lookup/:code?fairId= — ficha para el cliente al escanear/escribir el código.
// Solo devuelve datos aptos para mostrar al cliente (nunca costos, márgenes ni datos bancarios).
// :code acepta "LUM-0232", "*LUM-0232*" (Code 39), "lum-232" o solo "232".
const pricingCache = new Map(); // fairId -> { at, data }
async function cachedFairPricing(fairId) {
  const hit = pricingCache.get(String(fairId));
  if (hit && Date.now() - hit.at < 30000) return hit.data;
  const data = await computeFairPricing(fairId);
  pricingCache.set(String(fairId), { at: Date.now(), data });
  return data;
}
function normalizeSku(raw) {
  let c = String(raw || '').toUpperCase().replace(/[\s*]/g, '');
  if (/^\d+$/.test(c)) c = 'LUM-' + c.padStart(4, '0');
  const m = c.match(/^LUM-?(\d+)$/);
  if (m) c = 'LUM-' + m[1].padStart(4, '0');
  return c;
}
router.get('/lookup/:code', async (req, res) => {
  try {
    const sku = normalizeSku(req.params.code);
    const pr = await query(`
      SELECT p.id, p.sku, p.name_es, p.name_de, p.categories, p.materials, p.height_cm, p.width_cm, p.depth_cm,
             p.weight_g, p.photos,
             s.id AS supplier_id, s.name AS supplier_name, s.technique AS supplier_technique,
             s.state AS supplier_state, s.municipality AS supplier_municipality, s.photos AS supplier_photos
      FROM products p LEFT JOIN suppliers s ON s.id = p.supplier_id
      WHERE p.sku = $1`, [sku]);
    if (!pr.rows.length) return res.status(404).json({ error: `No encontré el producto ${sku}` });
    const p = pr.rows[0];

    let fairId = req.query.fairId ? parseInt(req.query.fairId) : null;
    if (!fairId) {
      const f = await query(`SELECT id FROM fairs ORDER BY id DESC LIMIT 1`);
      fairId = f.rows[0]?.id || null;
    }
    let price = null;
    if (fairId) {
      const result = await cachedFairPricing(fairId);
      const fp = result?.products.find(x => x.id === p.id);
      if (fp) {
        const vatPct = fp.vatPct;
        const withVat = fp.fair_sale_price_eur != null ? parseFloat(fp.fair_sale_price_eur)
          : (fp.proposedPriceEur != null ? fp.proposedPriceEur : null);
        price = {
          fairName: result.fair.name,
          vatPct,
          withVatEur: withVat,
          netEur: withVat != null ? round2(withVat / (1 + vatPct / 100)) : null,
          vatAmountEur: withVat != null ? round2(withVat - withVat / (1 + vatPct / 100)) : null,
          isProposal: fp.fair_sale_price_eur == null,
        };
      }
    }
    res.json({
      sku: p.sku, nameDe: p.name_de, nameEs: p.name_es,
      categories: p.categories, materials: p.materials,
      heightCm: p.height_cm, widthCm: p.width_cm, depthCm: p.depth_cm, weightG: p.weight_g,
      photos: p.photos,
      supplier: p.supplier_id ? {
        name: p.supplier_name, technique: p.supplier_technique,
        state: p.supplier_state, municipality: p.supplier_municipality, photos: p.supplier_photos,
      } : null,
      fairId, price,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to look up product' });
  }
});

// GET /api/fairs — lista de ferias con total de productos asignados
router.get('/', async (req, res) => {
  try {
    const r = await query(`
      SELECT f.*, COUNT(fp.id)::int AS product_count
      FROM fairs f
      LEFT JOIN fair_products fp ON fp.fair_id = f.id
      GROUP BY f.id
      ORDER BY f.created_at DESC
    `);
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch fairs' });
  }
});

// GET /api/fairs/assignable-products — productos que pueden asignarse a una feria:
// los que ya están en inventario (current_stock) o en alguna orden de compra
router.get('/assignable-products', async (req, res) => {
  try {
    const r = await query(`
      SELECT p.id, p.sku, p.name_es, p.categories, p.photos, p.purchase_price_mxn, s.name AS supplier_name,
        COALESCE(stk.qty, 0) AS available_qty,
        COALESCE(stk.locations, '[]'::json) AS stock_locations
      FROM products p
      LEFT JOIN suppliers s ON s.id = p.supplier_id
      LEFT JOIN LATERAL (
        SELECT SUM(qty)::int AS qty,
          json_agg(json_build_object('location', location_name, 'qty', qty)) AS locations
        FROM current_stock WHERE product_id = p.id AND location_type <> 'writeoff'
      ) stk ON true
      WHERE EXISTS (SELECT 1 FROM purchase_order_lines pol WHERE pol.product_id = p.id)
         OR EXISTS (SELECT 1 FROM current_stock cs WHERE cs.product_id = p.id)
      ORDER BY p.name_es
    `);
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch assignable products' });
  }
});

// GET /api/fairs/:id/multipliers — multiplicador por categoría, propio de esta feria
// (a diferencia del multiplicador general de Pricing, cada feria puede tener su
// propio margen por categoría — ej. joyería más cara en una feria premium).
router.get('/:id/multipliers', async (req, res) => {
  try {
    const fairRes = await query(`SELECT id FROM fairs WHERE id=$1`, [req.params.id]);
    if (!fairRes.rows.length) return res.status(404).json({ error: 'Fair not found' });

    const categories = await getCategoryList();
    const settings = await getGlobalSettings();
    // Sembrar con el multiplicador general como punto de partida razonable la
    // primera vez que se abre esta pantalla para la feria.
    for (const cat of categories) {
      await query(
        `INSERT INTO fair_category_multipliers (fair_id, category, multiplier)
         VALUES ($1,$2,$3) ON CONFLICT (fair_id, category) DO NOTHING`,
        [req.params.id, cat, settings.generalMultiplier]
      );
    }

    const rows = await query(
      `SELECT category, multiplier FROM fair_category_multipliers WHERE fair_id=$1 ORDER BY category`,
      [req.params.id]
    );
    res.json(rows.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch fair multipliers' });
  }
});

// PUT /api/fairs/:id/multipliers — guardar multiplicadores por categoría de esta feria
router.put('/:id/multipliers', async (req, res) => {
  try {
    const { multipliers } = req.body;
    for (const m of (multipliers || [])) {
      await query(
        `INSERT INTO fair_category_multipliers (fair_id, category, multiplier, updated_at)
         VALUES ($1,$2,$3, now())
         ON CONFLICT (fair_id, category) DO UPDATE SET multiplier = $3, updated_at = now()`,
        [req.params.id, m.category, parseFloat(m.multiplier) || 1]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save fair multipliers' });
  }
});

// POST /api/fairs
router.post('/', async (req, res) => {
  try {
    const { name, totalCostEur, notes, costDistribution, costCategories } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
    const r = await query(
      `INSERT INTO fairs (name, total_cost_eur, notes, cost_distribution, cost_categories) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name.trim(), parseFloat(totalCostEur) || 0, notes || null, DIST_MODES.includes(costDistribution) ? costDistribution : 'per_piece', cleanCats(costCategories)]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create fair' });
  }
});

// PUT /api/fairs/:id
router.put('/:id', async (req, res) => {
  try {
    const { name, totalCostEur, notes, costDistribution, costCategories } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
    const r = await query(
      `UPDATE fairs SET name=$1, total_cost_eur=$2, notes=$3, cost_distribution=$4, cost_categories=$5, updated_at=now() WHERE id=$6 RETURNING *`,
      [name.trim(), parseFloat(totalCostEur) || 0, notes || null, DIST_MODES.includes(costDistribution) ? costDistribution : 'per_piece', cleanCats(costCategories), req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Fair not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update fair' });
  }
});

// DELETE /api/fairs/:id
router.delete('/:id', async (req, res) => {
  try {
    await query(`DELETE FROM fairs WHERE id=$1`, [req.params.id]);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete fair' });
  }
});

// Productos asignados a una feria con precio calculado, prorrateando el costo
// total de la feria entre el total de PIEZAS asignadas (no entre el número de
// SKUs). Factorizado como función exportable para que reports.js pueda reusar
// exactamente el mismo cálculo al armar el reporte de catálogo (columna
// "precio feria") sin duplicar la lógica de prorrateo.
export async function computeFairPricing(fairId) {
  const fairRes = await query(`SELECT * FROM fairs WHERE id=$1`, [fairId]);
  if (!fairRes.rows.length) return null;
  const fair = fairRes.rows[0];

    const settings = await getGlobalSettings();
    const basePct = settings.packagingShippingPct + settings.marketingPct + settings.otherCostsPct;

    // El multiplicador aplicado es el de esta feria por categoría (fair_category_multipliers),
    // no el multiplicador general de Pricing → General — cada feria puede tener su propio margen.
    const assigned = await query(`
      SELECT fp.product_id AS assignment_product_id, fp.sale_price_eur AS fair_sale_price_eur,
        fp.quantity,
        p.id, p.sku, p.name_es, p.photos, p.purchase_price_mxn, p.sale_price_eur, p.categories, s.name AS supplier_name,
        COALESCE(fm.multiplier, $2) AS multiplier,
        ic.price_eur AS intercompany_price_eur,
        COALESCE(stk.qty, 0) AS available_qty,
        COALESCE(mun.qty, 0) AS munich_qty
      FROM fair_products fp
      JOIN products p ON p.id = fp.product_id
      LEFT JOIN suppliers s ON s.id = p.supplier_id
      LEFT JOIN fair_category_multipliers fm ON fm.fair_id = fp.fair_id AND fm.category = COALESCE(p.categories[1], 'Sin categoría')
      LEFT JOIN LATERAL (
        SELECT price_eur FROM intercompany_transfers
        WHERE product_id = p.id ORDER BY transfer_date DESC, created_at DESC LIMIT 1
      ) ic ON true
      LEFT JOIN LATERAL (
        SELECT SUM(qty)::int AS qty FROM current_stock WHERE product_id = p.id AND location_type <> 'writeoff'
      ) stk ON true
      LEFT JOIN LATERAL (
        SELECT SUM(qty)::int AS qty FROM current_stock WHERE product_id = p.id AND location_name = 'Bodega Munich'
      ) mun ON true
      WHERE fp.fair_id = $1
      ORDER BY p.name_es
    `, [fairId, settings.generalMultiplier]);

    const productCount = assigned.rows.length;
    const totalQuantity = assigned.rows.reduce((sum, p) => sum + (parseInt(p.quantity) || 0), 0);
    // El costo de la feria se captura en EUR (se paga en Alemania); se prorratea
    // en EUR entre el total de piezas y se convierte a MXN con el tipo de cambio
    // para sumarlo al precio base — es el mismo monto por pieza para todos los productos.
    const fairCostPerUnitEur = totalQuantity > 0 ? (parseFloat(fair.total_cost_eur) || 0) / totalQuantity : 0;
    // Precio base de cada producto (antes de multiplicador y de costo de feria).
    // Prioridad: el "Precio EUR asignado" (confirmado a mano); si no hay, el precio
    // calculado automático de General — que usa el precio intercompany como costo si
    // el producto ya fue transferido a Luumil Alemania, o el costo del proveedor si no.
    const shipMap = await getShippingUnitCostMap();
    const baseOf = (p) => {
      const purchasePrice = parseFloat(p.purchase_price_mxn) || 0;
      const isIntercompany = p.intercompany_price_eur != null;
      const shipUnit = shipMap.get(p.id);
      const costoBaseGeneralMxn = isIntercompany
        ? parseFloat(p.intercompany_price_eur) * settings.exchangeRate
        : (shipUnit != null
            // Envío fijo por pieza (lote de maletas/DHL) en lugar del % de embalaje/envío
            ? purchasePrice * (1 + (settings.marketingPct + settings.otherCostsPct) / 100) + shipUnit * settings.exchangeRate
            : purchasePrice * (1 + basePct / 100));
      const generalCalculadoMxn = costoBaseGeneralMxn * settings.generalMultiplier;
      const generalCalculadoEur = settings.exchangeRate > 0 ? generalCalculadoMxn / settings.exchangeRate : null;
      const assignedEur = p.sale_price_eur != null ? parseFloat(p.sale_price_eur) : null;
      const basePriceEur = assignedEur != null ? assignedEur : generalCalculadoEur;
      return {
        isIntercompany,
        shippingEstimated: shipUnit == null && !isIntercompany,
        basePriceSource: assignedEur != null ? 'assigned' : 'calculated',
        basePriceEur,
        basePriceMxn: basePriceEur != null ? basePriceEur * settings.exchangeRate : null,
      };
    };
    const bases = new Map(assigned.rows.map(p => [p.id, baseOf(p)]));
    const qtyOf = (p) => parseInt(p.quantity) || 0;
    const catOf = (p) => (p.categories || [])[0] || 'Sin categoría';

    // Distribución del costo de la feria (EUR por pieza de cada producto):
    // 1) Primero se eligen las categorías que SÍ absorben el costo (fair.cost_categories;
    //    vacío = todas). Los productos de las demás categorías no cargan costo de feria.
    // 2) El costo total se reparte solo entre los productos elegidos, según el modo:
    //    - per_piece: mismo monto por pieza (total / piezas elegidas).
    //    - by_price:  proporcional al precio base × piezas (los más caros absorben más).
    //    - none:      no se suma costo de feria.
    const totalFairCost = parseFloat(fair.total_cost_eur) || 0;
    const mode = fair.cost_distribution === 'none' || fair.cost_distribution === 'by_price' ? fair.cost_distribution : 'per_piece';
    const costCats = Array.isArray(fair.cost_categories) && fair.cost_categories.length ? new Set(fair.cost_categories) : null;
    const absorbs = (p) => !costCats || costCats.has(catOf(p));
    const absorbing = assigned.rows.filter(absorbs);
    const absorbingQty = absorbing.reduce((s, p) => s + qtyOf(p), 0);
    const feeUnitEur = new Map();
    assigned.rows.forEach(p => feeUnitEur.set(p.id, 0));
    if (mode === 'by_price') {
      const weightTotal = absorbing.reduce((s, p) => s + (bases.get(p.id).basePriceEur || 0) * qtyOf(p), 0);
      absorbing.forEach(p => feeUnitEur.set(p.id,
        weightTotal > 0 ? totalFairCost * (bases.get(p.id).basePriceEur || 0) / weightTotal : 0));
    } else if (mode === 'per_piece') {
      absorbing.forEach(p => feeUnitEur.set(p.id, absorbingQty > 0 ? totalFairCost / absorbingQty : 0));
    }

    const products = assigned.rows.map(p => {
      const { isIntercompany, shippingEstimated, basePriceSource, basePriceEur, basePriceMxn } = bases.get(p.id);
      const unitFeeEur = feeUnitEur.get(p.id) || 0;
      const fairCostPerUnitMxn = unitFeeEur * settings.exchangeRate;

      // El multiplicador (margen) se aplica SOLO al precio base; el costo de la
      // feria por pieza se suma DESPUÉS, sin multiplicarse: precio = base × mult + feria.
      const multiplier = parseFloat(p.multiplier) || 1;
      const markedUpMxn = basePriceMxn != null ? basePriceMxn * multiplier : null;
      const markedUpEur = settings.exchangeRate > 0 && markedUpMxn != null ? markedUpMxn / settings.exchangeRate : null;
      const precioCalculadoMxn = markedUpMxn != null ? markedUpMxn + fairCostPerUnitMxn : null;
      const precioCalculadoEur = settings.exchangeRate > 0 && precioCalculadoMxn != null ? precioCalculadoMxn / settings.exchangeRate : null;

      // Precio al público: el precio calculado (sin IVA) + IVA. La propuesta de precio final
      // es ese precio con IVA redondeado al múltiplo más cercano (arriba o abajo): de 5 €
      // si es menor a 60 €, de 10 € a partir de 60 €; mínimo 5 €. Myriam la acepta o la
      // cambia a mano, y lo que acepte/cambie se guarda como el precio de etiqueta (CON IVA).
      const vatPct = vatPctFor(p.categories);
      const publicCalcEur = precioCalculadoEur != null ? precioCalculadoEur * (1 + vatPct / 100) : null;
      const roundStep = publicCalcEur != null && publicCalcEur < 60 ? 5 : 10;
      const proposedPriceEur = publicCalcEur != null && publicCalcEur > 0
        ? Math.max(5, Math.round(publicCalcEur / roundStep) * roundStep) : null;
      const proposedNetEur = proposedPriceEur != null ? proposedPriceEur / (1 + vatPct / 100) : null;
      const finalPriceEur = p.fair_sale_price_eur != null ? parseFloat(p.fair_sale_price_eur) : null;
      const finalNetEur = finalPriceEur != null ? finalPriceEur / (1 + vatPct / 100) : null;

      return {
        ...p,
        proposedPriceEur,
        proposedNetEur: proposedNetEur != null ? round2(proposedNetEur) : null,
        vatPct,
        publicCalcEur: publicCalcEur != null ? round2(publicCalcEur) : null,
        finalNetEur: finalNetEur != null ? round2(finalNetEur) : null,
        shippingEstimated,
        anyShippingLots: shipMap.size > 0,
        fairCostPerUnitEur: round2(unitFeeEur),
        basePriceSource,
        costSource: isIntercompany ? 'intercompany' : 'supplier',
        basePriceMxn: basePriceMxn != null ? round2(basePriceMxn) : null,
        basePriceEur: basePriceEur != null ? round2(basePriceEur) : null,
        markedUpMxn: markedUpMxn != null ? round2(markedUpMxn) : null,
        markedUpEur: markedUpEur != null ? round2(markedUpEur) : null,
        precioCalculadoMxn: precioCalculadoMxn != null ? round2(precioCalculadoMxn) : null,
        precioCalculadoEur: precioCalculadoEur != null ? round2(precioCalculadoEur) : null,
        exchangeRate: settings.exchangeRate,
      };
    });

  return {
    fair: { ...fair, productCount, totalQuantity, fairCostPerUnitEur: round2(absorbingQty > 0 ? totalFairCost / absorbingQty : 0), costDistribution: mode, costCategories: costCats ? [...costCats] : [] },
    products,
  };
}

// GET /api/fairs/:id/products — productos asignados, con precio calculado
router.get('/:id/products', async (req, res) => {
  try {
    const result = await computeFairPricing(req.params.id);
    if (!result) return res.status(404).json({ error: 'Fair not found' });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch fair products' });
  }
});

// POST /api/fairs/:id/products — asignar un producto a la feria
router.post('/:id/products', async (req, res) => {
  try {
    const { productId } = req.body;
    if (!productId) return res.status(400).json({ error: 'productId es requerido' });
    const r = await query(
      `INSERT INTO fair_products (fair_id, product_id) VALUES ($1,$2)
       ON CONFLICT (fair_id, product_id) DO NOTHING RETURNING *`,
      [req.params.id, productId]
    );
    res.status(201).json(r.rows[0] || { ok: true, alreadyAssigned: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to assign product' });
  }
});

// POST /api/fairs/:id/products/bulk — asignar varios productos de un jalón (selección masiva)
router.post('/:id/products/bulk', async (req, res) => {
  try {
    const { productIds } = req.body;
    if (!Array.isArray(productIds) || !productIds.length) return res.status(400).json({ error: 'productIds es requerido' });
    await query(
      `INSERT INTO fair_products (fair_id, product_id)
       SELECT $1, unnest($2::int[])
       ON CONFLICT (fair_id, product_id) DO NOTHING`,
      [req.params.id, productIds]
    );
    res.json({ ok: true, added: productIds.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to bulk assign products' });
  }
});

// POST /api/fairs/:id/products/bulk-remove — sacar varios productos de la feria de un jalón
router.post('/:id/products/bulk-remove', async (req, res) => {
  try {
    const { productIds } = req.body;
    if (!Array.isArray(productIds) || !productIds.length) return res.status(400).json({ error: 'productIds es requerido' });
    const r = await query(
      `DELETE FROM fair_products WHERE fair_id=$1 AND product_id = ANY($2::int[])`,
      [req.params.id, productIds]
    );
    res.json({ ok: true, removed: r.rowCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to bulk remove products' });
  }
});

// POST /api/fairs/:id/products/use-munich-qty — para los productos de la feria que
// tienen piezas en Bodega Munich, la cantidad asignada pasa a ser la disponible allá.
// Los que no tienen stock en Munich no se tocan.
router.post('/:id/products/use-munich-qty', async (req, res) => {
  try {
    const r = await query(`
      UPDATE fair_products fp SET quantity = m.qty
      FROM (
        SELECT product_id, SUM(qty)::int AS qty FROM current_stock
        WHERE location_name = 'Bodega Munich' GROUP BY product_id HAVING SUM(qty) > 0
      ) m
      WHERE fp.fair_id = $1 AND fp.product_id = m.product_id AND fp.quantity IS DISTINCT FROM m.qty
    `, [req.params.id]);
    res.json({ ok: true, updated: r.rowCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to use Munich quantities' });
  }
});

// POST /api/fairs/:id/products/accept-proposals — aceptar de un jalón la propuesta de
// precio (calculado redondeado: base 5 bajo 60 €, base 10 desde 60 €) en todos los productos que aún no tienen
// precio final definido para esta feria. No pisa los precios ya aceptados o cambiados.
router.post('/:id/products/accept-proposals', async (req, res) => {
  try {
    const result = await computeFairPricing(req.params.id);
    if (!result) return res.status(404).json({ error: 'Fair not found' });
    let accepted = 0;
    for (const p of result.products) {
      if (p.fair_sale_price_eur == null && p.proposedPriceEur != null) {
        await query(`UPDATE fair_products SET sale_price_eur=$1 WHERE fair_id=$2 AND product_id=$3`,
          [p.proposedPriceEur, req.params.id, p.id]);
        accepted++;
      }
    }
    res.json({ ok: true, accepted });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to accept proposals' });
  }
});

// DELETE /api/fairs/:id/products/:productId — quitar producto de la feria
router.delete('/:id/products/:productId', async (req, res) => {
  try {
    await query(`DELETE FROM fair_products WHERE fair_id=$1 AND product_id=$2`, [req.params.id, req.params.productId]);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to remove product from fair' });
  }
});

// PUT /api/fairs/:id/products/:productId/quantity — piezas de este producto para esta feria
router.put('/:id/products/:productId/quantity', async (req, res) => {
  try {
    const { quantity } = req.body;
    const qty = parseInt(quantity);
    if (!qty || qty < 1) return res.status(400).json({ error: 'La cantidad debe ser al menos 1' });
    const r = await query(
      `UPDATE fair_products SET quantity=$1 WHERE fair_id=$2 AND product_id=$3 RETURNING *`,
      [qty, req.params.id, req.params.productId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Assignment not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update quantity' });
  }
});

// PUT /api/fairs/:id/products/:productId/price — precio EUR ajustado específico de esta feria
router.put('/:id/products/:productId/price', async (req, res) => {
  try {
    const { salePriceEur } = req.body;
    const r = await query(
      `UPDATE fair_products SET sale_price_eur=$1 WHERE fair_id=$2 AND product_id=$3 RETURNING *`,
      [salePriceEur === '' || salePriceEur == null ? null : parseFloat(salePriceEur), req.params.id, req.params.productId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Assignment not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update fair price' });
  }
});

export default router;
