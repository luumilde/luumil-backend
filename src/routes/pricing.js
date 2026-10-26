import express from 'express';
import { query } from '../db/pool.js';

const router = express.Router();

const GLOBAL_PCT_KEYS = ['packaging_shipping_pct', 'marketing_pct', 'other_costs_pct'];

// Lista de categorías conocidas (de productos y proveedores), más 'Sin categoría'
// de respaldo — la usan tanto General (ya no, ver abajo) como cada Feria para
// saber qué categorías mostrar en su propia configuración de multiplicadores.
export async function getCategoryList() {
  const cats = await query(`
    SELECT DISTINCT val FROM (
      SELECT unnest(categories) AS val FROM products WHERE categories IS NOT NULL
      UNION
      SELECT unnest(categories) AS val FROM suppliers WHERE categories IS NOT NULL
      UNION
      SELECT 'Sin categoría' AS val
    ) x WHERE val IS NOT NULL ORDER BY val
  `);
  return cats.rows.map(r => r.val);
}

export async function getGlobalSettings() {
  const r = await query(`SELECT key, value FROM app_settings`);
  const map = Object.fromEntries(r.rows.map(row => [row.key, parseFloat(row.value) || 0]));
  return {
    exchangeRate: map.eur_mxn_rate || 0,
    packagingShippingPct: map.packaging_shipping_pct || 0,
    marketingPct: map.marketing_pct || 0,
    otherCostsPct: map.other_costs_pct || 0,
    // Un solo multiplicador de rentabilidad aplicado a todos los productos —
    // reemplaza el multiplicador por categoría, que ahora se configura por feria.
    generalMultiplier: map.general_multiplier || 1,
  };
}


// Costo de envío fijo por pieza (EUR) por producto, a partir de los lotes de envío
// (maletas, DHL…). Si un producto tiene piezas en varios lotes, es el promedio
// ponderado por cantidad. Si la migración aún no corrió, devuelve un mapa vacío.
export async function getShippingUnitCostMap() {
  try {
    const r = await query(`
      SELECT product_id, SUM(quantity * unit_cost_eur) / NULLIF(SUM(quantity), 0) AS unit
      FROM shipping_lot_items GROUP BY product_id
    `);
    return new Map(r.rows.map(x => [x.product_id, parseFloat(x.unit) || 0]));
  } catch { return new Map(); }
}

// Reparte un costo total entre las piezas que hay en Bodega Munich y que todavía
// no tienen costo de envío asignado (stock en Munich − piezas ya asignadas a lotes).
//  - weight:    proporcional al peso (g) de cada pieza. A las piezas sin peso se les
//               asigna el peso promedio de las que sí lo tienen (respaldo); si ninguna
//               tiene peso, se reparte igual por pieza.
//  - per_piece: mismo monto por pieza.
// `categories` (opcional): solo las piezas de esas categorías absorben el costo.
async function allocateShipping(totalCostEur, method, categories) {
  const cats = Array.isArray(categories) && categories.length ? categories.map(String) : null;
  const r = await query(`
    SELECT p.id AS product_id, p.sku, p.name_es, p.weight_g,
      (mun.qty - COALESCE(al.qty, 0))::int AS quantity
    FROM products p
    JOIN LATERAL (SELECT COALESCE(SUM(qty),0)::int AS qty FROM current_stock
                  WHERE product_id = p.id AND location_name = 'Bodega Munich') mun ON true
    LEFT JOIN LATERAL (SELECT SUM(quantity)::int AS qty FROM shipping_lot_items WHERE product_id = p.id) al ON true
    WHERE mun.qty - COALESCE(al.qty, 0) > 0
      AND ($1::text[] IS NULL OR COALESCE(p.categories[1], 'Sin categoría') = ANY($1::text[]))
    ORDER BY p.sku
  `, [cats]);
  const rows = r.rows.map(x => ({ ...x, weight: parseFloat(x.weight_g) > 0 ? parseFloat(x.weight_g) : null }));
  const totalPieces = rows.reduce((s, x) => s + x.quantity, 0);
  const weighted = rows.filter(x => x.weight != null);
  const weightedPieces = weighted.reduce((s, x) => s + x.quantity, 0);
  const avgWeight = weightedPieces > 0 ? weighted.reduce((s, x) => s + x.weight * x.quantity, 0) / weightedPieces : null;
  const useWeight = method === 'weight' && avgWeight != null;
  const effW = (x) => useWeight ? (x.weight != null ? x.weight : avgWeight) : 1;
  const denom = rows.reduce((s, x) => s + effW(x) * x.quantity, 0);
  const items = rows.map(x => ({
    product_id: x.product_id, sku: x.sku, name_es: x.name_es, quantity: x.quantity,
    weight_g: x.weight, missing_weight: x.weight == null,
    unit_cost_eur: denom > 0 ? totalCostEur * effW(x) / denom : 0,
  }));
  return { items, totalPieces, missingWeight: rows.filter(x => x.weight == null).length, usedMethod: useWeight ? 'weight' : 'per_piece' };
}

// GET /api/pricing/shipping-lots — lotes de envío registrados
router.get('/shipping-lots', async (req, res) => {
  try {
    const r = await query(`
      SELECT l.*, COALESCE(SUM(i.quantity),0)::int AS pieces, COUNT(i.id)::int AS products
      FROM shipping_lots l LEFT JOIN shipping_lot_items i ON i.lot_id = l.id
      GROUP BY l.id ORDER BY l.created_at DESC
    `);
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch shipping lots (¿corriste migrate_shipping_lots.js?)' });
  }
});

// POST /api/pricing/shipping-lots/preview — calcula el reparto sin guardar nada
router.post('/shipping-lots/preview', async (req, res) => {
  try {
    const total = parseFloat(req.body.totalCostEur);
    if (!(total > 0)) return res.status(400).json({ error: 'El costo total debe ser mayor a 0' });
    const a = await allocateShipping(total, req.body.method === 'per_piece' ? 'per_piece' : 'weight', req.body.categories);
    res.json({ ...a, totalCostEur: total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to preview shipping allocation' });
  }
});

// POST /api/pricing/shipping-lots — crear el lote y asignar el costo a cada producto
router.post('/shipping-lots', async (req, res) => {
  try {
    const { name, totalCostEur, method, notes, categories } = req.body;
    const total = parseFloat(totalCostEur);
    if (!name?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
    if (!(total > 0)) return res.status(400).json({ error: 'El costo total debe ser mayor a 0' });
    const a = await allocateShipping(total, method === 'per_piece' ? 'per_piece' : 'weight', categories);
    if (!a.items.length) return res.status(400).json({ error: 'No hay piezas en Bodega Munich sin costo de envío asignado' });
    const lot = await query(
      `INSERT INTO shipping_lots (name, total_cost_eur, method, notes, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name.trim(), total, a.usedMethod, notes || null, req.user?.userName]
    );
    for (const it of a.items) {
      await query(`INSERT INTO shipping_lot_items (lot_id, product_id, quantity, unit_cost_eur) VALUES ($1,$2,$3,$4)`,
        [lot.rows[0].id, it.product_id, it.quantity, it.unit_cost_eur]);
    }
    res.status(201).json({ ...lot.rows[0], pieces: a.totalPieces, products: a.items.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create shipping lot' });
  }
});

// DELETE /api/pricing/shipping-lots/:id — deshacer un lote (los productos vuelven al % general)
router.delete('/shipping-lots/:id', async (req, res) => {
  try {
    await query(`DELETE FROM shipping_lots WHERE id=$1`, [req.params.id]);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete shipping lot' });
  }
});

// GET /api/pricing/settings — configuración global de costos + multiplicador general
router.get('/settings', async (req, res) => {
  try {
    const settings = await getGlobalSettings();
    res.json(settings);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch pricing settings' });
  }
});

// PUT /api/pricing/settings — guarda configuración global (%, tipo de cambio, multiplicador general)
router.put('/settings', async (req, res) => {
  try {
    const { exchangeRate, packagingShippingPct, marketingPct, otherCostsPct, generalMultiplier } = req.body;

    const kv = {
      eur_mxn_rate: exchangeRate,
      packaging_shipping_pct: packagingShippingPct,
      marketing_pct: marketingPct,
      other_costs_pct: otherCostsPct,
    };
    for (const [key, value] of Object.entries(kv)) {
      if (value === undefined) continue;
      await query(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ($1,$2, now())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
        [key, String(parseFloat(value) || 0)]
      );
    }

    if (generalMultiplier !== undefined) {
      await query(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ('general_multiplier',$1, now())
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
        [String(parseFloat(generalMultiplier) || 1)]
      );
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save pricing settings' });
  }
});

// GET /api/pricing/products — precio calculado (MXN y EUR) por producto
router.get('/products', async (req, res) => {
  try {
    const { search, category, supplierId } = req.query;
    const settings = await getGlobalSettings();
    const totalPct = settings.packagingShippingPct + settings.marketingPct + settings.otherCostsPct;
    const shipMap = await getShippingUnitCostMap();

    // Solo productos que ya están en al menos una orden de compra
    let sql = `
      SELECT p.id, p.sku, p.name_es, p.photos, p.purchase_price_mxn, p.sale_price_eur,
        p.categories, s.id AS supplier_id, s.name AS supplier_name,
        ic.price_eur AS intercompany_price_eur
      FROM products p
      LEFT JOIN suppliers s ON s.id = p.supplier_id
      LEFT JOIN LATERAL (
        SELECT price_eur FROM intercompany_transfers
        WHERE product_id = p.id ORDER BY transfer_date DESC, created_at DESC LIMIT 1
      ) ic ON true
      WHERE EXISTS (SELECT 1 FROM purchase_order_lines pol WHERE pol.product_id = p.id)
    `;
    const conditions = [];
    const params = [];
    if (search) { params.push(`%${search}%`); conditions.push(`(p.name_es ILIKE $${params.length} OR p.sku ILIKE $${params.length})`); }
    if (category) { params.push(category); conditions.push(`COALESCE(p.categories[1], 'Sin categoría') = $${params.length}`); }
    if (supplierId) { params.push(supplierId); conditions.push(`s.id = $${params.length}`); }
    if (conditions.length) sql += ' AND ' + conditions.join(' AND ');
    sql += ' ORDER BY p.name_es';

    const result = await query(sql, params);
    const round2 = n => Math.round(n * 100) / 100;
    const rows = result.rows.map(p => {
      const purchasePrice = parseFloat(p.purchase_price_mxn) || 0;
      const isIntercompany = p.intercompany_price_eur != null;
      // Costo: si el producto ya fue transferido de Luumil México a Luumil Alemania
      // (existe una transferencia intercompany), el costo es directamente ese precio
      // — ya incluye lo que México quiso cubrir, no se le vuelve a aplicar % de
      // embalaje/envío/marketing/otros. Si no, el cálculo de siempre desde el proveedor.
      // Si el producto tiene costo de envío fijo (lote de maletas/DHL), ese monto
      // reemplaza el % de embalaje/envío: costo = compra × (1 + marketing% + otros%) + envío fijo.
      const shippingUnitEur = shipMap.get(p.id);
      const hasFixedShipping = shippingUnitEur != null;
      const rowPct = hasFixedShipping ? settings.marketingPct + settings.otherCostsPct : totalPct;
      const costoMxnSupplier = purchasePrice * (1 + rowPct / 100) + (hasFixedShipping ? shippingUnitEur * settings.exchangeRate : 0);
      const costoEur = isIntercompany
        ? parseFloat(p.intercompany_price_eur)
        : (settings.exchangeRate > 0 ? costoMxnSupplier / settings.exchangeRate : null);
      const costoMxn = isIntercompany
        ? parseFloat(p.intercompany_price_eur) * settings.exchangeRate
        : costoMxnSupplier;
      // Precio calculado: el costo con el multiplicador general de rentabilidad aplicado
      // (un solo multiplicador para todos los productos — el multiplicador por
      // categoría ahora se configura por feria, no aquí).
      const precioCalculadoMxn = costoMxn * settings.generalMultiplier;
      const precioCalculadoEur = settings.exchangeRate > 0 ? precioCalculadoMxn / settings.exchangeRate : null;
      return {
        ...p,
        totalPct: rowPct,
        shippingUnitEur: hasFixedShipping && !isIntercompany ? round2(shippingUnitEur) : null,
        multiplier: settings.generalMultiplier,
        costSource: isIntercompany ? 'intercompany' : 'supplier',
        costoMxn: round2(costoMxn),
        costoEur: costoEur != null ? round2(costoEur) : null,
        precioCalculadoMxn: round2(precioCalculadoMxn),
        precioCalculadoEur: precioCalculadoEur != null ? round2(precioCalculadoEur) : null,
        exchangeRate: settings.exchangeRate,
      };
    });
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch product pricing' });
  }
});

export default router;
