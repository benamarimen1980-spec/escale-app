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

function valeurMarchandise(d) {
  return (d.articles || []).reduce((s, a) => s + (a.qte * a.pu), 0);
}

function fraisTotal(d, mode) {
  let t = 0;
  Object.values(d.frais || {}).forEach(f => {
    const v = mode === 'reel' ? (f.reel !== null && f.reel !== undefined ? f.reel : f.est) : f.est;
    t += v || 0;
  });
  return t;
}

function landedCost(d, mode) {
  const totalFrais = fraisTotal(d, mode);
  const totalVal = valeurMarchandise(d);
  const taux = mode === 'reel' && d.tauxReel ? d.tauxReel : d.tauxPrev;
  return (d.articles || []).map(a => {
    const valeur = a.qte * a.pu;
    const prorata = totalVal > 0 ? valeur / totalVal : 0;
    const fraisAlloc = prorata * totalFrais;
    const valeurLocale = valeur * (taux || 0);
    const coutRevientLocal = valeurLocale + fraisAlloc;
    return { ...a, valeur, fraisAlloc, coutRevientLocal, coutUnitaireLocal: a.qte ? coutRevientLocal / a.qte : 0 };
  });
}

function milestoneDate(d, base) {
  const m = d.milestones || {};
  if (base === 'commande') return (d.paiements || []).find(p => p.base === 'commande')?.dateBase || m.etd;
  if (base === 'etd') return m.atd || m.etd;
  if (base === 'bl') return m.atd || m.etd;
  if (base === 'eta') return m.eta;
  if (base === 'ata') return m.ata || m.eta;
  return null;
}

function montantPaye(d) {
  return (d.paiements || []).filter(p => p.paye).reduce((s, p) => s + valeurMarchandise(d) * p.pct / 100, 0);
}

function soldeRestantFacture(d) {
  return valeurMarchandise(d) - montantPaye(d);
}

function fraisEngages(d) {
  return Object.values(d.frais || {}).reduce((s, f) => s + (f.reel ?? f.est ?? 0), 0);
}

function fraisPayes(d) {
  return Object.values(d.frais || {}).reduce((s, f) => s + (f.paye ? (f.reel ?? f.est ?? 0) : 0), 0);
}

function fraisRestants(d) {
  return fraisEngages(d) - fraisPayes(d);
}

function prochaineEcheanceImpayee(d, today) {
  const ech = echeancierDossier(d).filter(e => !e.paye && e.dateEcheance);
  if (!ech.length) return null;
  ech.sort((a, b) => new Date(a.dateEcheance) - new Date(b.dateEcheance));
  return ech[0];
}

function statutPaiementFacture(d, today) {
  const paiements = d.paiements || [];
  if (!paiements.length) return 'Aucune échéance';
  const tousPayes = paiements.every(p => p.paye);
  if (tousPayes) return 'Payé intégralement';
  const certainsPayes = paiements.some(p => p.paye);
  const prochaine = prochaineEcheanceImpayee(d, today);
  const enRetard = prochaine && daysBetween(today, prochaine.dateEcheance) < 0;
  if (enRetard) return certainsPayes ? 'Partiel — en retard' : 'En retard';
  return certainsPayes ? 'Partiellement payé' : 'À payer';
}

function echeancierDossier(d) {
  return (d.paiements || []).map(p => {
    const base = p.base === 'commande' ? p.dateBase : milestoneDate(d, p.base);
    const dateEcheance = base ? addDays(base, p.delai) : null;
    const montantDevise = valeurMarchandise(d) * p.pct / 100;
    return { ...p, dateEcheance, montantDevise };
  });
}

function allEcheances(dossiers, today) {
  const rows = [];
  dossiers.forEach(d => {
    if (d.statut === 'cloture') return;
    echeancierDossier(d).forEach(e => {
      if (!e.dateEcheance) return;
      rows.push({ dossier: d, ...e });
    });
  });
  return rows.sort((a, b) => new Date(a.dateEcheance) - new Date(b.dateEcheance));
}

function computeAlerts(dossiers, today) {
  const alerts = [];
  dossiers.forEach(d => {
    if (d.statut === 'cloture') return;
    const m = d.milestones || {};
    if (m.eta && m.etaOrig && m.eta !== m.etaOrig) {
      const delta = daysBetween(m.etaOrig, m.eta);
      alerts.push({
        type: 'logistique', sev: delta > 5 ? 'red' : 'amber', dossierRef: d.ref, dossierId: d.id,
        text: `Retard ETA détecté — glissement de ${delta} jour${delta > 1 ? 's' : ''} (${m.etaOrig} → ${m.eta}).`,
      });
    }
    echeancierDossier(d).forEach(e => {
      if (!e.dateEcheance || e.paye) return;
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
    const echeancesSansDate = echeancierDossier(d).filter(e => !e.paye && !e.dateEcheance);
    if (echeancesSansDate.length) {
      const montantTotal = echeancesSansDate.reduce((s, e) => s + e.montantDevise, 0);
      alerts.push({
        type: 'donnee_manquante', sev: 'amber', dossierRef: d.ref, dossierId: d.id,
        text: `Échéance non planifiable — ${Math.round(montantTotal).toLocaleString('fr-FR')} ${d.devise} en attente d'une date de référence (ETA, ETD ou date de commande manquante). Non comptabilisé dans la trésorerie à engager.`,
      });
    }
    if (m.ata && !m.dedouanementReel) {
      const j = daysBetween(m.ata, today);
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

function computeKpis(dossiers, today) {
  const windows = [30, 60, 90];
  const byDevise = {};
  const ech = allEcheances(dossiers, today).filter(e => !e.paye);
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
  const withConteneurs = dossiers.filter(d => (d.transport?.conteneurs || []).length);
  const fretMoyen = withConteneurs.length
    ? Math.round(withConteneurs.reduce((s, d) => s + (d.frais?.fret?.reel ?? d.frais?.fret?.est ?? 0), 0) / withConteneurs.reduce((s, d) => s + d.transport.conteneurs.length, 0))
    : 0;
  const withReel = dossiers.filter(d => Object.values(d.frais || {}).some(f => f.reel !== null && f.reel !== undefined));
  const ecarts = withReel.map(d => {
    const est = fraisTotal(d, 'est'); const reel = fraisTotal(d, 'reel');
    return est ? (reel - est) / est * 100 : 0;
  });
  const ecartMoyen = ecarts.length ? ecarts.reduce((s, v) => s + v, 0) / ecarts.length : 0;
  const withAta = dossiers.filter(d => d.milestones?.atd && d.milestones?.ata);
  const leadTimes = withAta.map(d => daysBetween(d.milestones.atd, d.milestones.ata));
  const leadMoyen = leadTimes.length ? Math.round(leadTimes.reduce((s, v) => s + v, 0) / leadTimes.length) : 0;

  return { byDevise, fretMoyen, ecartMoyen, leadMoyen };
}

module.exports = {
  FRAIS_LABELS, valeurMarchandise, fraisTotal, landedCost, echeancierDossier,
  allEcheances, computeAlerts, computeKpis, daysBetween, addDays,
  montantPaye, soldeRestantFacture, fraisEngages, fraisPayes, fraisRestants,
  prochaineEcheanceImpayee, statutPaiementFacture,
};
