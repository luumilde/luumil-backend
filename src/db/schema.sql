-- Luumil Database Schema — Stage 1
-- Suppliers, Products, Purchase Orders, Reception & Inspection

CREATE TABLE IF NOT EXISTS suppliers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  technique TEXT,
  state TEXT,
  municipality TEXT,
  street TEXT,
  city TEXT,
  zip_code TEXT,
  categories TEXT[] DEFAULT '{}',
  contact_name TEXT,
  whatsapp TEXT,
  email TEXT,
  delivery_time TEXT,
  marketing_story TEXT,
  bank_name TEXT,
  account_holder TEXT,
  clabe TEXT,
  notes TEXT,
  photos JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  sku TEXT UNIQUE NOT NULL,
  supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  name_es TEXT NOT NULL,
  name_de TEXT,
  categories TEXT[] DEFAULT '{}',
  materials TEXT[] DEFAULT '{}',
  height_cm NUMERIC,
  width_cm NUMERIC,
  depth_cm NUMERIC,
  weight_g NUMERIC,
  fragile BOOLEAN DEFAULT false,
  purchase_price_mxn NUMERIC,
  last_paid_price_mxn NUMERIC,
  sale_price_eur NUMERIC,
  hs_code TEXT,
  regulatory_status TEXT DEFAULT 'green', -- green / amber / red
  requires_cites BOOLEAN DEFAULT false,
  requires_phytosanitary BOOLEAN DEFAULT false,
  customs_description_de TEXT,
  notes TEXT,
  photos JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id SERIAL PRIMARY KEY,
  folio TEXT UNIQUE NOT NULL,
  supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  order_date DATE,
  delivery_date DATE,
  delivery_place TEXT DEFAULT 'Bodega MX (CDMX)',
  status TEXT DEFAULT 'draft', -- draft, confirmed, production, ready, receiving, completed, paid, cancelled
  iva_pct NUMERIC DEFAULT 16,
  advance_pct NUMERIC DEFAULT 50,
  subtotal NUMERIC DEFAULT 0,
  iva_amount NUMERIC DEFAULT 0,
  total NUMERIC DEFAULT 0,
  cancellation_resolution TEXT,
  cancellation_reason TEXT,
  instructions TEXT,
  internal_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id SERIAL PRIMARY KEY,
  purchase_order_id INTEGER REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  variant TEXT,
  quantity_ordered NUMERIC NOT NULL DEFAULT 0,
  quantity_received NUMERIC DEFAULT 0,
  unit_price_mxn NUMERIC NOT NULL DEFAULT 0,
  line_status TEXT DEFAULT 'pending', -- pending, partial, complete, cancelled
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  purchase_order_id INTEGER REFERENCES purchase_orders(id) ON DELETE CASCADE,
  concept TEXT DEFAULT 'Anticipo', -- Anticipo, Pago parcial, Saldo final, Otro
  amount_mxn NUMERIC NOT NULL,
  payment_date DATE,
  reference TEXT,
  is_paid BOOLEAN DEFAULT false,
  attachment_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fiscal_documents (
  id SERIAL PRIMARY KEY,
  purchase_order_id INTEGER REFERENCES purchase_orders(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL, -- cfdi, recibo
  status TEXT DEFAULT 'vigente', -- vigente, cancelado
  folio TEXT,
  uuid TEXT,
  rfc TEXT,
  doc_date DATE,
  amount_mxn NUMERIC,
  subtotal_mxn NUMERIC,
  iva_mxn NUMERIC,
  concept TEXT,
  replaces_doc_id INTEGER REFERENCES fiscal_documents(id),
  attachment_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS receptions (
  id SERIAL PRIMARY KEY,
  folio TEXT UNIQUE NOT NULL,
  purchase_order_id INTEGER REFERENCES purchase_orders(id) ON DELETE CASCADE,
  reception_date DATE,
  received_by TEXT,
  reception_place TEXT DEFAULT 'Bodega MX (CDMX)',
  general_observations TEXT,
  pending_actions TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS reception_lines (
  id SERIAL PRIMARY KEY,
  reception_id INTEGER REFERENCES receptions(id) ON DELETE CASCADE,
  purchase_order_line_id INTEGER REFERENCES purchase_order_lines(id) ON DELETE CASCADE,
  quantity_received NUMERIC NOT NULL DEFAULT 0,
  quality TEXT DEFAULT 'ok', -- ok, observations, rejected
  quality_notes TEXT,
  photos JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Sequence helpers for human-friendly folios
CREATE TABLE IF NOT EXISTS sequences (
  prefix TEXT PRIMARY KEY,
  current_value INTEGER DEFAULT 0
);

INSERT INTO sequences (prefix, current_value) VALUES
  ('LUM', 0), ('PC', 0), ('REC', 0)
ON CONFLICT (prefix) DO NOTHING;
