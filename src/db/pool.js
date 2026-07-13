import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') || process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
  max: 10,                // máximo 10 conexiones simultáneas
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('Unexpected pool error:', err);
});

export async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  if (process.env.DEBUG_SQL) {
    console.log('query', { ms: Date.now()-start, rows: res.rowCount, text: text.slice(0,80) });
  }
  return res;
}

export async function nextFolio(prefix) {
  const res = await query(
    `INSERT INTO sequences (prefix, current_value)
     VALUES ($1, 1)
     ON CONFLICT (prefix) DO UPDATE SET current_value = sequences.current_value + 1
     RETURNING current_value`,
    [prefix]
  );
  const n = res.rows[0].current_value;
  return `${prefix}-${String(n).padStart(4, '0')}`;
}
