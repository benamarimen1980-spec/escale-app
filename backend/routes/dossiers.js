const express = require('express');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const data = require('../data');

const router = express.Router();
router.use(requireAuth);

async function logAction(req, action, entityId, details) {
  await query('INSERT INTO audit_log (user_id,user_nom,action,entity,entity_id,details) VALUES ($1,$2,$3,$4,$5,$6)',
    [req.user.id, req.user.nom, action, 'dossier', entityId || null, details || null]);
}

router.get('/', async (req, res) => {
  try { res.json({ dossiers: await data.listDossiers() }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Erreur serveur.' }); }
});

router.get('/:id', async (req, res) => {
  const d = await data.assembleDossier(req.params.id);
  if (!d) return res.status(404).json({ error: 'Dossier introuvable.' });
  res.json({ dossier: d });
});

router.post('/', requireRole('achats'), async (req, res) => {
  const b = req.body || {};
  if (!b.ref || !b.fournisseur || !b.incoterm || !b.devise) {
    return res.status(400).json({ error: 'Champs requis manquants (référence, fournisseur, incoterm, devise).' });
  }
  try {
    if (await data.refExists(b.ref)) {
      return res.status(409).json({ error: `La référence ${b.ref} existe déjà.` });
    }
    const dossierId = await data.createDossier(b, req.user.id);
    await logAction(req, 'Création dossier', dossierId, b.ref);
    res.status(201).json({ dossier: await data.assembleDossier(dossierId) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur serveur.' }); }
});

router.put('/:id', requireRole('achats'), async (req, res) => {
  try {
    const dossierId = await data.updateDossierAchats(req.params.id, req.body || {});
    if (!dossierId) return res.status(404).json({ error: 'Dossier introuvable.' });
    await logAction(req, 'Modification dossier (Achats)', dossierId, null);
    res.json({ dossier: await data.assembleDossier(dossierId) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur serveur.' }); }
});

router.put('/:id/logistique', requireRole('logistique'), async (req, res) => {
  try {
    const dossierId = await data.updateDossierLogistique(req.params.id, req.body || {});
    if (!dossierId) return res.status(404).json({ error: 'Dossier introuvable.' });
    await logAction(req, 'Mise à jour logistique', dossierId, JSON.stringify(req.body?.milestones || req.body?.transport || {}));
    res.json({ dossier: await data.assembleDossier(dossierId) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erreur serveur.' }); }
});

router.post('/:id/logistique/simuler-retard', requireRole('logistique'), async (req, res) => {
  const jours = Number(req.body?.jours) || 5;
  const dossierId = await data.simulerRetardEta(req.params.id, jours);
  if (!dossierId) return res.status(404).json({ error: 'Dossier introuvable.' });
  await logAction(req, 'Simulation retard ETA', dossierId, `+${jours}j`);
  res.json({ dossier: await data.assembleDossier(dossierId) });
});

router.post('/:id/logistique/reinitialiser-eta', requireRole('logistique'), async (req, res) => {
  const dossierId = await data.reinitialiserEta(req.params.id);
  if (!dossierId) return res.status(404).json({ error: 'Dossier introuvable.' });
  await logAction(req, 'Réinitialisation ETA', dossierId, null);
  res.json({ dossier: await data.assembleDossier(dossierId) });
});

router.put('/:id/finance', requireRole('finance'), async (req, res) => {
  const dossierId = await data.updateDossierFinance(req.params.id, req.body || {});
  if (!dossierId) return res.status(404).json({ error: 'Dossier introuvable.' });
  await logAction(req, 'Saisie frais réels / finance', dossierId, JSON.stringify(req.body?.frais || {}));
  res.json({ dossier: await data.assembleDossier(dossierId) });
});

router.post('/:id/paiements/:paiementId/payer', requireRole('finance'), async (req, res) => {
  const { paye, datePaiement } = req.body || {};
  const dossierId = await data.markPaiementPaye(req.params.id, req.params.paiementId, paye !== false, datePaiement);
  if (!dossierId) return res.status(404).json({ error: 'Échéance introuvable.' });
  await logAction(req, paye === false ? 'Annulation paiement échéance' : 'Marquage échéance payée', dossierId, req.params.paiementId);
  res.json({ dossier: await data.assembleDossier(dossierId) });
});

router.post('/:id/frais/:type/payer', requireRole('finance'), async (req, res) => {
  const { paye } = req.body || {};
  const dossierId = await data.markFraisPaye(req.params.id, req.params.type, paye !== false);
  if (!dossierId) return res.status(404).json({ error: 'Poste de frais introuvable.' });
  await logAction(req, paye === false ? 'Annulation paiement frais' : 'Marquage frais payé', dossierId, req.params.type);
  res.json({ dossier: await data.assembleDossier(dossierId) });
});

router.delete('/:id', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Suppression réservée au profil Admin.' });
  const d = await data.assembleDossier(req.params.id);
  if (!d) return res.status(404).json({ error: 'Dossier introuvable.' });
  await data.deleteDossier(req.params.id);
  await logAction(req, 'Suppression dossier', req.params.id, d.ref);
  res.json({ ok: true });
});

module.exports = router;
