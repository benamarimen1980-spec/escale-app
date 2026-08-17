const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { requireAuth, JWT_SECRET } = require('../middleware/auth');

const router = express.Router();

const SELF_SIGNUP_ROLES = ['achats', 'logistique', 'achats_logistique', 'finance'];

router.post('/register', (req, res) => {
  const { nom, email, password, role, service } = req.body || {};
  if (!nom || !email || !password || !role) {
    return res.status(400).json({ error: 'Nom, email, mot de passe et rôle souhaité sont requis.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères.' });
  }
  if (!SELF_SIGNUP_ROLES.includes(role)) {
    return res.status(400).json({ error: 'Rôle invalide.' });
  }
  const normalizedEmail = email.toLowerCase().trim();
  const exists = db.prepare('SELECT id FROM users WHERE email=?').get(normalizedEmail);
  if (exists) return res.status(409).json({ error: 'Un compte existe déjà avec cet email.' });

  const info = db.prepare('INSERT INTO users (nom,email,password_hash,role,service,status) VALUES (?,?,?,?,?,?)')
    .run(nom, normalizedEmail, bcrypt.hashSync(password, 10), role, service || null, 'pending');

  db.prepare(`INSERT INTO audit_log (user_id,user_nom,action,entity,entity_id) VALUES (?,?,?,?,?)`)
    .run(info.lastInsertRowid, nom, 'Demande de création de compte', 'user', info.lastInsertRowid);

  res.status(201).json({ message: 'Votre demande a été envoyée. Un administrateur doit valider votre compte avant que vous puissiez vous connecter.' });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis.' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Identifiants incorrects.' });
  }
  if (user.status === 'pending') {
    return res.status(403).json({ error: 'Votre compte est en attente de validation par un administrateur.' });
  }
  if (user.status === 'rejected') {
    return res.status(403).json({ error: 'Votre demande de compte a été refusée. Contactez un administrateur.' });
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
