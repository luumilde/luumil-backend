import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { requireAuth } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import suppliersRoutes from './routes/suppliers.js';
import productsRoutes from './routes/products.js';
import purchaseOrdersRoutes from './routes/purchaseOrders.js';
import receptionsRoutes from './routes/receptions.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Health check (no auth needed) — useful for Railway
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'luumil-backend' }));

// Public routes
app.use('/api/auth', authRoutes);

// Protected routes — require valid token from shared-code login
app.use('/api/suppliers', requireAuth, suppliersRoutes);
app.use('/api/products', requireAuth, productsRoutes);
app.use('/api/purchase-orders', requireAuth, purchaseOrdersRoutes);
app.use('/api/receptions', requireAuth, receptionsRoutes);

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`🌿 Luumil backend running on port ${PORT}`);
});
