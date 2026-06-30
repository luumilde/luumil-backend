import express from 'express';
import { generateToken } from '../middleware/auth.js';

const router = express.Router();

// Shared access code — set via Railway environment variable
const ACCESS_CODE = process.env.ACCESS_CODE || 'luumil2024';

router.post('/login', (req, res) => {
  const { code, userName } = req.body;

  if (!code || code !== ACCESS_CODE) {
    return res.status(401).json({ error: 'Invalid access code' });
  }
  if (!userName || !userName.trim()) {
    return res.status(400).json({ error: 'Please enter your name' });
  }

  const token = generateToken(userName.trim());
  res.json({ token, userName: userName.trim() });
});

export default router;
