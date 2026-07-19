import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { requireAuth } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import suppliersRoutes from './routes/suppliers.js';
import productsRoutes from './routes/products.js';
import purchaseOrdersRoutes from './routes/purchaseOrders.js';
import receptionsRoutes from './routes/receptions.js';
import uploadsRoutes from './routes/uploads.js';
import reportsRoutes from './routes/reports.js';

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

// Rutas protegidas
app.use('/api/suppliers', requireAuth, suppliersRoutes);
app.use('/api/products', requireAuth, productsRoutes);
app.use('/api/purchase-orders', requireAuth, purchaseOrdersRoutes);
app.use('/api/receptions', requireAuth, receptionsRoutes);
app.use('/api/reports', requireAuth, reportsRoutes);

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`🌿 Luumil backend running on port ${PORT}`);
});
