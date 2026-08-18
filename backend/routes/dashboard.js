const express = require('express');
const { requireAuth } = require('../middleware/auth');
const data = require('../data');
const logic = require('../logic');

const router = express.Router();
router.use(requireAuth);

function today() { return new Date().toISOString().slice(0, 10); }

router.get('/kpis', async (req, res) => {
  const dossiers = await data.listDossiers();
  res.json({ today: today(), kpis: logic.computeKpis(dossiers, today()) });
});

router.get('/alerts', async (req, res) => {
  const dossiers = await data.listDossiers();
  res.json({ today: today(), alerts: logic.computeAlerts(dossiers, today()) });
});

router.get('/echeancier', async (req, res) => {
  const dossiers = await data.listDossiers();
  const rows = logic.allEcheances(dossiers, today()).map(e => ({
    dossierRef: e.dossier.ref, dossierId: e.dossier.id, fournisseur: e.dossier.fournisseur,
    paiementId: e.id, type: e.type, pct: e.pct, base: e.base, delai: e.delai,
    dateEcheance: e.dateEcheance, montant: Math.round(e.montantDevise), devise: e.dossier.devise,
    joursRestants: logic.daysBetween(today(), e.dateEcheance),
    paye: e.paye, datePaiement: e.datePaiement,
  }));
  res.json({ today: today(), echeancier: rows });
});

module.exports = router;
