const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', requireRole('admin'), (req, res) => {
  const users = db.prepare('SELECT id,nom,email,role,service FROM users ORDER BY id').all();
  res.json({ users });
});

router.post('/', requireRole('admin'), (req, res) => {
  const { nom, email, password, role, service } = req.body || {};
  if (!nom || !email || !password || !role) return res.status(400).json({ error: 'Champs requis manquants.' });
  if (!['admin', 'achats', 'logistique', 'finance'].includes(role)) return res.status(400).json({ error: 'Rôle invalide.' });
  const exists = db.prepare('SELECT id FROM users WHERE email=?').get(email.toLowerCase().trim());
  if (exists) return res.status(409).json({ error: 'Cet email existe déjà.' });

  const info = db.prepare('INSERT INTO users (nom,email,password_hash,role,service) VALUES (?,?,?,?,?)')
    .run(nom, email.toLowerCase().trim(), bcrypt.hashSync(password, 10), role, service || null);

  db.prepare(`INSERT INTO audit_log (user_id,user_nom,action,entity,entity_id) VALUES (?,?,?,?,?)`)
    .run(req.user.id, req.user.nom, 'Création utilisateur', 'user', info.lastInsertRowid);

  res.status(201).json({ user: { id: info.lastInsertRowid, nom, email, role, service } });
});

router.get('/audit-log', requireRole('admin'), (req, res) => {
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 100').all();
  res.json({ log: rows });
});

module.exports = router;
