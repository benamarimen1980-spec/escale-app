const express = require('express');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { requireAuth } = require('../middleware/auth');
const logic = require('../logic');

const router = express.Router();
router.use(requireAuth);

function today() { return new Date().toISOString().slice(0, 10); }

// ---- EXCEL : échéancier de trésorerie ----
router.get('/tresorerie/excel', async (req, res) => {
  const rows = logic.allEcheances(today());

  const wb = new ExcelJS.Workbook();
  wb.creator = 'ESCALE';
  wb.created = new Date();
  const sheet = wb.addWorksheet('Échéancier trésorerie');

  sheet.columns = [
    { header: 'Dossier', key: 'ref', width: 16 },
    { header: 'Fournisseur', key: 'fournisseur', width: 28 },
    { header: 'Type de règlement', key: 'type', width: 16 },
    { header: '%', key: 'pct', width: 8 },
    { header: 'Base', key: 'base', width: 14 },
    { header: 'Délai (j)', key: 'delai', width: 10 },
    { header: "Date d'échéance", key: 'date', width: 16 },
    { header: 'Montant', key: 'montant', width: 14 },
    { header: 'Devise', key: 'devise', width: 8 },
    { header: 'Jours restants', key: 'jours', width: 12 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E6F63' } };
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

  rows.forEach(e => {
    const j = logic.daysBetween(today(), e.dateEcheance);
    const row = sheet.addRow({
      ref: e.dossier.ref, fournisseur: e.dossier.fournisseur, type: `${e.type} (${e.pct}%)`,
      pct: e.pct, base: e.base.toUpperCase(), delai: e.delai, date: e.dateEcheance,
      montant: Math.round(e.montantDevise), devise: e.dossier.devise, jours: j,
    });
    if (j <= 7) row.getCell('jours').font = { color: { argb: 'FFB5402F' }, bold: true };
  });
  sheet.getColumn('montant').numFmt = '#,##0';

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="echeancier-tresorerie-${today()}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

// ---- EXCEL : liste des dossiers ----
router.get('/dossiers/excel', async (req, res) => {
  const dossiers = logic.listDossiers();
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Dossiers');
  sheet.columns = [
    { header: 'Référence', key: 'ref', width: 16 },
    { header: 'Fournisseur', key: 'fournisseur', width: 28 },
    { header: 'Pays', key: 'pays', width: 14 },
    { header: 'Incoterm', key: 'incoterm', width: 10 },
    { header: 'Devise', key: 'devise', width: 8 },
    { header: 'Valeur marchandise', key: 'valeur', width: 18 },
    { header: 'Statut', key: 'statut', width: 16 },
    { header: 'ETA', key: 'eta', width: 14 },
  ];
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E6F63' } };
  dossiers.forEach(d => sheet.addRow({
    ref: d.ref, fournisseur: d.fournisseur, pays: d.pays, incoterm: d.incoterm, devise: d.devise,
    valeur: logic.valeurMarchandise(d), statut: d.statut, eta: d.milestones.eta,
  }));
  sheet.getColumn('valeur').numFmt = '#,##0';

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="dossiers-import-${today()}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

// ---- PDF : fiche dossier (landed cost + jalons) ----
router.get('/dossiers/:id/pdf', (req, res) => {
  const d = logic.assembleDossier(req.params.id);
  if (!d) return res.status(404).json({ error: 'Dossier introuvable.' });
  const items = logic.landedCost(d, 'est');
  const totalFrais = logic.fraisTotal(d, 'est');
  const totalVal = logic.valeurMarchandise(d);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${d.ref}-fiche.pdf"`);

  const doc = new PDFDocument({ margin: 44, size: 'A4' });
  doc.pipe(res);

  doc.fillColor('#134E45').fontSize(20).text('ESCALE', { continued: true }).fillColor('#5B6B62').fontSize(10).text('  Gestion des importations & trésorerie');
  doc.moveDown(0.6);
  doc.fillColor('#152420').fontSize(15).text(`Fiche dossier — ${d.ref}`);
  doc.fontSize(10).fillColor('#5B6B62').text(`Généré le ${today()}`);
  doc.moveDown(1);

  doc.fillColor('#152420').fontSize(11).text(`Fournisseur : ${d.fournisseur} (${d.pays || '-'})`);
  doc.text(`Incoterm : ${d.incoterm}   |   Devise : ${d.devise}   |   Taux prévisionnel : ${d.tauxPrev ?? '-'}`);
  doc.text(`Statut : ${d.statut}`);
  doc.text(`Transport : ${d.transport.mode || '-'} — BL/LTA ${d.transport.bl || '-'} — ${d.transport.navire || '-'}`);
  doc.moveDown(0.8);

  doc.fontSize(12).fillColor('#134E45').text('Jalons logistiques');
  doc.fontSize(10).fillColor('#152420');
  const m = d.milestones;
  [['ETD', m.etd], ['ATD', m.atd], ['ETA', m.eta], ['ATA', m.ata],
   ['Dédouanement prévisionnel', m.dedouanementPrev], ['Dédouanement réel', m.dedouanementReel],
   ['Livraison usine prévisionnelle', m.livraisonPrev], ['Livraison usine réelle', m.livraisonReel]]
    .forEach(([label, val]) => doc.text(`${label} : ${val || '—'}`));
  doc.moveDown(0.8);

  doc.fontSize(12).fillColor('#134E45').text('Coût de revient (Landed Cost — estimé)');
  doc.fontSize(9).fillColor('#5B6B62');
  const startX = doc.x, colW = [180, 50, 70, 80, 90];
  let y = doc.y + 4;
  const headers = ['Article', 'Qté', 'Valeur', 'Frais alloués', 'Coût revient'];
  headers.forEach((h, i) => doc.text(h, startX + colW.slice(0, i).reduce((a, b) => a + b, 0), y, { width: colW[i] }));
  y += 14;
  doc.fillColor('#152420').fontSize(9);
  items.forEach(a => {
    const vals = [a.designation, String(a.qte), Math.round(a.valeur).toLocaleString('fr-FR'), Math.round(a.fraisAlloc).toLocaleString('fr-FR'), Math.round(a.coutRevientLocal).toLocaleString('fr-FR')];
    vals.forEach((v, i) => doc.text(v, startX + colW.slice(0, i).reduce((a, b) => a + b, 0), y, { width: colW[i] }));
    y += 14;
  });
  y += 4;
  doc.moveTo(startX, y).lineTo(startX + colW.reduce((a, b) => a + b, 0), y).strokeColor('#DDE3DA').stroke();
  y += 6;
  doc.fontSize(10).fillColor('#134E45').text(`Total valeur : ${Math.round(totalVal).toLocaleString('fr-FR')} ${d.devise}    Total frais annexes : ${Math.round(totalFrais).toLocaleString('fr-FR')} ${d.deviseFrais}`, startX, y);

  doc.moveDown(2);
  doc.fontSize(8).fillColor('#8A968E').text('Document généré automatiquement par ESCALE — prototype de gestion des importations.', { align: 'center' });

  doc.end();
});

module.exports = router;
