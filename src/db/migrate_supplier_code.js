import { query } from './pool.js';

async function migrate() {
  console.log('Adding supplier_code field...');

  // Agregar columna
  await query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS supplier_code VARCHAR(20) UNIQUE`);

  // Insertar secuencia si no existe
  await query(`INSERT INTO sequences (prefix, current_value) VALUES ('PROV', 0) ON CONFLICT (prefix) DO NOTHING`);

  // Asignar códigos a proveedores existentes que no tienen (orden por id)
  const suppliers = await query(`SELECT id FROM suppliers WHERE supplier_code IS NULL ORDER BY id`);
  for (const s of suppliers.rows) {
    const seq = await query(`UPDATE sequences SET current_value=current_value+1 WHERE prefix='PROV' RETURNING current_value`);
    const code = 'PROV-' + String(seq.rows[0].current_value).padStart(4, '0');
    await query(`UPDATE suppliers SET supplier_code=$1 WHERE id=$2`, [code, s.id]);
  }

  console.log(`✅ Done — ${suppliers.rows.length} suppliers assigned codes`);
  process.exit(0);
}

migrate().catch(err => { console.error(err); process.exit(1); });
