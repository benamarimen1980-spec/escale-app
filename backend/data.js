const { query } = require('./db');

const FRAIS_TYPES = ['fret', 'assurance', 'douane', 'magasinage', 'transitaire', 'transportLocal'];

function parseConteneurs(input) {
  if (Array.isArray(input)) return input;
  return (input || '').toString().split(',').map(s => s.trim()).filter(Boolean);
}

async function assembleDossier(id) {
  const { rows: dRows } = await query('SELECT * FROM dossiers WHERE id=$1', [id]);
  const d = dRows[0];
  if (!d) return null;

  const [{ rows: articles }, { rows: transportRows }, { rows: milestonesRows }, { rows: fraisRows }, { rows: paiementsRows }] = await Promise.all([
    query('SELECT id,designation,qte,pu, (qte*pu) as valeur FROM articles WHERE dossier_id=$1', [id]),
    query('SELECT * FROM transport WHERE dossier_id=$1', [id]),
    query('SELECT * FROM milestones WHERE dossier_id=$1', [id]),
    query('SELECT * FROM frais WHERE dossier_id=$1', [id]),
    query('SELECT * FROM paiements WHERE dossier_id=$1', [id]),
  ]);
  const transportRow = transportRows[0] || {};
  const milestones = milestonesRows[0] || {};

  const frais = {};
  fraisRows.forEach(f => { frais[f.type] = { est: f.estime, reel: f.reel, paye: !!f.paye }; });

  return {
    id: d.id, ref: d.ref, fournisseur: d.fournisseur, pays: d.pays,
    incoterm: d.incoterm, devise: d.devise, deviseFrais: d.devise_frais,
    tauxPrev: d.taux_prev, tauxReel: d.taux_reel, statut: d.statut,
    createdAt: d.created_at,
    articles: articles.map(a => ({ ...a, qte: Number(a.qte), pu: Number(a.pu), valeur: Number(a.valeur) })),
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
    paiements: paiementsRows.map(p => ({
      id: p.id, type: p.type, pct: Number(p.pct), base: p.base, delai: p.delai, dateBase: p.date_base,
      paye: !!p.paye, datePaiement: p.date_paiement,
    })),
  };
}

async function listDossiers() {
  const { rows } = await query('SELECT id FROM dossiers ORDER BY id DESC', []);
  return Promise.all(rows.map(r => assembleDossier(r.id)));
}

async function refExists(ref) {
  const { rows } = await query('SELECT id FROM dossiers WHERE ref=$1', [ref]);
  return rows.length > 0;
}

async function createDossier(b, userId) {
  const client = await require('./db').pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO dossiers (ref,fournisseur,pays,incoterm,devise,devise_frais,taux_prev,taux_reel,statut,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [b.ref, b.fournisseur, b.pays || null, b.incoterm, b.devise, b.deviseFrais || 'TND', b.tauxPrev || null, null, 'preparation', userId]
    );
    const dossierId = rows[0].id;

    for (const a of (b.articles || [])) {
      if (!a.designation) continue;
      await client.query('INSERT INTO articles (dossier_id,designation,qte,pu) VALUES ($1,$2,$3,$4)',
        [dossierId, a.designation, Number(a.qte) || 0, Number(a.pu) || 0]);
    }

    await client.query('INSERT INTO transport (dossier_id,mode,bl,navire,conteneurs) VALUES ($1,$2,$3,$4,$5)', [
      dossierId, b.transport?.mode || 'Maritime', b.transport?.bl || null, b.transport?.navire || null,
      JSON.stringify(parseConteneurs(b.transport?.conteneurs)),
    ]);

    await client.query(
      `INSERT INTO milestones (dossier_id,etd,atd,eta_orig,eta,ata,dedouanement_prev,dedouanement_reel,livraison_prev,livraison_reel)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [dossierId, b.milestones?.etd || null, null, b.milestones?.eta || null, b.milestones?.eta || null, null,
        b.milestones?.dedouanementPrev || null, null, b.milestones?.livraisonPrev || null, null]
    );

    for (const t of FRAIS_TYPES) {
      const est = Number(b.frais?.[t]) || 0;
      await client.query('INSERT INTO frais (dossier_id,type,estime,reel) VALUES ($1,$2,$3,NULL)', [dossierId, t, est]);
    }

    for (const p of (b.paiements || [])) {
      await client.query('INSERT INTO paiements (dossier_id,type,pct,base,delai,date_base) VALUES ($1,$2,$3,$4,$5,$6)',
        [dossierId, p.type || 'Solde', Number(p.pct) || 0, p.base || 'eta', Number(p.delai) || 0, p.dateBase || null]);
    }

    await client.query('COMMIT');
    return dossierId;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function updateDossierAchats(id, b) {
  const { rows } = await query('SELECT * FROM dossiers WHERE id=$1', [id]);
  const d = rows[0];
  if (!d) return null;

  await query(
    `UPDATE dossiers SET fournisseur=$1, pays=$2, incoterm=$3, devise=$4, taux_prev=$5 WHERE id=$6`,
    [b.fournisseur ?? d.fournisseur, b.pays ?? d.pays, b.incoterm ?? d.incoterm, b.devise ?? d.devise, b.tauxPrev ?? d.taux_prev, d.id]
  );

  if (Array.isArray(b.articles)) {
    await query('DELETE FROM articles WHERE dossier_id=$1', [d.id]);
    for (const a of b.articles) {
      if (!a.designation) continue;
      await query('INSERT INTO articles (dossier_id,designation,qte,pu) VALUES ($1,$2,$3,$4)',
        [d.id, a.designation, Number(a.qte) || 0, Number(a.pu) || 0]);
    }
  }
  if (Array.isArray(b.paiements)) {
    await query('DELETE FROM paiements WHERE dossier_id=$1', [d.id]);
    for (const p of b.paiements) {
      await query('INSERT INTO paiements (dossier_id,type,pct,base,delai,date_base) VALUES ($1,$2,$3,$4,$5,$6)',
        [d.id, p.type || 'Solde', Number(p.pct) || 0, p.base || 'eta', Number(p.delai) || 0, p.dateBase || null]);
    }
  }
  return d.id;
}

async function updateDossierLogistique(id, b) {
  const { rows } = await query('SELECT * FROM dossiers WHERE id=$1', [id]);
  const d = rows[0];
  if (!d) return null;

  if (b.transport) {
    const conteneurs = parseConteneurs(b.transport.conteneurs);
    await query('UPDATE transport SET mode=$1, bl=$2, navire=$3, conteneurs=$4 WHERE dossier_id=$5',
      [b.transport.mode, b.transport.bl, b.transport.navire, JSON.stringify(conteneurs), d.id]);
  }

  if (b.milestones) {
    const { rows: mRows } = await query('SELECT * FROM milestones WHERE dossier_id=$1', [d.id]);
    const cur = mRows[0] || {};
    const merged = { ...cur, ...b.milestones };
    await query(
      `UPDATE milestones SET etd=$1, atd=$2, eta_orig=$3, eta=$4, ata=$5, dedouanement_prev=$6, dedouanement_reel=$7, livraison_prev=$8, livraison_reel=$9 WHERE dossier_id=$10`,
      [merged.etd, merged.atd, merged.eta_orig, merged.eta, merged.ata, merged.dedouanement_prev, merged.dedouanement_reel, merged.livraison_prev, merged.livraison_reel, d.id]
    );
  }

  if (b.statut) await query('UPDATE dossiers SET statut=$1 WHERE id=$2', [b.statut, d.id]);
  return d.id;
}

async function simulerRetardEta(id, jours) {
  const { rows } = await query('SELECT m.* FROM milestones m WHERE m.dossier_id=$1', [id]);
  const m = rows[0];
  if (!m) return null;
  const addDays = (date, n) => { const r = new Date(date); r.setDate(r.getDate() + n); return r.toISOString().slice(0, 10); };
  const newEta = addDays(m.eta, jours);
  await query('UPDATE milestones SET eta=$1 WHERE dossier_id=$2', [newEta, id]);
  return id;
}

async function reinitialiserEta(id) {
  const { rows } = await query('SELECT * FROM milestones WHERE dossier_id=$1', [id]);
  const m = rows[0];
  if (!m) return null;
  await query('UPDATE milestones SET eta=$1 WHERE dossier_id=$2', [m.eta_orig, id]);
  return id;
}

async function updateDossierFinance(id, b) {
  const { rows } = await query('SELECT * FROM dossiers WHERE id=$1', [id]);
  const d = rows[0];
  if (!d) return null;

  if (b.frais) {
    for (const [type, vals] of Object.entries(b.frais)) {
      const { rows: fRows } = await query('SELECT * FROM frais WHERE dossier_id=$1 AND type=$2', [d.id, type]);
      const row = fRows[0];
      if (row) {
        await query('UPDATE frais SET estime=$1, reel=$2 WHERE id=$3',
          [vals.est ?? row.estime, vals.reel === undefined ? row.reel : vals.reel, row.id]);
      } else {
        await query('INSERT INTO frais (dossier_id,type,estime,reel) VALUES ($1,$2,$3,$4)', [d.id, type, vals.est || 0, vals.reel ?? null]);
      }
    }
  }
  if (b.tauxReel !== undefined) await query('UPDATE dossiers SET taux_reel=$1 WHERE id=$2', [b.tauxReel, d.id]);
  if (b.statut) await query('UPDATE dossiers SET statut=$1 WHERE id=$2', [b.statut, d.id]);
  return d.id;
}

async function markPaiementPaye(dossierId, paiementId, paye, datePaiement) {
  const { rows } = await query('SELECT id FROM paiements WHERE id=$1 AND dossier_id=$2', [paiementId, dossierId]);
  if (!rows[0]) return null;
  await query('UPDATE paiements SET paye=$1, date_paiement=$2 WHERE id=$3',
    [!!paye, paye ? (datePaiement || new Date().toISOString().slice(0, 10)) : null, paiementId]);
  return dossierId;
}

async function markFraisPaye(dossierId, type, paye) {
  const { rows } = await query('SELECT id FROM frais WHERE dossier_id=$1 AND type=$2', [dossierId, type]);
  if (!rows[0]) return null;
  await query('UPDATE frais SET paye=$1 WHERE id=$2', [!!paye, rows[0].id]);
  return dossierId;
}

async function deleteDossier(id) {
  await query('DELETE FROM dossiers WHERE id=$1', [id]);
}

module.exports = {
  FRAIS_TYPES, assembleDossier, listDossiers, refExists, createDossier,
  updateDossierAchats, updateDossierLogistique, updateDossierFinance,
  simulerRetardEta, reinitialiserEta, deleteDossier, markPaiementPaye, markFraisPaye,
};
