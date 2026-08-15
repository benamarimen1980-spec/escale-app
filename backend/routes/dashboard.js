const express = require('express');
const { requireAuth } = require('../middleware/auth');
const logic = require('../logic');

const router = express.Router();
router.use(requireAuth);

function today() {
  return new Date().toISOString().slice(0, 10);
}

router.get('/kpis', (req, res) => {
  res.json({ today: today(), kpis: logic.computeKpis(today()) });
});

router.get('/alerts', (req, res) => {
  res.json({ today: today(), alerts: logic.computeAlerts(today()) });
});

router.get('/echeancier', (req, res) => {
  const rows = logic.allEcheances(today()).map(e => ({
    dossierRef: e.dossier.ref, dossierId: e.dossier.id, fournisseur: e.dossier.fournisseur,
    type: e.type, pct: e.pct, base: e.base, delai: e.delai,
    dateEcheance: e.dateEcheance, montant: Math.round(e.montantDevise), devise: e.dossier.devise,
    joursRestants: logic.daysBetween(today(), e.dateEcheance),
  }));
  res.json({ today: today(), echeancier: rows });
});

module.exports = router;
