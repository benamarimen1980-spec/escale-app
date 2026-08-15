const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'escale-dev-secret-change-me';

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentification requise.' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session invalide ou expirée.' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentification requise.' });
    if (req.user.role === 'admin' || roles.includes(req.user.role)) return next();
    return res.status(403).json({ error: `Accès refusé — rôle requis : ${roles.join(', ')}.` });
  };
}

module.exports = { requireAuth, requireRole, JWT_SECRET };
