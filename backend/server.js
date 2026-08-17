require('./db'); // initializes & seeds the database on first run
const path = require('path');
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const dossierRoutes = require('./routes/dossiers');
const dashboardRoutes = require('./routes/dashboard');
const userRoutes = require('./routes/users');
const exportRoutes = require('./routes/exports');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'ESCALE API' }));

app.use('/api/auth', authRoutes);
app.use('/api/dossiers', dossierRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/users', userRoutes);
app.use('/api/exports', exportRoutes);

// Sert le frontend statique (le dossier "frontend" est copié à côté du dossier "backend" au déploiement)
const frontendPath = path.join(__dirname, '..', 'frontend');
app.use(express.static(frontendPath));
app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(frontendPath, 'index.html')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Erreur serveur.' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`ESCALE en écoute sur le port ${PORT}`);
});
