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
  role TEXT NOT NULL CHECK(role IN ('admin','achats','logistique','finance')),
  service TEXT
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
  console.log('Base vide détectée — insertion des données de démonstration...');

  const insertUser = db.prepare(`INSERT INTO users (nom,email,password_hash,role,service) VALUES (?,?,?,?,?)`);
  const demoUsers = [
    ['S. Bouazizi', 'admin@escale.tn', 'admin', 'Direction Générale'],
    ['M. Trabelsi', 'achats@escale.tn', 'achats', 'Achats & Approvisionnement'],
    ['H. Cherni', 'logistique@escale.tn', 'logistique', 'Logistique & Transit'],
    ['N. Jendoubi', 'finance@escale.tn', 'finance', 'Comptabilité & Finance'],
  ];
  for (const [nom, email, role, service] of demoUsers) {
    insertUser.run(nom, email, bcrypt.hashSync('demo1234', 10), role, service);
  }

  const insertDossier = db.prepare(`
    INSERT INTO dossiers (ref,fournisseur,pays,incoterm,devise,devise_frais,taux_prev,taux_reel,statut,created_by)
    VALUES (@ref,@fournisseur,@pays,@incoterm,@devise,@devise_frais,@taux_prev,@taux_reel,@statut,@created_by)
  `);
  const insertArticle = db.prepare(`INSERT INTO articles (dossier_id,designation,qte,pu) VALUES (?,?,?,?)`);
  const insertTransport = db.prepare(`INSERT INTO transport (dossier_id,mode,bl,navire,conteneurs) VALUES (?,?,?,?,?)`);
  const insertMilestones = db.prepare(`
    INSERT INTO milestones (dossier_id,etd,atd,eta_orig,eta,ata,dedouanement_prev,dedouanement_reel,livraison_prev,livraison_reel)
    VALUES (@dossier_id,@etd,@atd,@eta_orig,@eta,@ata,@dedouanement_prev,@dedouanement_reel,@livraison_prev,@livraison_reel)
  `);
  const insertFrais = db.prepare(`INSERT INTO frais (dossier_id,type,estime,reel) VALUES (?,?,?,?)`);
  const insertPaiement = db.prepare(`INSERT INTO paiements (dossier_id,type,pct,base,delai,date_base) VALUES (?,?,?,?,?,?)`);

  const seed = [
    {
      ref: 'IMP-2026-0031', fournisseur: 'Shandong Heavy Industries', pays: 'Chine',
      incoterm: 'FOB', devise: 'USD', taux_prev: 3.11, taux_reel: null, statut: 'transit',
      articles: [['Moteurs électriques 15kW', 40, 410], ['Variateurs de fréquence', 60, 145]],
      transport: ['Maritime', 'MSCU7741029', 'MSC Elodie', ['MSCU7741029', 'MSCU7741030']],
      milestones: { etd: '2026-07-05', atd: '2026-07-06', eta_orig: '2026-08-10', eta: '2026-08-10', ata: null, dedouanement_prev: '2026-08-16', dedouanement_reel: null, livraison_prev: '2026-08-20', livraison_reel: null },
      frais: { fret: [4200, 4200], assurance: [380, 380], douane: [6100, null], magasinage: [0, null], transitaire: [650, 650], transportLocal: [300, null] },
      paiements: [['Acompte', 30, 'commande', 0, '2026-06-20'], ['Solde', 70, 'eta', 30, null]],
    },
    {
      ref: 'IMP-2026-0032', fournisseur: 'AnatoliaSteel A.Ş.', pays: 'Turquie',
      incoterm: 'CIF', devise: 'EUR', taux_prev: 3.38, taux_reel: 3.41, statut: 'douane',
      articles: [['Tôles acier galvanisé', 1200, 38]],
      transport: ['Maritime', 'ONEY5512837', 'ONE Innovation', ['ONEU5512837']],
      milestones: { etd: '2026-07-01', atd: '2026-07-01', eta_orig: '2026-07-28', eta: '2026-08-02', ata: '2026-08-03', dedouanement_prev: '2026-08-07', dedouanement_reel: null, livraison_prev: '2026-08-11', livraison_reel: null },
      frais: { fret: [2600, 2750], assurance: [410, 410], douane: [9800, 9950], magasinage: [0, 1200], transitaire: [520, 520], transportLocal: [280, 280] },
      paiements: [['Acompte', 20, 'commande', 0, '2026-06-10'], ['Solde', 80, 'bl', 45, null]],
    },
    {
      ref: 'IMP-2026-0033', fournisseur: 'Bergmann Präzision GmbH', pays: 'Allemagne',
      incoterm: 'EXW', devise: 'EUR', taux_prev: 3.36, taux_reel: null, statut: 'preparation',
      articles: [['Pièces de rechange CNC', 8, 1650], ['Roulements industriels', 300, 22]],
      transport: ['Aérien', 'LTA-020-88213456', 'LH 1180', []],
      milestones: { etd: null, atd: null, eta_orig: '2026-08-25', eta: '2026-08-25', ata: null, dedouanement_prev: '2026-08-27', dedouanement_reel: null, livraison_prev: '2026-08-29', livraison_reel: null },
      frais: { fret: [2100, null], assurance: [120, null], douane: [2400, null], magasinage: [0, null], transitaire: [300, null], transportLocal: [150, null] },
      paiements: [['Solde', 100, 'commande', 60, '2026-08-01']],
    },
    {
      ref: 'IMP-2026-0035', fournisseur: 'Nordic Pack AB', pays: 'Suède',
      incoterm: 'FOB', devise: 'EUR', taux_prev: 3.35, taux_reel: null, statut: 'port',
      articles: [["Films d'emballage industriel", 500, 64]],
      transport: ['Maritime', 'MAEU9902141', 'Maersk Halden', ['MAEU9902141']],
      milestones: { etd: '2026-07-20', atd: '2026-07-21', eta_orig: '2026-08-12', eta: '2026-08-12', ata: '2026-08-12', dedouanement_prev: '2026-08-15', dedouanement_reel: null, livraison_prev: '2026-08-19', livraison_reel: null },
      frais: { fret: [3100, 3100], assurance: [290, 290], douane: [5900, null], magasinage: [0, 640], transitaire: [480, 480], transportLocal: [220, null] },
      paiements: [['Solde', 100, 'bl', 25, null]],
    },
  ];

  const adminId = 1;
  const tx = db.transaction(() => {
    for (const s of seed) {
      const info = insertDossier.run({
        ref: s.ref, fournisseur: s.fournisseur, pays: s.pays, incoterm: s.incoterm,
        devise: s.devise, devise_frais: 'TND', taux_prev: s.taux_prev, taux_reel: s.taux_reel,
        statut: s.statut, created_by: adminId,
      });
      const dossierId = info.lastInsertRowid;
      for (const [designation, qte, pu] of s.articles) insertArticle.run(dossierId, designation, qte, pu);
      const [mode, bl, navire, conteneurs] = s.transport;
      insertTransport.run(dossierId, mode, bl, navire, JSON.stringify(conteneurs));
      insertMilestones.run({ dossier_id: dossierId, ...s.milestones });
      for (const [type, [est, reel]] of Object.entries(s.frais)) insertFrais.run(dossierId, type, est, reel);
      for (const [type, pct, base, delai, date_base] of s.paiements) insertPaiement.run(dossierId, type, pct, base, delai, date_base);
    }
  });
  tx();
  console.log(`Données de démonstration insérées : ${demoUsers.length} utilisateurs, ${seed.length} dossiers.`);
}

module.exports = db;
