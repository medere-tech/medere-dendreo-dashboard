// scripts/resync-session.mjs — re-synchronisation CIBLÉE de N sessions nommées.
// -----------------------------------------------------------------------------
// POURQUOI CE SCRIPT : `sync-cheval.mjs` fait exactement ça mais sur une liste FIGÉE
// dans le code (liste Loane), et `backfill --year --limit N` ne sait pas cibler un
// idAdf précis. Il manquait un point d'entrée « re-synchronise CES sessions-là ».
//
// AUCUNE logique nouvelle : appelle `syncSession()` — la MÊME fonction que le webhook
// et que sync-cheval (ADF + lams + financements + factures + laps + fichiers, puis
// upsert session + signatures + recalcSessionCounts).
//
// purge = FALSE (défaut) : ce script re-synchronise, il ne nettoie pas. La purge des
// fantômes reste réservée au cron nocturne (S17.4).
//
// LECTURE SEULE Dendreo (GET). Écriture NOTRE Firestore uniquement. Idempotent.
// Logs : idAdf, dates et montants de facture — AUCUNE PII (aucun nom de participant).
//
// Usage (PowerShell) :
//   node --import tsx scripts/resync-session.mjs --idAdfs=3512
//   node --import tsx scripts/resync-session.mjs --idAdfs=3512,3509 --dry-run
//
// Coût : ~6 appels Dendreo par session + 3 référentiels sur tout le run.
// -----------------------------------------------------------------------------

import { syncSession } from '../src/dendreo/sync';
import { getDb } from '../src/firebase/admin';

const log = (...m) => console.log(...m);

function parseArgs(argv) {
  const a = { idAdfs: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--dry-run') a.dryRun = true;
    else if (t.startsWith('--idAdfs')) {
      const v = t.startsWith('--idAdfs=') ? t.slice('--idAdfs='.length) : argv[i + 1];
      a.idAdfs = String(v).split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));

const shortReason = (err) => String(err && err.message ? err.message : err).replace(/\s+/g, ' ').slice(0, 200);
const isQuotaError = (err) => (err && err.code) === 8 || /RESOURCE_EXHAUSTED|Quota exceeded/i.test(String((err && err.message) || ''));
const isDendreoQuotaError = (err) => (err && err.status === 429) || /HTTP 429/.test(String((err && err.message) || ''));
const val = (v) => (v === null || v === undefined || String(v).trim() === '' ? '(vide)' : String(v));

/** Les 4 champs qui nous intéressent, lus au miroir. */
async function lireFacture(idAdf) {
  const snap = await getDb().collection('sessions').doc(String(idAdf)).get();
  if (!snap.exists) return null;
  const s = snap.data();
  return {
    factureDateEnvoi: s.factureDateEnvoi ?? null,
    factureMontantHt: s.factureMontantHt ?? null,
    factureDatePaiement: s.factureDatePaiement ?? null,
    lastSyncedAt: s.lastSyncedAt ?? null,
    // S15 : split facture 1/2 des sessions à cheval — utile si la facture y a atterri.
    facture1DateEnvoi: s.facture1DateEnvoi ?? null,
    facture2DateEnvoi: s.facture2DateEnvoi ?? null,
    aCheval: s.aCheval ?? null,
  };
}

function afficher(titre, f) {
  log(`\n  --- ${titre} ---`);
  if (!f) { log('    (session absente du miroir)'); return; }
  log(`    factureDateEnvoi     : ${val(f.factureDateEnvoi)}`);
  log(`    factureMontantHt     : ${val(f.factureMontantHt)}`);
  log(`    factureDatePaiement  : ${val(f.factureDatePaiement)}`);
  log(`    lastSyncedAt         : ${val(f.lastSyncedAt)}`);
  log(`    (aCheval=${val(f.aCheval)} facture1DateEnvoi=${val(f.facture1DateEnvoi)} facture2DateEnvoi=${val(f.facture2DateEnvoi)})`);
}

async function main() {
  if (!args.idAdfs || args.idAdfs.length === 0) {
    log('usage: node --import tsx scripts/resync-session.mjs --idAdfs=3512[,3509] [--dry-run]');
    process.exit(1);
  }
  log(`# RESYNC CIBLÉ — ${args.idAdfs.length} session(s) : ${args.idAdfs.join(',')}${args.dryRun ? ' (DRY-RUN : lecture seule)' : ''}`);
  log(`# ~${args.idAdfs.length * 6 + 3} appels Dendreo (lecture seule) | écriture : NOTRE Firestore uniquement`);

  for (const idAdf of args.idAdfs) {
    log(`\n${'='.repeat(78)}\n# idAdf=${idAdf}`);
    const avant = await lireFacture(idAdf);
    afficher('AVANT (état du miroir)', avant);

    if (args.dryRun) { log('\n  [DRY-RUN] aucun re-sync lancé.'); continue; }

    try {
      const r = await syncSession(String(idAdf)); // purge=false (défaut)
      log(`\n  → syncSession OK : found=${r.found} attestations=${r.attestations}`);
    } catch (err) {
      if (isQuotaError(err)) { log(`\n  ⚠ QUOTA FIRESTORE (RESOURCE_EXHAUSTED) → arrêt propre. ${shortReason(err)}`); process.exit(0); }
      if (isDendreoQuotaError(err)) { log(`\n  ⚠ QUOTA DENDREO (HTTP 429) → arrêt propre. ${shortReason(err)}`); process.exit(0); }
      log(`\n  ✗ ÉCHEC syncSession : ${shortReason(err)}`);
      continue;
    }

    const apres = await lireFacture(idAdf);
    afficher('APRÈS (état du miroir)', apres);

    const change = (k) => String(avant?.[k] ?? '') !== String(apres?.[k] ?? '');
    const bouges = ['factureDateEnvoi', 'factureMontantHt', 'factureDatePaiement'].filter(change);
    log(`\n  VERDICT idAdf=${idAdf} : ${bouges.length ? `facture APPARUE / MODIFIÉE → ${bouges.join(', ')}` : 'facture INCHANGÉE (toujours vide côté miroir)'}`);
  }

  log(`\n# FIN — 0 écriture Dendreo, rien commité.`);
}

main().catch((err) => {
  if (isQuotaError(err)) { log(`# ⚠ QUOTA FIRESTORE → arrêt propre.`); process.exit(0); }
  log(`!! resync-session interrompu : ${shortReason(err)}`);
  process.exit(1);
});
