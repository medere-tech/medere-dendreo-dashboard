// scripts/lister-sessions-avec-avoir.mjs — LISTE : sessions ANDPC ayant au moins un AVOIR.
// -----------------------------------------------------------------------------
// Pourquoi : leur factureMontantDepose a pu être calculé avec l'ANCIENNE règle (avoirs
// non liés à leur facture parente) → valeur gonflée ou fausse. Les sessions payées
// étant exclues du cron, il faut les resync ciblées (resync-session.mjs --idAdfs=...).
//
// Méthode :
//   1) miroir : sessions avec activité de facturation ANDPC
//      (factureDateEnvoi OU factureMontantHt renseigné) ;
//   2) 1 factures.php par session ; AVOIR = facture ANDPC (id_opca=360) avec
//      montant_total_ht < 0 (marqueur prouvé, recon 200 sessions : 17/17).
//
// ⚠ QUOTA : 1 APPEL DENDREO PAR SESSION (~845 sur tout le parc). --n=NOMBRE limite à un
// échantillon aléatoire pour tester d'abord. Pause de 10 s avant le 1er appel : Ctrl+C
// pour annuler. Compteur RÉEL des requêtes HTTP (fetch instrumenté, retries 429 inclus).
// FIRESTORE : 1 lecture de la collection `sessions` (pas de `signatures` → pas de PII).
//
// GET UNIQUEMENT. Aucune écriture (ni Dendreo ni Firestore). Ne commite rien.
// Aucun nom affiché : seulement des idAdf.
//
// Usage (PowerShell) :
//   node --import tsx scripts/lister-sessions-avec-avoir.mjs          (TOUT le parc)
//   node --import tsx scripts/lister-sessions-avec-avoir.mjs --n=50   (échantillon test)
// -----------------------------------------------------------------------------

import { loadDendreoEnv } from '../src/config';
import { DendreoClient } from '../src/dendreo/client';
import { ANDPC_ID, parseMontant } from '../src/dendreo/financement';
import { getDb } from '../src/firebase/admin';

const log = (...m) => console.log(...m);
const head = (t) => log(`\n${'='.repeat(96)}\n${t}\n${'='.repeat(96)}`);
const PAUSE_MS = 10_000;

function parseN(argv) {
  const t = argv.find((a) => a.startsWith('--n='));
  if (!t) return null; // tout le parc
  const n = Number(t.slice('--n='.length));
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`✗ --n invalide (« ${t} ») — attendu un entier > 0, ex. --n=50`);
    process.exit(1);
  }
  return n;
}
const N = parseN(process.argv.slice(2));

function asArray(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.data)) return json.data;
  return json == null ? [] : [json];
}

function melanger(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const parIdAdf = (a, b) => Number(a) - Number(b) || a.localeCompare(b);

/** Avoir ANDPC : id_opca=360 ET montant_total_ht renseigné < 0. */
const estAvoirAndpc = (f) => {
  if (String(f.id_opca ?? '') !== ANDPC_ID) return false;
  const brut = f.montant_total_ht;
  if (brut === null || brut === undefined || String(brut).trim() === '') return false;
  return parseMontant(brut) < 0;
};

async function main() {
  head('SESSIONS ANDPC AVEC AVOIR — LECTURE SEULE (GET only, rien écrit, rien commité)');

  // ===== 1) Miroir =============================================================
  const snap = await getDb().collection('sessions').get();
  const candidates = [];
  snap.forEach((d) => {
    const doc = d.data() ?? {};
    const deposee = typeof doc.factureDateEnvoi === 'string' && doc.factureDateEnvoi.trim() !== '';
    const payee = typeof doc.factureMontantHt === 'number' && Number.isFinite(doc.factureMontantHt);
    if (deposee || payee) candidates.push(String(doc.idAdf ?? d.id));
  });
  const cible = N === null ? [...candidates].sort(parIdAdf) : melanger(candidates).slice(0, N);
  log(`# Miroir : ${snap.size} session(s) ; ${candidates.length} avec activité de facturation ANDPC.`);
  log(`# Périmètre : ${N === null ? 'TOUT le parc' : `échantillon aléatoire --n=${N}`} → ${cible.length} session(s).`);

  log(`\n${'!'.repeat(96)}`);
  log(`!!  QUOTA DENDREO : ~${cible.length} APPEL(S) factures.php (1 par session, lecture seule).`);
  log(`!!  ${N === null ? 'Pour tester d\'abord sur un échantillon : relancer avec --n=50.' : 'Échantillon : relancer sans --n pour tout le parc.'}`);
  log(`!!  Démarrage dans ${PAUSE_MS / 1000} s — Ctrl+C pour annuler.`);
  log('!'.repeat(96));
  await new Promise((r) => setTimeout(r, PAUSE_MS));

  // ===== 2) Dendreo ============================================================
  let appels = 0;
  const client = new DendreoClient({
    ...loadDendreoEnv(),
    fetchImpl: (input, init) => { appels++; return fetch(input, init); },
  });

  const avecAvoir = [];
  const echecs = [];
  for (const [i, idAdf] of cible.entries()) {
    try {
      const factures = asArray(await client.get('factures.php', { id_action_de_formation: idAdf }));
      if (factures.some(estAvoirAndpc)) avecAvoir.push(idAdf);
    } catch (err) {
      echecs.push(`${idAdf} (${String(err?.message ?? err).replace(/(key|token|secret)[^\s]*/gi, '***').slice(0, 80)})`);
    }
    if ((i + 1) % 50 === 0 || i + 1 === cible.length) {
      log(`  … ${i + 1}/${cible.length} sessions lues | avec avoir : ${avecAvoir.length} | appels : ${appels}`);
    }
  }

  // ===== 3) Résultat ===========================================================
  avecAvoir.sort(parIdAdf);
  head('RÉSULTAT');
  log(`Sessions examinées : ${cible.length - echecs.length} / ${cible.length}`);
  log(`Sessions avec ≥ 1 avoir ANDPC : ${avecAvoir.length}`);
  if (echecs.length) log(`⚠ Échecs (${echecs.length}, à relancer) : ${echecs.join(', ')}`);

  head(`idAdf AVEC AVOIR (${avecAvoir.length}) — format direct pour --idAdfs=`);
  log(avecAvoir.length ? avecAvoir.join(',') : '(aucune)');

  head('BUDGET');
  log(`Appels Dendreo (requêtes HTTP réelles) : ${appels}  (attendu : ${cible.length} ; plus = retries 429)`);
  log('\n# FIN — lecture seule, rien n\'a été écrit.');
}

main().catch((err) => {
  // Jamais de stack complète : un message SDK peut embarquer un credential.
  const msg = String(err?.message ?? err).replace(/(key|token|secret)[^\s]*/gi, '***');
  console.error(`✗ ÉCHEC : ${msg}`);
  process.exit(1);
});
