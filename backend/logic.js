const db = require('./db');

const FRAIS_LABELS = {
  fret: 'Fret international',
  assurance: 'Assurance',
  douane: 'Droits de douane & taxes',
  magasinage: 'Magasinage / Surestaries',
  transitaire: 'Honoraires transitaire',
  transportLocal: 'Transport local',
};

const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r.toISOString().slice(0, 10); };

function assembleDossier(id) {
  const d = db.prepare('SELECT * FROM dossiers WHERE id=?').get(id);
  if (!d) return null;
  const articles = db.prepare('SELECT id,designation,qte,pu, (qte*pu) as valeur FROM articles WHERE dossier_id=?').all(id);
  const transportRow = db.prepare('SELECT * FROM transport WHERE dossier_id=?').get(id) || {};
  const milestones = db.prepare('SELECT * FROM milestones WHERE dossier_id=?').get(id) || {};
  const fraisRows = db.prepare('SELECT * FROM frais WHERE dossier_id=?').all(id);
  const paiementsRows = db.prepare('SELECT * FROM paiements WHERE dossier_id=?').all(id);

  const frais = {};
  fraisRows.forEach(f => { frais[f.type] = { est: f.estime, reel: f.reel }; });

  return {
    id: d.id, ref: d.ref, fournisseur: d.fournisseur, pays: d.pays,
    incoterm: d.incoterm, devise: d.devise, deviseFrais: d.devise_frais,
    tauxPrev: d.taux_prev, tauxReel: d.taux_reel, statut: d.statut,
    createdAt: d.created_at,
    articles,
    transport: {
      mode: transportRow.mode, bl: transportRow.bl, navire: transportRow.navire,
      conteneurs: transportRow.conteneurs ? JSON.parse(transportRow.conteneurs) : [],
    },
    milestones: {
      etd: milestones.etd, atd: milestones.atd, etaOrig: milestones.eta_orig, eta: milestones.eta,
      ata: milestones.ata, dedouanementPrev: milestones.dedouanement_prev, dedouanementReel: milestones.dedouanement_reel,
      livraisonPrev: milestones.livraison_prev, livraisonReel: milestones.livraison_reel,
    },
    frais,
    paiements: paiementsRows.map(p => ({ id: p.id, type: p.type, pct: p.pct, base: p.base, delai: p.delai, dateBase: p.date_base })),
  };
}

function listDossiers() {
  const ids = db.prepare('SELECT id FROM dossiers ORDER BY id DESC').all().map(r => r.id);
  return ids.map(assembleDossier);
}

function valeurMarchandise(d) { return d.articles.reduce((s, a) => s + a.valeur, 0); }

function fraisTotal(d, mode) {
  let t = 0;
  Object.values(d.frais).forEach(f => { const v = mode === 'reel' ? (f.reel !== null && f.reel !== undefined ? f.reel : f.est) : f.est; t += v; });
  return t;
}

function landedCost(d, mode) {
  const totalFrais = fraisTotal(d, mode);
  const totalVal = valeurMarchandise(d);
  const taux = mode === 'reel' && d.tauxReel ? d.tauxReel : d.tauxPrev;
  return d.articles.map(a => {
    const prorata = totalVal > 0 ? a.valeur / totalVal : 0;
    const fraisAlloc = prorata * totalFrais;
    const valeurLocale = a.valeur * taux;
    const coutRevientLocal = valeurLocale + fraisAlloc;
    return { ...a, fraisAlloc, coutRevientLocal, coutUnitaireLocal: coutRevientLocal / a.qte };
  });
}

function milestoneDate(d, base) {
  if (base === 'commande') return d.paiements.find(p => p.base === 'commande')?.dateBase || d.milestones.etd;
  if (base === 'etd') return d.milestones.atd || d.milestones.etd;
  if (base === 'bl') return d.milestones.atd || d.milestones.etd;
  if (base === 'eta') return d.milestones.eta;
  if (base === 'ata') return d.milestones.ata || d.milestones.eta;
  return null;
}

function echeancierDossier(d) {
  return d.paiements.map(p => {
    const base = p.base === 'commande' ? p.dateBase : milestoneDate(d, p.base);
    const dateEcheance = base ? addDays(base, p.delai) : null;
    const montantDevise = valeurMarchandise(d) * p.pct / 100;
    return { ...p, dateEcheance, montantDevise };
  });
}

function allEcheances(today) {
  const rows = [];
  listDossiers().forEach(d => {
    if (d.statut === 'cloture') return;
    echeancierDossier(d).forEach(e => {
      if (!e.dateEcheance) return;
      rows.push({ dossier: d, ...e });
    });
  });
  return rows.sort((a, b) => new Date(a.dateEcheance) - new Date(b.dateEcheance));
}

function computeAlerts(today) {
  const alerts = [];
  listDossiers().forEach(d => {
    if (d.statut === 'cloture') return;
    if (d.milestones.eta && d.milestones.etaOrig && d.milestones.eta !== d.milestones.etaOrig) {
      const delta = daysBetween(d.milestones.etaOrig, d.milestones.eta);
      alerts.push({
        type: 'logistique', sev: delta > 5 ? 'red' : 'amber', dossierRef: d.ref, dossierId: d.id,
        text: `Retard ETA détecté — glissement de ${delta} jour${delta > 1 ? 's' : ''} (${d.milestones.etaOrig} → ${d.milestones.eta}).`,
      });
    }
    echeancierDossier(d).forEach(e => {
      if (!e.dateEcheance) return;
      const j = daysBetween(today, e.dateEcheance);
      if (j < 0) {
        const retard = -j;
        alerts.push({
          type: 'finance', sev: 'red', dossierRef: d.ref, dossierId: d.id,
          text: `Échéance ${e.type.toLowerCase()} (${e.pct}%) en retard de ${retard} jour${retard > 1 ? 's' : ''} — ${Math.round(e.montantDevise).toLocaleString('fr-FR')} ${d.devise}.`,
        });
      } else if (j <= 7) {
        alerts.push({
          type: 'finance', sev: j <= 2 ? 'red' : 'amber', dossierRef: d.ref, dossierId: d.id,
          text: `Échéance ${e.type.toLowerCase()} (${e.pct}%) dans ${j} jour${j > 1 ? 's' : ''} — ${Math.round(e.montantDevise).toLocaleString('fr-FR')} ${d.devise}.`,
        });
      }
    });
    if (d.milestones.ata && !d.milestones.dedouanementReel) {
      const j = daysBetween(d.milestones.ata, today);
      if (j >= 5) {
        alerts.push({
          type: 'surestarie', sev: j >= 7 ? 'red' : 'amber', dossierRef: d.ref, dossierId: d.id,
          text: `Risque de surestaries — conteneur au port depuis ${j} jours (franchise 7 j).`,
        });
      }
    }
  });
  return alerts.sort((a, b) => (b.sev === 'red') - (a.sev === 'red'));
}

function computeKpis(today) {
  const windows = [30, 60, 90];
  const byDevise = {};
  const ech = allEcheances(today);
  windows.forEach(w => {
    ech.forEach(e => {
      const j = daysBetween(today, e.dateEcheance);
      // Inclure les échéances déjà en retard (j < 0) : une facture impayée reste
      // une sortie de trésorerie à venir, elle ne doit pas disparaître du calcul
      // simplement parce que son échéance est passée.
      if (j <= w) {
        byDevise[w] = byDevise[w] || {};
        byDevise[w][e.dossier.devise] = (byDevise[w][e.dossier.devise] || 0) + e.montantDevise;
      }
    });
  });
  const dossiers = listDossiers();
  const withConteneurs = dossiers.filter(d => d.transport.conteneurs.length);
  const fretMoyen = withConteneurs.length
    ? Math.round(withConteneurs.reduce((s, d) => s + (d.frais.fret?.reel ?? d.frais.fret?.est ?? 0), 0) / withConteneurs.reduce((s, d) => s + d.transport.conteneurs.length, 0))
    : 0;
  const withReel = dossiers.filter(d => Object.values(d.frais).some(f => f.reel !== null && f.reel !== undefined));
  const ecarts = withReel.map(d => {
    const est = fraisTotal(d, 'est'); const reel = fraisTotal(d, 'reel');
    return est ? (reel - est) / est * 100 : 0;
  });
  const ecartMoyen = ecarts.length ? ecarts.reduce((s, v) => s + v, 0) / ecarts.length : 0;
  const withAta = dossiers.filter(d => d.milestones.atd && d.milestones.ata);
  const leadTimes = withAta.map(d => daysBetween(d.milestones.atd, d.milestones.ata));
  const leadMoyen = leadTimes.length ? Math.round(leadTimes.reduce((s, v) => s + v, 0) / leadTimes.length) : 0;

  return { byDevise, fretMoyen, ecartMoyen, leadMoyen };
}

module.exports = {
  FRAIS_LABELS, assembleDossier, listDossiers, valeurMarchandise, fraisTotal,
  landedCost, echeancierDossier, allEcheances, computeAlerts, computeKpis,
  daysBetween, addDays,
};
