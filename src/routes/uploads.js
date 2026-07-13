import express from 'express';
import multer from 'multer';
import { Readable } from 'stream';
import { google } from 'googleapis';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

// Credenciales de Google Drive desde variables de entorno
const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

function getDriveClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });
  return google.drive({ version: 'v3', auth });
}

// Multer en memoria — no toca el disco
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg','image/png','image/webp','image/heic','application/pdf'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('File type not allowed'));
  },
});

// POST /api/uploads — sube al Drive y devuelve URL pública
router.post('/', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file received' });

    const drive = getDriveClient();

    // Subir archivo a Drive
    const driveRes = await drive.files.create({
      requestBody: {
        name: `${Date.now()}-${req.file.originalname}`,
        parents: [DRIVE_FOLDER_ID],
      },
      media: {
        mimeType: req.file.mimetype,
        body: Readable.from(req.file.buffer),
      },
      fields: 'id, name',
    });

    const fileId = driveRes.data.id;

    // Hacer el archivo público para que se pueda ver desde la app
    await drive.permissions.create({
      fileId,
      requestBody: { role: 'reader', type: 'anyone' },
    });

    // URL directa de la imagen (funciona cross-origin)
    const url = `https://drive.google.com/uc?export=view&id=${fileId}`;

    res.json({ url, filename: fileId, size: req.file.size });
  } catch (err) {
    console.error('Upload error:', err.message);
    res.status(500).json({ error: 'Upload failed: ' + err.message });
  }
});

// DELETE /api/uploads/files/:fileId — borra de Drive
router.delete('/files/:fileId', requireAuth, async (req, res) => {
  try {
    const drive = getDriveClient();
    await drive.files.delete({ fileId: req.params.fileId });
    res.status(204).end();
  } catch (err) {
    console.error('Delete error:', err.message);
    res.status(204).end(); // Si ya no existe, igual retornamos 204
  }
});

// GET /api/uploads/files/:fileId — redirige a Drive (compatibilidad)
router.get('/files/:fileId', (req, res) => {
  res.redirect(`https://drive.google.com/uc?export=view&id=${req.params.fileId}`);
});

export default router;
