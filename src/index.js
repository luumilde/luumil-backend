import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { requireAuth } from './middleware/auth.js';
import { query } from './db/pool.js';
import authRoutes from './routes/auth.js';
import suppliersRoutes from './routes/suppliers.js';
import productsRoutes from './routes/products.js';
import purchaseOrdersRoutes from './routes/purchaseOrders.js';
import receptionsRoutes from './routes/receptions.js';
import uploadsRoutes from './routes/uploads.js';
import reportsRoutes from './routes/reports.js';
import preordersRoutes from './routes/preorders.js';
import inventoryRoutes from './routes/inventory.js';
import pricingRoutes from './routes/pricing.js';
import fairsRoutes from './routes/fairs.js';
import intercompanyRoutes from './routes/intercompany.js';
import salesRoutes from './routes/sales.js';
import prospectsRoutes from './routes/prospects.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*', exposedHeaders: ['Content-Type', 'Content-Length'] }));
app.use(express.json({ limit: '1mb' }));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'luumil-backend' }));

// Uploads: GET /files/:name es público, POST y DELETE requieren auth
app.use('/api/uploads', uploadsRoutes);

// Auth pública
app.use('/api/auth', authRoutes);

// Pública (sin login): lista de videos de talleres. Solo expone nombre, técnica,
// región y enlace del video — nada de contacto, datos bancarios ni costos.
app.get('/api/public/videos', async (req, res) => {
  try {
    const r = await query(`
      SELECT id, name, technique, state, municipality, video_url
      FROM suppliers
      WHERE video_url IS NOT NULL AND TRIM(video_url) <> ''
      ORDER BY name`);
    res.json(r.rows.map(s => ({
      id: s.id, name: s.name, technique: s.technique,
      region: [s.municipality, s.state].filter(x => x && x.toLowerCase() !== 'other').join(', '),
      videoUrl: s.video_url.trim(),
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch videos' });
  }
});

// Rutas protegidas
app.use('/api/suppliers', requireAuth, suppliersRoutes);
app.use('/api/products', requireAuth, productsRoutes);
app.use('/api/purchase-orders', requireAuth, purchaseOrdersRoutes);
app.use('/api/receptions', requireAuth, receptionsRoutes);
app.use('/api/reports', requireAuth, reportsRoutes);
app.use('/api/preorders', requireAuth, preordersRoutes);
app.use('/api/inventory', requireAuth, inventoryRoutes);
app.use('/api/pricing', requireAuth, pricingRoutes);
app.use('/api/fairs', requireAuth, fairsRoutes);
app.use('/api/intercompany', requireAuth, intercompanyRoutes);
app.use('/api/sales', requireAuth, salesRoutes);
app.use('/api/prospects', requireAuth, prospectsRoutes);

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`🌿 Luumil backend running on port ${PORT}`);
});
