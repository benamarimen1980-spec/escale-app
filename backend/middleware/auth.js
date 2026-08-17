const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'escale-dev-secret-change-me';

// Groupes de rôles : un utilisateur "achats_logistique" cumule les deux permissions
// (utile quand la même personne gère les deux fonctions).
const ROLE_GROUPS = {
  achats: ['achats', 'achats_logistique'],
  logistique: ['logistique', 'achats_logistique'],
  finance: ['finance'],
};

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
    if (req.user.role === 'admin') return next();
    const allowed = roles.some(r => (ROLE_GROUPS[r] || [r]).includes(req.user.role));
    if (allowed) return next();
    return res.status(403).json({ error: `Accès refusé — rôle requis : ${roles.join(', ')}.` });
  };
}

module.exports = { requireAuth, requireRole, JWT_SECRET, ROLE_GROUPS };
