const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../db');
const { requireAuth, JWT_SECRET } = require('../middleware/auth');

const router = express.Router();

const SELF_SIGNUP_ROLES = ['achats', 'logistique', 'achats_logistique', 'finance'];

router.post('/register', async (req, res) => {
  try {
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
    const { rows: exists } = await query('SELECT id FROM users WHERE email=$1', [normalizedEmail]);
    if (exists.length) return res.status(409).json({ error: 'Un compte existe déjà avec cet email.' });

    const { rows } = await query(
      'INSERT INTO users (nom,email,password_hash,role,service,status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [nom, normalizedEmail, bcrypt.hashSync(password, 10), role, service || null, 'pending']
    );

    await query('INSERT INTO audit_log (user_id,user_nom,action,entity,entity_id) VALUES ($1,$2,$3,$4,$5)',
      [rows[0].id, nom, 'Demande de création de compte', 'user', rows[0].id]);

    res.status(201).json({ message: 'Votre demande a été envoyée. Un administrateur doit valider votre compte avant que vous puissiez vous connecter.' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur serveur.' }); }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis.' });

    const { rows } = await query('SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    const user = rows[0];
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

    await query('INSERT INTO audit_log (user_id,user_nom,action,entity) VALUES ($1,$2,$3,$4)',
      [user.id, user.nom, 'Connexion', 'auth']);

    res.json({
      token,
      user: { id: user.id, nom: user.nom, email: user.email, role: user.role, service: user.service },
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur serveur.' }); }
});

router.get('/me', requireAuth, async (req, res) => {
  const { rows } = await query('SELECT id,nom,email,role,service FROM users WHERE id=$1', [req.user.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  res.json({ user: rows[0] });
});

module.exports = router;
