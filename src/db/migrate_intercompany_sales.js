import { query } from './pool.js';

async function migrate() {
  console.log('Running intercompany + sales migration...');

  // Transferencias intercompany: registran, por lote, a qué precio (EUR) Luumil
  // México le "vende" un producto a Luumil Alemania. Es un evento independiente
  // del traslado físico de bodega — una vez que existe al menos una transferencia
  // para un producto, ese producto se considera propiedad de Luumil Alemania y su
  // precio base para Pricing (General y Ferias) pasa a ser el de la transferencia
  // más reciente, en vez del costo calculado desde el proveedor.
  await query(`
    CREATE TABLE IF NOT EXISTS intercompany_transfers (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      price_eur NUMERIC NOT NULL,
      location_id INTEGER REFERENCES inventory_locations(id),
      transfer_date DATE NOT NULL DEFAULT CURRENT_DATE,
      notes TEXT,
      created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `);
  console.log('  ✅ intercompany_transfers');
  await query(`ALTER TABLE intercompany_transfers ADD COLUMN IF NOT EXISTS location_id INTEGER REFERENCES inventory_locations(id)`);
  console.log('  ✅ intercompany_transfers.location_id');

  // Órdenes de venta — módulo independiente de Compras, sirve tanto para ventas
  // en feria como fuera de feria, desde Luumil México o Luumil Alemania.
  await query(`
    CREATE TABLE IF NOT EXISTS sales_orders (
      id SERIAL PRIMARY KEY,
      folio TEXT UNIQUE NOT NULL,
      entity TEXT NOT NULL DEFAULT 'DE',
      fair_id INTEGER REFERENCES fairs(id),
      customer_name TEXT,
      customer_contact TEXT,
      sale_date DATE NOT NULL DEFAULT CURRENT_DATE,
      vat_pct NUMERIC NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'EUR',
      subtotal NUMERIC NOT NULL DEFAULT 0,
      vat_amount NUMERIC NOT NULL DEFAULT 0,
      total NUMERIC NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'completed',
      payment_method TEXT DEFAULT 'cash',
      notes TEXT,
      created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    )
  `);
  console.log('  ✅ sales_orders');

  await query(`
    CREATE TABLE IF NOT EXISTS sales_order_lines (
      id SERIAL PRIMARY KEY,
      sales_order_id INTEGER NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
      product_id INTEGER REFERENCES products(id),
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      unit_price NUMERIC NOT NULL DEFAULT 0,
      line_total NUMERIC NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `);
  console.log('  ✅ sales_order_lines');

  console.log('✅ Done');
  process.exit(0);
}

migrate().catch(err => { console.error(err); process.exit(1); });
