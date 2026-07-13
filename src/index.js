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

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '1mb' })); // reducido — fotos ya no van en JSON

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'luumil-backend' }));

// Uploads — sin autenticación para las fotos públicas, con auth para subir
app.use('/api/uploads/files', uploadsRoutes);            // GET público (ver fotos)
app.use('/api/uploads', requireAuth, uploadsRoutes);     // POST/DELETE protegido

// Auth pública
app.use('/api/auth', authRoutes);

// Rutas protegidas
app.use('/api/suppliers', requireAuth, suppliersRoutes);
app.use('/api/products', requireAuth, productsRoutes);
app.use('/api/purchase-orders', requireAuth, purchaseOrdersRoutes);
app.use('/api/receptions', requireAuth, receptionsRoutes);

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`🌿 Luumil backend running on port ${PORT}`);
});
