const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL non définie. Ajoutez la variable d\'environnement DATABASE_URL (chaîne de connexion Neon/PostgreSQL) avant de démarrer.');
  process.exit(1);
}

const useSSL = !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
});

async function query(text, params) {
  return pool.query(text, params);
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  nom TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','achats','logistique','achats_logistique','finance')),
  service TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('pending','active','rejected'))
);

CREATE TABLE IF NOT EXISTS dossiers (
  id SERIAL PRIMARY KEY,
  ref TEXT UNIQUE NOT NULL,
  fournisseur TEXT NOT NULL,
  pays TEXT,
  incoterm TEXT NOT NULL,
  devise TEXT NOT NULL,
  devise_frais TEXT DEFAULT 'TND',
  taux_prev DOUBLE PRECISION,
  taux_reel DOUBLE PRECISION,
  statut TEXT NOT NULL DEFAULT 'preparation',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);

CREATE TABLE IF NOT EXISTS articles (
  id SERIAL PRIMARY KEY,
  dossier_id INTEGER NOT NULL REFERENCES dossiers(id) ON DELETE CASCADE,
  designation TEXT NOT NULL,
  qte DOUBLE PRECISION NOT NULL,
  pu DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS transport (
  dossier_id INTEGER PRIMARY KEY REFERENCES dossiers(id) ON DELETE CASCADE,
  mode TEXT,
  bl TEXT,
  navire TEXT,
  conteneurs TEXT DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS milestones (
  dossier_id INTEGER PRIMARY KEY REFERENCES dossiers(id) ON DELETE CASCADE,
  etd TEXT, atd TEXT,
  eta_orig TEXT, eta TEXT, ata TEXT,
  dedouanement_prev TEXT, dedouanement_reel TEXT,
  livraison_prev TEXT, livraison_reel TEXT
);

CREATE TABLE IF NOT EXISTS frais (
  id SERIAL PRIMARY KEY,
  dossier_id INTEGER NOT NULL REFERENCES dossiers(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  estime DOUBLE PRECISION DEFAULT 0,
  reel DOUBLE PRECISION,
  paye BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS paiements (
  id SERIAL PRIMARY KEY,
  dossier_id INTEGER NOT NULL REFERENCES dossiers(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  pct DOUBLE PRECISION NOT NULL,
  base TEXT NOT NULL,
  delai INTEGER NOT NULL DEFAULT 0,
  date_base TEXT,
  paye BOOLEAN NOT NULL DEFAULT FALSE,
  date_paiement TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  user_nom TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id INTEGER,
  details TEXT,
  "timestamp" TEXT DEFAULT (to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);
`;

// Ajoute les colonnes de suivi "payé" aux bases déjà déployées, sans toucher aux données existantes.
const MIGRATIONS_SQL = `
ALTER TABLE frais ADD COLUMN IF NOT EXISTS paye BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE paiements ADD COLUMN IF NOT EXISTS paye BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE paiements ADD COLUMN IF NOT EXISTS date_paiement TEXT;
`;

async function init() {
  await pool.query(SCHEMA_SQL);
  await pool.query(MIGRATIONS_SQL);

  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM users');
  if (rows[0].n === 0) {
    const adminEmail = (process.env.ADMIN_EMAIL || 'admin@escale.tn').toLowerCase().trim();
    const adminPassword = process.env.ADMIN_PASSWORD || 'ChangeMoi123!';
    const adminNom = process.env.ADMIN_NOM || 'Administrateur';

    await pool.query(
      `INSERT INTO users (nom,email,password_hash,role,service,status) VALUES ($1,$2,$3,$4,$5,$6)`,
      [adminNom, adminEmail, bcrypt.hashSync(adminPassword, 10), 'admin', 'Direction Générale', 'active']
    );

    console.log(`Base vide détectée — compte admin initial créé : ${adminEmail}`);
    if (!process.env.ADMIN_PASSWORD) {
      console.log('⚠️  ADMIN_PASSWORD non défini — mot de passe par défaut "ChangeMoi123!" utilisé. Définissez ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_NOM dans les variables d\'environnement avant le prochain déploiement.');
    }
  }
}

module.exports = { pool, query, init };
