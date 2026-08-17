const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', requireRole('admin'), (req, res) => {
  const users = db.prepare('SELECT id,nom,email,role,service,status FROM users ORDER BY (status=\'pending\') DESC, id').all();
  res.json({ users });
});

const VALID_ROLES = ['admin', 'achats', 'logistique', 'achats_logistique', 'finance'];
const VALID_STATUSES = ['pending', 'active', 'rejected'];

router.post('/', requireRole('admin'), (req, res) => {
  const { nom, email, password, role, service } = req.body || {};
  if (!nom || !email || !password || !role) return res.status(400).json({ error: 'Champs requis manquants.' });
  if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Rôle invalide.' });
  const exists = db.prepare('SELECT id FROM users WHERE email=?').get(email.toLowerCase().trim());
  if (exists) return res.status(409).json({ error: 'Cet email existe déjà.' });

  const info = db.prepare('INSERT INTO users (nom,email,password_hash,role,service,status) VALUES (?,?,?,?,?,?)')
    .run(nom, email.toLowerCase().trim(), bcrypt.hashSync(password, 10), role, service || null, 'active');

  db.prepare(`INSERT INTO audit_log (user_id,user_nom,action,entity,entity_id) VALUES (?,?,?,?,?)`)
    .run(req.user.id, req.user.nom, 'Création utilisateur', 'user', info.lastInsertRowid);

  res.status(201).json({ user: { id: info.lastInsertRowid, nom, email, role, service, status: 'active' } });
});

router.put('/:id', requireRole('admin'), (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  const { role, service, nom, status } = req.body || {};
  if (role && !VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Rôle invalide.' });
  if (status && !VALID_STATUSES.includes(status)) return res.status(400).json({ error: 'Statut invalide.' });

  db.prepare('UPDATE users SET role=?, service=?, nom=?, status=? WHERE id=?').run(
    role ?? target.role, service !== undefined ? service : target.service, nom ?? target.nom,
    status ?? target.status, target.id
  );

  db.prepare(`INSERT INTO audit_log (user_id,user_nom,action,entity,entity_id,details) VALUES (?,?,?,?,?,?)`)
    .run(req.user.id, req.user.nom, 'Modification utilisateur', 'user', target.id, `rôle: ${role ?? target.role}, statut: ${status ?? target.status}`);

  const updated = db.prepare('SELECT id,nom,email,role,service,status FROM users WHERE id=?').get(target.id);
  res.json({ user: updated });
});

router.post('/:id/approve', requireRole('admin'), (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  db.prepare('UPDATE users SET status=? WHERE id=?').run('active', target.id);
  db.prepare(`INSERT INTO audit_log (user_id,user_nom,action,entity,entity_id) VALUES (?,?,?,?,?)`)
    .run(req.user.id, req.user.nom, 'Approbation compte', 'user', target.id);
  const updated = db.prepare('SELECT id,nom,email,role,service,status FROM users WHERE id=?').get(target.id);
  res.json({ user: updated });
});

router.post('/:id/reject', requireRole('admin'), (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  db.prepare('UPDATE users SET status=? WHERE id=?').run('rejected', target.id);
  db.prepare(`INSERT INTO audit_log (user_id,user_nom,action,entity,entity_id) VALUES (?,?,?,?,?)`)
    .run(req.user.id, req.user.nom, 'Refus compte', 'user', target.id);
  const updated = db.prepare('SELECT id,nom,email,role,service,status FROM users WHERE id=?').get(target.id);
  res.json({ user: updated });
});

router.get('/audit-log', requireRole('admin'), (req, res) => {
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 100').all();
  res.json({ log: rows });
});

module.exports = router;
