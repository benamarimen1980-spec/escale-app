const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const VALID_ROLES = ['admin', 'achats', 'logistique', 'achats_logistique', 'finance'];
const VALID_STATUSES = ['pending', 'active', 'rejected'];

router.get('/', requireRole('admin'), async (req, res) => {
  const { rows } = await query(`SELECT id,nom,email,role,service,status FROM users ORDER BY (status='pending') DESC, id`, []);
  res.json({ users: rows });
});

router.post('/', requireRole('admin'), async (req, res) => {
  const { nom, email, password, role, service } = req.body || {};
  if (!nom || !email || !password || !role) return res.status(400).json({ error: 'Champs requis manquants.' });
  if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Rôle invalide.' });
  const normalizedEmail = email.toLowerCase().trim();
  const { rows: exists } = await query('SELECT id FROM users WHERE email=$1', [normalizedEmail]);
  if (exists.length) return res.status(409).json({ error: 'Cet email existe déjà.' });

  const { rows } = await query(
    'INSERT INTO users (nom,email,password_hash,role,service,status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [nom, normalizedEmail, bcrypt.hashSync(password, 10), role, service || null, 'active']
  );

  await query('INSERT INTO audit_log (user_id,user_nom,action,entity,entity_id) VALUES ($1,$2,$3,$4,$5)',
    [req.user.id, req.user.nom, 'Création utilisateur', 'user', rows[0].id]);

  res.status(201).json({ user: { id: rows[0].id, nom, email: normalizedEmail, role, service, status: 'active' } });
});

router.put('/:id', requireRole('admin'), async (req, res) => {
  const { rows } = await query('SELECT * FROM users WHERE id=$1', [req.params.id]);
  const target = rows[0];
  if (!target) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  const { role, service, nom, status } = req.body || {};
  if (role && !VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Rôle invalide.' });
  if (status && !VALID_STATUSES.includes(status)) return res.status(400).json({ error: 'Statut invalide.' });

  await query('UPDATE users SET role=$1, service=$2, nom=$3, status=$4 WHERE id=$5', [
    role ?? target.role, service !== undefined ? service : target.service, nom ?? target.nom,
    status ?? target.status, target.id,
  ]);

  await query('INSERT INTO audit_log (user_id,user_nom,action,entity,entity_id,details) VALUES ($1,$2,$3,$4,$5,$6)',
    [req.user.id, req.user.nom, 'Modification utilisateur', 'user', target.id, `rôle: ${role ?? target.role}, statut: ${status ?? target.status}`]);

  const { rows: updated } = await query('SELECT id,nom,email,role,service,status FROM users WHERE id=$1', [target.id]);
  res.json({ user: updated[0] });
});

router.post('/:id/approve', requireRole('admin'), async (req, res) => {
  const { rows } = await query('SELECT * FROM users WHERE id=$1', [req.params.id]);
  const target = rows[0];
  if (!target) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  await query('UPDATE users SET status=$1 WHERE id=$2', ['active', target.id]);
  await query('INSERT INTO audit_log (user_id,user_nom,action,entity,entity_id) VALUES ($1,$2,$3,$4,$5)',
    [req.user.id, req.user.nom, 'Approbation compte', 'user', target.id]);
  const { rows: updated } = await query('SELECT id,nom,email,role,service,status FROM users WHERE id=$1', [target.id]);
  res.json({ user: updated[0] });
});

router.post('/:id/reject', requireRole('admin'), async (req, res) => {
  const { rows } = await query('SELECT * FROM users WHERE id=$1', [req.params.id]);
  const target = rows[0];
  if (!target) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  await query('UPDATE users SET status=$1 WHERE id=$2', ['rejected', target.id]);
  await query('INSERT INTO audit_log (user_id,user_nom,action,entity,entity_id) VALUES ($1,$2,$3,$4,$5)',
    [req.user.id, req.user.nom, 'Refus compte', 'user', target.id]);
  const { rows: updated } = await query('SELECT id,nom,email,role,service,status FROM users WHERE id=$1', [target.id]);
  res.json({ user: updated[0] });
});

router.get('/audit-log', requireRole('admin'), async (req, res) => {
  const { rows } = await query('SELECT * FROM audit_log ORDER BY id DESC LIMIT 100', []);
  res.json({ log: rows });
});

module.exports = router;
