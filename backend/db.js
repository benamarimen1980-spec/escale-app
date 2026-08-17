const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'escale.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function tableExists(name) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

const FRESH = !tableExists('users');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nom TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','achats','logistique','achats_logistique','finance')),
  service TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('pending','active','rejected'))
);

CREATE TABLE IF NOT EXISTS dossiers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT UNIQUE NOT NULL,
  fournisseur TEXT NOT NULL,
  pays TEXT,
  incoterm TEXT NOT NULL,
  devise TEXT NOT NULL,
  devise_frais TEXT DEFAULT 'TND',
  taux_prev REAL,
  taux_reel REAL,
  statut TEXT NOT NULL DEFAULT 'preparation',
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dossier_id INTEGER NOT NULL,
  designation TEXT NOT NULL,
  qte REAL NOT NULL,
  pu REAL NOT NULL,
  FOREIGN KEY(dossier_id) REFERENCES dossiers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS transport (
  dossier_id INTEGER PRIMARY KEY,
  mode TEXT,
  bl TEXT,
  navire TEXT,
  conteneurs TEXT DEFAULT '[]',
  FOREIGN KEY(dossier_id) REFERENCES dossiers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS milestones (
  dossier_id INTEGER PRIMARY KEY,
  etd TEXT, atd TEXT,
  eta_orig TEXT, eta TEXT, ata TEXT,
  dedouanement_prev TEXT, dedouanement_reel TEXT,
  livraison_prev TEXT, livraison_reel TEXT,
  FOREIGN KEY(dossier_id) REFERENCES dossiers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS frais (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dossier_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  estime REAL DEFAULT 0,
  reel REAL,
  FOREIGN KEY(dossier_id) REFERENCES dossiers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS paiements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dossier_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  pct REAL NOT NULL,
  base TEXT NOT NULL,
  delai INTEGER NOT NULL DEFAULT 0,
  date_base TEXT,
  FOREIGN KEY(dossier_id) REFERENCES dossiers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  user_nom TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id INTEGER,
  details TEXT,
  timestamp TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(user_id) REFERENCES users(id)
);
`);

if (FRESH) {
  const adminEmail = (process.env.ADMIN_EMAIL || 'admin@escale.tn').toLowerCase().trim();
  const adminPassword = process.env.ADMIN_PASSWORD || 'ChangeMoi123!';
  const adminNom = process.env.ADMIN_NOM || 'Administrateur';

  db.prepare(`INSERT INTO users (nom,email,password_hash,role,service,status) VALUES (?,?,?,?,?,?)`)
    .run(adminNom, adminEmail, bcrypt.hashSync(adminPassword, 10), 'admin', 'Direction Générale', 'active');

  console.log(`Base vide détectée — compte admin initial créé : ${adminEmail}`);
  if (!process.env.ADMIN_PASSWORD) {
    console.log('⚠️  ADMIN_PASSWORD non défini — mot de passe par défaut "ChangeMoi123!" utilisé. Définissez ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_NOM dans les variables d\'environnement avant le prochain déploiement.');
  }
}

module.exports = db;
