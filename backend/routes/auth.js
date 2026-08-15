const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { requireAuth, JWT_SECRET } = require('../middleware/auth');

const router = express.Router();

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis.' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Identifiants incorrects.' });
  }

  const token = jwt.sign(
    { id: user.id, nom: user.nom, role: user.role, email: user.email },
    JWT_SECRET,
    { expiresIn: '8h' }
  );

  db.prepare(`INSERT INTO audit_log (user_id,user_nom,action,entity) VALUES (?,?,?,?)`)
    .run(user.id, user.nom, 'Connexion', 'auth');

  res.json({
    token,
    user: { id: user.id, nom: user.nom, email: user.email, role: user.role, service: user.service },
  });
});

router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id,nom,email,role,service FROM users WHERE id=?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  res.json({ user });
});

module.exports = router;
