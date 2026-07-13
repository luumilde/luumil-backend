import express from 'express';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import { Readable } from 'stream';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

// Configurar Cloudinary desde variables de entorno
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Multer en memoria
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('File type not allowed'));
  },
});

// Sube buffer a Cloudinary usando stream
function uploadToCloudinary(buffer, folder) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: folder || 'luumil',
        resource_type: 'image',
        format: 'jpg',           // forzar conversión a JPG
        transformation: [{ quality: 'auto' }],
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );
    Readable.from(buffer).pipe(stream);
  });
}

// POST /api/uploads — sube a Cloudinary
router.post('/', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file received' });

    const result = await uploadToCloudinary(req.file.buffer, 'luumil');

    res.json({
      url: result.secure_url,
      filename: result.public_id,
      size: result.bytes,
    });
  } catch (err) {
    console.error('Upload error:', err.message);
    res.status(500).json({ error: 'Upload failed: ' + err.message });
  }
});

// DELETE /api/uploads/files/:publicId — borra de Cloudinary
router.delete('/files/:publicId', requireAuth, async (req, res) => {
  try {
    // El public_id puede tener slash (luumil/filename), viene codificado
    const publicId = decodeURIComponent(req.params.publicId);
    await cloudinary.uploader.destroy(publicId);
    res.status(204).end();
  } catch (err) {
    console.error('Delete error:', err.message);
    res.status(204).end();
  }
});

// GET /api/uploads/files/:publicId — redirige a Cloudinary
router.get('/files/:publicId', (req, res) => {
  const publicId = decodeURIComponent(req.params.publicId);
  const url = cloudinary.url(publicId);
  res.redirect(url);
});

export default router;
