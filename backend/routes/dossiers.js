const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const logic = require('../logic');

const router = express.Router();
router.use(requireAuth);

function logAction(req, action, entity, entityId, details) {
  db.prepare(`INSERT INTO audit_log (user_id,user_nom,action,entity,entity_id,details) VALUES (?,?,?,?,?,?)`)
    .run(req.user.id, req.user.nom, action, entity, entityId ?? null, details ?? null);
}

// ---- LIST / DETAIL (all roles, read) ----
router.get('/', (req, res) => {
  res.json({ dossiers: logic.listDossiers() });
});

router.get('/:id', (req, res) => {
  const d = logic.assembleDossier(req.params.id);
  if (!d) return res.status(404).json({ error: 'Dossier introuvable.' });
  res.json({ dossier: d });
});

// ---- CREATE (Achats / Admin) ----
router.post('/', requireRole('achats'), (req, res) => {
  const b = req.body || {};
  if (!b.ref || !b.fournisseur || !b.incoterm || !b.devise) {
    return res.status(400).json({ error: 'Champs requis manquants (référence, fournisseur, incoterm, devise).' });
  }
  const exists = db.prepare('SELECT id FROM dossiers WHERE ref=?').get(b.ref);
  if (exists) return res.status(409).json({ error: `La référence ${b.ref} existe déjà.` });

  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO dossiers (ref,fournisseur,pays,incoterm,devise,devise_frais,taux_prev,taux_reel,statut,created_by)
      VALUES (@ref,@fournisseur,@pays,@incoterm,@devise,@devise_frais,@taux_prev,@taux_reel,@statut,@created_by)
    `).run({
      ref: b.ref, fournisseur: b.fournisseur, pays: b.pays || null, incoterm: b.incoterm,
      devise: b.devise, devise_frais: b.deviseFrais || 'TND', taux_prev: b.tauxPrev || null,
      taux_reel: null, statut: 'preparation', created_by: req.user.id,
    });
    const dossierId = info.lastInsertRowid;

    (b.articles || []).forEach(a => {
      if (!a.designation) return;
      db.prepare('INSERT INTO articles (dossier_id,designation,qte,pu) VALUES (?,?,?,?)')
        .run(dossierId, a.designation, Number(a.qte) || 0, Number(a.pu) || 0);
    });

    db.prepare('INSERT INTO transport (dossier_id,mode,bl,navire,conteneurs) VALUES (?,?,?,?,?)').run(
      dossierId, b.transport?.mode || 'Maritime', b.transport?.bl || null, b.transport?.navire || null,
      JSON.stringify((b.transport?.conteneurs || '').toString().split(',').map(s => s.trim()).filter(Boolean))
    );

    db.prepare(`
      INSERT INTO milestones (dossier_id,etd,atd,eta_orig,eta,ata,dedouanement_prev,dedouanement_reel,livraison_prev,livraison_reel)
      VALUES (@dossier_id,@etd,@atd,@eta_orig,@eta,@ata,@dedouanement_prev,@dedouanement_reel,@livraison_prev,@livraison_reel)
    `).run({
      dossier_id: dossierId,
      etd: b.milestones?.etd || null, atd: null,
      eta_orig: b.milestones?.eta || null, eta: b.milestones?.eta || null, ata: null,
      dedouanement_prev: b.milestones?.dedouanementPrev || null, dedouanement_reel: null,
      livraison_prev: b.milestones?.livraisonPrev || null, livraison_reel: null,
    });

    const fraisTypes = ['fret', 'assurance', 'douane', 'magasinage', 'transitaire', 'transportLocal'];
    fraisTypes.forEach(t => {
      const est = Number(b.frais?.[t]) || 0;
      db.prepare('INSERT INTO frais (dossier_id,type,estime,reel) VALUES (?,?,?,NULL)').run(dossierId, t, est);
    });

    (b.paiements || []).forEach(p => {
      db.prepare('INSERT INTO paiements (dossier_id,type,pct,base,delai,date_base) VALUES (?,?,?,?,?,?)')
        .run(dossierId, p.type || 'Solde', Number(p.pct) || 0, p.base || 'eta', Number(p.delai) || 0, p.dateBase || null);
    });

    return dossierId;
  });

  const dossierId = tx();
  logAction(req, 'Création dossier', 'dossier', dossierId, b.ref);
  res.status(201).json({ dossier: logic.assembleDossier(dossierId) });
});

// ---- UPDATE — infos Achats (Achats / Admin) ----
router.put('/:id', requireRole('achats'), (req, res) => {
  const d = db.prepare('SELECT * FROM dossiers WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Dossier introuvable.' });
  const b = req.body || {};

  db.prepare(`UPDATE dossiers SET fournisseur=?, pays=?, incoterm=?, devise=?, taux_prev=? WHERE id=?`).run(
    b.fournisseur ?? d.fournisseur, b.pays ?? d.pays, b.incoterm ?? d.incoterm,
    b.devise ?? d.devise, b.tauxPrev ?? d.taux_prev, d.id
  );

  if (Array.isArray(b.articles)) {
    db.prepare('DELETE FROM articles WHERE dossier_id=?').run(d.id);
    b.articles.forEach(a => {
      if (!a.designation) return;
      db.prepare('INSERT INTO articles (dossier_id,designation,qte,pu) VALUES (?,?,?,?)')
        .run(d.id, a.designation, Number(a.qte) || 0, Number(a.pu) || 0);
    });
  }
  if (Array.isArray(b.paiements)) {
    db.prepare('DELETE FROM paiements WHERE dossier_id=?').run(d.id);
    b.paiements.forEach(p => {
      db.prepare('INSERT INTO paiements (dossier_id,type,pct,base,delai,date_base) VALUES (?,?,?,?,?,?)')
        .run(d.id, p.type || 'Solde', Number(p.pct) || 0, p.base || 'eta', Number(p.delai) || 0, p.dateBase || null);
    });
  }

  logAction(req, 'Modification dossier (Achats)', 'dossier', d.id, d.ref);
  res.json({ dossier: logic.assembleDossier(d.id) });
});

// ---- UPDATE — Logistique (Logistique / Admin) ----
router.put('/:id/logistique', requireRole('logistique'), (req, res) => {
  const d = db.prepare('SELECT * FROM dossiers WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Dossier introuvable.' });
  const b = req.body || {};

  if (b.transport) {
    const conteneurs = Array.isArray(b.transport.conteneurs)
      ? b.transport.conteneurs
      : (b.transport.conteneurs || '').toString().split(',').map(s => s.trim()).filter(Boolean);
    db.prepare('UPDATE transport SET mode=?, bl=?, navire=?, conteneurs=? WHERE dossier_id=?')
      .run(b.transport.mode, b.transport.bl, b.transport.navire, JSON.stringify(conteneurs), d.id);
  }

  if (b.milestones) {
    const cur = db.prepare('SELECT * FROM milestones WHERE dossier_id=?').get(d.id);
    const merged = { ...cur, ...b.milestones };
    db.prepare(`
      UPDATE milestones SET etd=?, atd=?, eta_orig=?, eta=?, ata=?, dedouanement_prev=?, dedouanement_reel=?, livraison_prev=?, livraison_reel=?
      WHERE dossier_id=?
    `).run(
      merged.etd, merged.atd, merged.eta_orig, merged.eta, merged.ata,
      merged.dedouanement_prev, merged.dedouanement_reel, merged.livraison_prev, merged.livraison_reel, d.id
    );
  }

  if (b.statut) db.prepare('UPDATE dossiers SET statut=? WHERE id=?').run(b.statut, d.id);

  logAction(req, 'Mise à jour logistique', 'dossier', d.id, JSON.stringify(b.milestones || b.transport || {}));
  res.json({ dossier: logic.assembleDossier(d.id) });
});

// Simulate ETA slippage — convenience endpoint used by the "simulate delay" demo button
router.post('/:id/logistique/simuler-retard', requireRole('logistique'), (req, res) => {
  const d = db.prepare('SELECT * FROM dossiers WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Dossier introuvable.' });
  const m = db.prepare('SELECT * FROM milestones WHERE dossier_id=?').get(d.id);
  const jours = Number(req.body?.jours) || 5;
  const newEta = logic.addDays(m.eta, jours);
  db.prepare('UPDATE milestones SET eta=? WHERE dossier_id=?').run(newEta, d.id);
  logAction(req, 'Simulation retard ETA', 'dossier', d.id, `+${jours}j -> ${newEta}`);
  res.json({ dossier: logic.assembleDossier(d.id) });
});

router.post('/:id/logistique/reinitialiser-eta', requireRole('logistique'), (req, res) => {
  const m = db.prepare('SELECT * FROM milestones WHERE dossier_id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Dossier introuvable.' });
  db.prepare('UPDATE milestones SET eta=? WHERE dossier_id=?').run(m.eta_orig, req.params.id);
  logAction(req, 'Réinitialisation ETA', 'dossier', req.params.id, null);
  res.json({ dossier: logic.assembleDossier(req.params.id) });
});

// ---- UPDATE — Finance (Finance / Admin) ----
router.put('/:id/finance', requireRole('finance'), (req, res) => {
  const d = db.prepare('SELECT * FROM dossiers WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Dossier introuvable.' });
  const b = req.body || {};

  if (b.frais) {
    Object.entries(b.frais).forEach(([type, vals]) => {
      const row = db.prepare('SELECT * FROM frais WHERE dossier_id=? AND type=?').get(d.id, type);
      if (row) {
        db.prepare('UPDATE frais SET estime=?, reel=? WHERE id=?').run(
          vals.est ?? row.estime, vals.reel === undefined ? row.reel : vals.reel, row.id
        );
      } else {
        db.prepare('INSERT INTO frais (dossier_id,type,estime,reel) VALUES (?,?,?,?)').run(d.id, type, vals.est || 0, vals.reel ?? null);
      }
    });
  }
  if (b.tauxReel !== undefined) db.prepare('UPDATE dossiers SET taux_reel=? WHERE id=?').run(b.tauxReel, d.id);
  if (b.statut) db.prepare('UPDATE dossiers SET statut=? WHERE id=?').run(b.statut, d.id);

  logAction(req, 'Saisie frais réels / finance', 'dossier', d.id, JSON.stringify(b.frais || {}));
  res.json({ dossier: logic.assembleDossier(d.id) });
});

// ---- DELETE (Admin only) ----
router.delete('/:id', requireRole(), (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Suppression réservée au profil Admin.' });
  const d = db.prepare('SELECT * FROM dossiers WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Dossier introuvable.' });
  db.prepare('DELETE FROM dossiers WHERE id=?').run(d.id);
  logAction(req, 'Suppression dossier', 'dossier', d.id, d.ref);
  res.json({ ok: true });
});

module.exports = router;
