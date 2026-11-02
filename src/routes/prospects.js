import express from 'express';
import { query } from '../db/pool.js';
import { v2 as cloudinary } from 'cloudinary';

// Prospectos (empresas y personas) capturados en ferias, con consentimiento DSGVO.
// Datos personales: solo accesibles con login; se pueden borrar a solicitud (Art. 17 DSGVO).
const router = express.Router();

let tableReady = null;
const ensureTable = () => {
  if (!tableReady) {
    tableReady = query(`
      CREATE TABLE IF NOT EXISTS prospects (
        id SERIAL PRIMARY KEY,
        person_type TEXT NOT NULL DEFAULT 'company',
        legal_name TEXT,
        trade_name TEXT,
        street TEXT,
        street_number TEXT,
        interior TEXT,
        city TEXT,
        state TEXT,
        zip_code TEXT,
        country TEXT,
        website TEXT,
        instagram TEXT,
        contact_name TEXT,
        contact_position TEXT,
        contact_phone TEXT,
        contact_email TEXT,
        consent_data BOOLEAN NOT NULL DEFAULT false,
        consent_marketing BOOLEAN NOT NULL DEFAULT false,
        consent_text_version TEXT,
        consent_at TIMESTAMPTZ,
        signature_png TEXT,
        paper_form BOOLEAN NOT NULL DEFAULT false,
        paper_form_photo_url TEXT,
        paper_form_photo_id TEXT,
        capture_date DATE,
        capture_place TEXT,
        captured_by TEXT,
        created_at TIMESTAMPTZ DEFAULT now()
      )`)
      .then(() => query(`ALTER TABLE prospects ADD COLUMN IF NOT EXISTS paper_form_photo_id TEXT`))
      .then(() => query(`
        ALTER TABLE prospects
          ADD COLUMN IF NOT EXISTS interest_categories TEXT[] DEFAULT '{}',
          ADD COLUMN IF NOT EXISTS interest_text TEXT,
          ADD COLUMN IF NOT EXISTS interest_skus TEXT[] DEFAULT '{}',
          ADD COLUMN IF NOT EXISTS comments TEXT,
          ADD COLUMN IF NOT EXISTS business_type TEXT,
          ADD COLUMN IF NOT EXISTS priority TEXT,
          ADD COLUMN IF NOT EXISTS follow_up_date DATE`))
      .catch(err => { tableReady = null; throw err; });
  }
  return tableReady;
};

const LIST_COLS = `id, person_type, legal_name, trade_name, street, street_number, interior, city, state, zip_code, country,
  website, instagram, contact_name, contact_position, contact_phone, contact_email, consent_data, consent_marketing,
  consent_text_version, consent_at, paper_form, paper_form_photo_url, capture_date, capture_place, captured_by, created_at,
  interest_categories, interest_text, interest_skus, comments, business_type, priority, follow_up_date,
  (signature_png IS NOT NULL) AS has_signature`;

// GET /api/prospects — lista (sin la firma, que es pesada)
router.get('/', async (req, res) => {
  try {
    await ensureTable();
    const r = await query(`SELECT ${LIST_COLS} FROM prospects ORDER BY created_at DESC`);
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch prospects' });
  }
});

// GET /api/prospects/:id — detalle con firma
router.get('/:id', async (req, res) => {
  try {
    await ensureTable();
    const r = await query(`SELECT ${LIST_COLS}, signature_png FROM prospects WHERE id=$1`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Prospect not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch prospect' });
  }
});

const clean = (v) => (v === undefined || v === null || String(v).trim() === '') ? null : String(v).trim();

// POST /api/prospects — crear (exige consentimiento y firma, o formulario en papel con foto)
router.post('/', async (req, res) => {
  try {
    await ensureTable();
    const b = req.body || {};
    const type = b.personType === 'person' ? 'person' : 'company';
    if (!clean(b.contactName)) return res.status(400).json({ error: 'El nombre del contacto es obligatorio' });
    if (type === 'company' && !clean(b.legalName) && !clean(b.tradeName)) {
      return res.status(400).json({ error: 'Indica razón social o nombre comercial' });
    }
    if (!b.consentData) return res.status(400).json({ error: 'Falta la aceptación del tratamiento de datos (Einwilligung)' });
    const signature = clean(b.signaturePng);
    if (b.paperForm) {
      if (!clean(b.paperFormPhotoUrl)) return res.status(400).json({ error: 'Toma la foto del formulario firmado' });
    } else if (!signature) {
      return res.status(400).json({ error: 'Falta la firma' });
    }
    if (signature && !/^data:image\/png;base64,/.test(signature)) {
      return res.status(400).json({ error: 'Firma inválida' });
    }

    const r = await query(`
      INSERT INTO prospects
        (person_type, legal_name, trade_name, street, street_number, interior, city, state, zip_code, country,
         website, instagram, contact_name, contact_position, contact_phone, contact_email,
         consent_data, consent_marketing, consent_text_version, consent_at,
         signature_png, paper_form, paper_form_photo_url, paper_form_photo_id, capture_date, capture_place, captured_by,
         interest_categories, interest_text, interest_skus, comments, business_type, priority, follow_up_date)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,now(),$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33)
      RETURNING id`, [
      type, clean(b.legalName), clean(b.tradeName), clean(b.street), clean(b.streetNumber), clean(b.interior),
      clean(b.city), clean(b.state), clean(b.zipCode), clean(b.country),
      clean(b.website), clean(b.instagram), clean(b.contactName), clean(b.contactPosition), clean(b.contactPhone), clean(b.contactEmail),
      true, !!b.consentMarketing, clean(b.consentTextVersion),
      b.paperForm ? null : signature, !!b.paperForm, b.paperForm ? clean(b.paperFormPhotoUrl) : null, b.paperForm ? clean(b.paperFormPhotoId) : null,
      clean(b.captureDate) || new Date().toISOString().split('T')[0], clean(b.capturePlace),
      clean(b.capturedBy) || req.user?.userName || null,
      Array.isArray(b.interestCategories) ? b.interestCategories.map(String) : [],
      clean(b.interestText),
      Array.isArray(b.interestSkus) ? b.interestSkus.map(x => String(x).trim().toUpperCase()).filter(Boolean) : [],
      clean(b.comments), clean(b.businessType),
      ['hot', 'warm', 'cold'].includes(b.priority) ? b.priority : null,
      clean(b.followUpDate),
    ]);
    res.status(201).json({ id: r.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save prospect' });
  }
});

// DELETE /api/prospects/:id — derecho de supresión (Art. 17 DSGVO)
router.delete('/:id', async (req, res) => {
  try {
    await ensureTable();
    const r = await query('DELETE FROM prospects WHERE id=$1 RETURNING paper_form_photo_id', [req.params.id]);
    // Borra también la foto del formulario en papel (supresión completa)
    const photoId = r.rows[0]?.paper_form_photo_id;
    if (photoId) await cloudinary.uploader.destroy(photoId).catch(() => {});
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete prospect' });
  }
});

export default router;
