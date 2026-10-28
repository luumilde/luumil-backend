import express from 'express';
import { query } from '../db/pool.js';
import { getGlobalSettings, getShippingUnitCostMap } from './pricing.js';
import { computeFairPricing } from './fairs.js';

const router = express.Router();
const round2 = n => Math.round(n * 100) / 100;

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
          SUM(CASE WHEN bodega = 'Baja' THEN qty ELSE 0 END) AS baja,
          SUM(CASE WHEN bodega = 'Baja' THEN 0 ELSE qty END) AS total_en_bodega
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
        COALESCE(sp.baja, 0) AS baja,
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

// Catálogo completo de productos para descargar — junta info de producto,
// proveedor (incl. ciudad/estado/contacto), inventario por bodega, precios
// (compra, intercompany, base general, por feria), medidas/peso y foto.
// Solo incluye productos que ya pasaron por al menos una orden de compra
// (mismo criterio de "disponible" que Pricing e Intercompany).
router.get('/product-catalog', async (req, res) => {
  try {
    const settings = await getGlobalSettings();
    const totalPct = settings.packagingShippingPct + settings.marketingPct + settings.otherCostsPct;

    const productsRes = await query(`
      SELECT p.id, p.sku, p.name_es, p.name_de, p.categories, p.materials,
        p.height_cm, p.width_cm, p.depth_cm, p.weight_g, p.photos,
        p.purchase_price_mxn, p.sale_price_eur, p.hs_code, p.regulatory_status,
        s.name AS supplier_name, s.city AS supplier_city, s.state AS supplier_state,
        s.contact_name AS supplier_contact, s.whatsapp AS supplier_whatsapp, s.email AS supplier_email,
        ic.price_eur AS intercompany_price_eur,
        (SELECT STRING_AGG(DISTINCT po.folio, ', ' ORDER BY po.folio)
         FROM purchase_order_lines pol JOIN purchase_orders po ON po.id = pol.purchase_order_id
         WHERE pol.product_id = p.id AND po.status != 'cancelled') AS ordenes_compra,
        (SELECT STRING_AGG(
           fd.folio || CASE WHEN fd.amount_mxn IS NOT NULL THEN ' ($' || fd.amount_mxn || ')' ELSE '' END,
           ', ' ORDER BY fd.doc_date NULLS LAST
         )
         FROM purchase_order_lines pol
         JOIN purchase_orders po ON po.id = pol.purchase_order_id
         JOIN fiscal_documents fd ON fd.purchase_order_id = po.id
         WHERE pol.product_id = p.id AND fd.doc_type = 'recibo' AND fd.status != 'cancelado') AS recibo_info,
        (SELECT STRING_AGG(DISTINCT sm.reference, ', ' ORDER BY sm.reference)
         FROM stock_movements sm
         WHERE sm.product_id = p.id AND sm.movement_type = 'transfer'
           AND sm.reference IS NOT NULL AND sm.reference != '') AS referencias_traslado,
        (SELECT STRING_AGG(sub.reference || ' (' || sub.qty || ')', ', ' ORDER BY sub.reference)
         FROM (
           SELECT COALESCE(NULLIF(sm.reference, ''), 'sin referencia') AS reference, SUM(sm.quantity)::numeric AS qty
           FROM stock_movements sm
           WHERE sm.product_id = p.id AND sm.movement_type = 'transfer'
           GROUP BY 1
         ) sub) AS detalle_traslados,
        (SELECT COALESCE(SUM(sm.quantity), 0) FROM stock_movements sm
         WHERE sm.product_id = p.id AND sm.movement_type = 'transfer') AS cantidad_trasladada
      FROM products p
      LEFT JOIN suppliers s ON s.id = p.supplier_id
      LEFT JOIN LATERAL (
        SELECT price_eur FROM intercompany_transfers
        WHERE product_id = p.id ORDER BY transfer_date DESC, created_at DESC LIMIT 1
      ) ic ON true
      WHERE EXISTS (
        SELECT 1 FROM purchase_order_lines pol
        JOIN purchase_orders po ON po.id = pol.purchase_order_id
        WHERE pol.product_id = p.id AND po.status != 'cancelled'
      )
      ORDER BY p.name_es
    `);

    // Stock por producto x bodega (mismas 3 ubicaciones que el resto de la app)
    const stockRes = await query(`SELECT product_id, location_name, qty FROM current_stock`);
    const stockByProduct = {};
    for (const row of stockRes.rows) {
      if (!stockByProduct[row.product_id]) stockByProduct[row.product_id] = {};
      stockByProduct[row.product_id][row.location_name] = parseFloat(row.qty) || 0;
    }

    // Precio por feria: se recalcula con la misma lógica prorrateada que usa
    // Pricing → Ferias (computeFairPricing), una vez por feria, y se arma un
    // resumen en texto por producto (puede estar en varias ferias a la vez).
    const fairsRes = await query(`SELECT id, name FROM fairs ORDER BY name`);
    const fairPriceByProduct = {};
    const fairFinalByProduct = {};   // precio final definido (aceptado/cambiado) por feria
    const fairProposalByProduct = {}; // propuesta de precio al público (con IVA, redondeada) por feria
    const fairPublicCalcByProduct = {}; // precio calculado con IVA por feria
    const vatByProduct = {};            // IVA aplicable al producto (19% general, 7% arte)
    for (const fair of fairsRes.rows) {
      const computed = await computeFairPricing(fair.id);
      if (!computed) continue;
      for (const fp of computed.products) {
        if (!fairPriceByProduct[fp.id]) fairPriceByProduct[fp.id] = [];
        const eur = fp.precioCalculadoEur != null ? `€${fp.precioCalculadoEur}` : '—';
        fairPriceByProduct[fp.id].push(`${fair.name}: ${eur}`);
        if (!fairPublicCalcByProduct[fp.id]) fairPublicCalcByProduct[fp.id] = [];
        fairPublicCalcByProduct[fp.id].push(`${fair.name}: ${fp.publicCalcEur != null ? '€' + fp.publicCalcEur : '—'}`);
        vatByProduct[fp.id] = fp.vatPct;
        if (!fairFinalByProduct[fp.id]) fairFinalByProduct[fp.id] = [];
        if (!fairProposalByProduct[fp.id]) fairProposalByProduct[fp.id] = [];
        fairFinalByProduct[fp.id].push(`${fair.name}: ${fp.fair_sale_price_eur != null ? '€' + fp.fair_sale_price_eur + ' con IVA (neto €' + fp.finalNetEur + ')' : 'sin definir'}`);
        fairProposalByProduct[fp.id].push(`${fair.name}: ${fp.proposedPriceEur != null ? '€' + fp.proposedPriceEur + ' con IVA (neto €' + fp.proposedNetEur + ')' : '—'}`);
      }
    }

    // Lotes de envío (maletas/DHL) por producto, para el desglose de costos
    const shipMap = await getShippingUnitCostMap();
    const lotNamesByProduct = {};
    try {
      const lr = await query(`
        SELECT i.product_id, STRING_AGG(DISTINCT l.name, ', ' ORDER BY l.name) AS lotes
        FROM shipping_lot_items i JOIN shipping_lots l ON l.id = i.lot_id GROUP BY i.product_id`);
      lr.rows.forEach(x => { lotNamesByProduct[x.product_id] = x.lotes; });
    } catch { /* aún no existe la tabla de lotes */ }

    const photoUrl = (photos) => {
      for (const v of Object.values(photos || {})) {
        if (v && typeof v === 'object' && v.url) return v.url;
      }
      return '';
    };

    const rows = productsRes.rows.map(p => {
      const purchasePrice = parseFloat(p.purchase_price_mxn) || 0;
      const isIntercompany = p.intercompany_price_eur != null;
      const rate = settings.exchangeRate;

      // Desglose del costo (misma lógica que Pricing → General):
      //  - Intercompany: el costo es el precio intercompany, sin sumar nada más.
      //  - Proveedor con envío de lote: compra + marketing% + otros% + envío fijo.
      //  - Proveedor sin lote: compra + embalaje/envío% (estimado) + marketing% + otros%.
      const shipUnitEur = shipMap.get(p.id);
      const hasLotShipping = !isIntercompany && shipUnitEur != null;
      const pctEnvio = !isIntercompany && !hasLotShipping ? settings.packagingShippingPct : 0;
      const pctMkt = isIntercompany ? 0 : settings.marketingPct;
      const pctOtros = isIntercompany ? 0 : settings.otherCostsPct;
      const embalajeEnvioEstMxn = purchasePrice * pctEnvio / 100;
      const marketingMxn = purchasePrice * pctMkt / 100;
      const otrosMxn = purchasePrice * pctOtros / 100;
      const envioLoteMxn = hasLotShipping ? shipUnitEur * rate : 0;
      const costoMxn = isIntercompany
        ? parseFloat(p.intercompany_price_eur) * rate
        : purchasePrice + embalajeEnvioEstMxn + marketingMxn + otrosMxn + envioLoteMxn;
      const costoEur = rate > 0 ? costoMxn / rate : null;
      const precioCalcMxn = costoMxn * settings.generalMultiplier;
      const precioCalcEur = rate > 0 ? precioCalcMxn / rate : null;
      // Precio base final: el "Precio EUR asignado" si existe; si no, el calculado
      const asignadoEur = p.sale_price_eur != null ? parseFloat(p.sale_price_eur) : null;
      const precioBaseEur = asignadoEur != null ? asignadoEur : precioCalcEur;
      const precioBaseMxn = precioBaseEur != null ? precioBaseEur * rate : null;
      const origenCosto = isIntercompany ? 'Intercompany'
        : hasLotShipping ? 'Proveedor + envío de lote' : 'Proveedor + % envío estimado';
      const stock = stockByProduct[p.id] || {};
      const bodegaMx = stock['Bodega MX (CDMX)'] || 0;
      const enTransito = stock['En tránsito (MX→DE)'] || 0;
      const bodegaMunich = stock['Bodega Munich'] || 0;
      const baja = stock['Baja'] || 0; // piezas dadas de baja (dañadas / que no sirven)

      return {
        sku: p.sku,
        descripcion: p.name_es,
        descripcion_de: p.name_de || '',
        proveedor: p.supplier_name || '',
        ordenes_compra: p.ordenes_compra || '',
        recibo_simplificado: p.recibo_info || '',
        referencia_traslado: p.referencias_traslado || '',
        cantidad_enviada: parseFloat(p.cantidad_trasladada) || 0,
        detalle_envios: p.detalle_traslados || '',
        precio_compra_mxn: purchasePrice,
        bodega_mx: bodegaMx,
        en_transito: enTransito,
        bodega_munich: bodegaMunich,
        baja,
        total_bodega: round2(bodegaMx + enTransito + bodegaMunich),
        propietario: isIntercompany ? 'Luumil Alemania' : 'Luumil México',
        precio_intercompany_eur: isIntercompany ? round2(parseFloat(p.intercompany_price_eur)) : '',
        precio_intercompany_mxn: isIntercompany ? round2(parseFloat(p.intercompany_price_eur) * settings.exchangeRate) : '',
        // — Desglose de costos —
        pct_embalaje_envio_estimado: isIntercompany ? '' : pctEnvio,
        embalaje_envio_estimado_mxn: round2(embalajeEnvioEstMxn),
        envio_lote_eur: hasLotShipping ? round2(shipUnitEur) : '',
        envio_lote_mxn: hasLotShipping ? round2(envioLoteMxn) : '',
        lote_envio: lotNamesByProduct[p.id] || '',
        pct_marketing: isIntercompany ? '' : pctMkt,
        marketing_mxn: round2(marketingMxn),
        pct_otros_costos: isIntercompany ? '' : pctOtros,
        otros_costos_mxn: round2(otrosMxn),
        costo_total_mxn: round2(costoMxn),
        costo_total_eur: costoEur != null ? round2(costoEur) : '',
        multiplicador_general: settings.generalMultiplier,
        precio_calculado_mxn: round2(precioCalcMxn),
        precio_calculado_eur: precioCalcEur != null ? round2(precioCalcEur) : '',
        precio_asignado_eur: asignadoEur != null ? round2(asignadoEur) : '',
        precio_base_mxn: precioBaseMxn != null ? round2(precioBaseMxn) : '',
        precio_base_eur: precioBaseEur != null ? round2(precioBaseEur) : '',
        origen_costo: origenCosto,
        precio_ferias: (fairPriceByProduct[p.id] || []).join(' | '),
        iva_aplicable_pct: vatByProduct[p.id] ?? '',
        precio_calculado_con_iva_ferias: (fairPublicCalcByProduct[p.id] || []).join(' | '),
        precio_final_ferias: (fairFinalByProduct[p.id] || []).join(' | '),
        propuesta_ferias: (fairProposalByProduct[p.id] || []).join(' | '),
        alto_cm: p.height_cm ?? '',
        ancho_cm: p.width_cm ?? '',
        profundidad_cm: p.depth_cm ?? '',
        peso_g: p.weight_g ?? '',
        foto_url: photoUrl(p.photos),
        ciudad_proveedor: p.supplier_city || '',
        estado_proveedor: p.supplier_state || '',
        contacto_proveedor: p.supplier_contact || '',
        whatsapp_proveedor: p.supplier_whatsapp || '',
        email_proveedor: p.supplier_email || '',
        categorias: (p.categories || []).join(';'),
        materiales: (p.materials || []).join(';'),
        hs_code: p.hs_code || '',
        estado_regulatorio: p.regulatory_status || '',
      };
    }).filter(r => r.total_bodega > 0 || r.baja > 0); // con inventario disponible (>0 piezas) o con piezas dadas de baja

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to build product catalog report' });
  }
});

export default router;
