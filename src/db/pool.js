import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') || process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
});

export async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  if (process.env.DEBUG_SQL) {
    console.log('query', { text, duration, rows: res.rowCount });
  }
  return res;
}

// Generates next human-friendly folio, e.g. LUM-0001, PC-0001, REC-0001
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
