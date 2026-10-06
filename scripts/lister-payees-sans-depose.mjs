// scripts/lister-payees-sans-depose.mjs — LISTE : sessions PAYÉES dont le champ
// `factureMontantDepose` est ABSENT du miroir (doc écrit avant le déploiement du champ).
// -----------------------------------------------------------------------------
// Pourquoi : une session payée est EXCLUE du cron → elle ne sera jamais recalculée
// seule. Ces sessions n'ont donc jamais reçu `factureMontantDepose` : il faut un
// resync ciblé (scripts/resync-session.mjs --idAdfs=...).
//
// RÈGLE :
//   payée   = factureDatePaiement est une chaîne non vide
//   à resync = payée ET le champ `factureMontantDepose` N'EXISTE PAS dans le doc
//
// ABSENT ≠ null : `null` = calcul FAIT, aucune facture déposée → rien à rattraper.
// On teste l'EXISTENCE de la clé (Object.hasOwn), jamais la valeur : avec
// `doc.factureMontantDepose == null`, les deux cas seraient confondus.
// (Firestore ne stocke pas `undefined` : un champ jamais écrit est simplement absent.)
//
// LECTURE SEULE FIRESTORE. ZÉRO appel Dendreo, ZÉRO écriture, ZÉRO commit.
// PII : on ne lit QUE la collection `sessions` — aucun doc `signatures`, donc
// aucun nom, aucun e-mail. Les seuls identifiants affichés sont des idAdf.
// Coût : 1 lecture de la collection `sessions` (facturée au document).
//
// Usage (PowerShell) :
//   node --import tsx scripts/lister-payees-sans-depose.mjs              (tous millésimes)
//   node --import tsx scripts/lister-payees-sans-depose.mjs --year=2026  (année(dateDebut) === 2026)
// -----------------------------------------------------------------------------

import { getDb } from '../src/firebase/admin';

const log = (...m) => console.log(...m);
const head = (t) => log(`\n${'='.repeat(96)}\n${t}\n${'='.repeat(96)}`);

const APPELS_PAR_SESSION = 9; // estimation fournie (resync-session.mjs annonce ~6/session + 3 référentiels)

/** Année (nombre) d'une date ISO naïve — jour Paris, JAMAIS de `new Date`. */
const annee = (v) => {
  const a = Number(String(v ?? '').slice(0, 4));
  return Number.isInteger(a) && a > 1900 ? a : null;
};

/** --year=AAAA (ou --year AAAA) → nombre ; absent → null (tous millésimes). Invalide → arrêt. */
function parseYear(argv) {
  const i = argv.findIndex((t) => t === '--year' || t.startsWith('--year='));
  if (i < 0) return null;
  const v = argv[i].startsWith('--year=') ? argv[i].slice('--year='.length) : argv[i + 1];
  if (!/^\d{4}$/.test(String(v ?? ''))) {
    console.error(`✗ --year invalide (« ${v ?? ''} ») — attendu : --year=AAAA, ex. --year=2026`);
    process.exit(1);
  }
  return Number(v);
}
const YEAR = parseYear(process.argv.slice(2));
const perimetre = YEAR === null ? 'tous millésimes' : `année(dateDebut) === ${YEAR}`;

/** Payée = date de paiement renseignée (chaîne non vide). */
const estPayee = (doc) => typeof doc.factureDatePaiement === 'string' && doc.factureDatePaiement.trim() !== '';

async function main() {
  head('SESSIONS PAYÉES SANS factureMontantDepose — LECTURE SEULE (Firestore uniquement)');
  log('# Aucune écriture, aucun appel Dendreo, aucun doc `signatures` lu (pas de PII).');
  log('# Distinction : clé ABSENTE (Object.hasOwn === false) ≠ valeur null (calcul fait).');
  log(`# Périmètre : ${perimetre}.`);

  const snap = await getDb().collection('sessions').get();
  log(`# ${snap.size} session(s) au miroir, tous millésimes confondus.`);

  let horsAnnee = 0; // sessions écartées par --year (toutes, payées ou non)
  let payees = 0;
  const aResync = []; // clé absente
  let dejaNull = 0; // clé présente, null (calculé : aucune facture déposée)
  let dejaNombre = 0; // clé présente, nombre fini
  const nonConformes = []; // clé présente mais ni null ni nombre (ne devrait pas exister)

  snap.forEach((d) => {
    const doc = d.data() ?? {};
    if (YEAR !== null && annee(doc.dateDebut) !== YEAR) { horsAnnee++; return; }
    if (!estPayee(doc)) return;
    payees++;
    const idAdf = String(doc.idAdf ?? d.id);

    if (!Object.hasOwn(doc, 'factureMontantDepose')) {
      aResync.push(idAdf);
      return;
    }
    const v = doc.factureMontantDepose;
    if (v === null) dejaNull++;
    else if (typeof v === 'number' && Number.isFinite(v)) dejaNombre++;
    else nonConformes.push(idAdf);
  });

  aResync.sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));

  head(`RÉSULTAT — ${perimetre}`);
  if (YEAR !== null) log(`(${horsAnnee} session(s) écartée(s) : dateDebut hors ${YEAR} ou illisible)`);
  log(`Sessions payées (factureDatePaiement renseignée) : ${payees}`);
  log(`  → factureMontantDepose ABSENT (à resync)        : ${aResync.length}`);
  log(`  → déjà présent                                  : ${dejaNull + dejaNombre}  (null : ${dejaNull} | nombre : ${dejaNombre})`);
  if (nonConformes.length) {
    log(`  ⚠ présent mais NI null NI nombre                : ${nonConformes.length} → ${nonConformes.join(',')}`);
  }

  head(`idAdf À RESYNC (${aResync.length}) — ${perimetre} — format direct pour --idAdfs=`);
  log(aResync.length ? aResync.join(',') : '(aucune — rien à rattraper)');

  head('ESTIMATION APPELS DENDREO (resync, lecture seule)');
  log(`${aResync.length} × ~${APPELS_PAR_SESSION} ≈ ${aResync.length * APPELS_PAR_SESSION} appels`);
  if (aResync.length) {
    log(`\nCommande :\n  node --import tsx scripts/resync-session.mjs --idAdfs=${aResync.join(',')} --dry-run`);
  }

  log('\n# FIN — lecture seule, rien n\'a été écrit.');
}

main().catch((err) => {
  // Jamais de stack complète : un message SDK peut embarquer un credential.
  const msg = String(err?.message ?? err).replace(/(key|token|secret)[^\s]*/gi, '***');
  console.error(`✗ ÉCHEC : ${msg}`);
  process.exit(1);
});
