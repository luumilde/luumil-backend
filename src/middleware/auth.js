import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'luumil-dev-secret-change-in-production';

export function generateToken(userName) {
  return jwt.sign({ userName }, JWT_SECRET, { expiresIn: '30d' });
}

export function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}
