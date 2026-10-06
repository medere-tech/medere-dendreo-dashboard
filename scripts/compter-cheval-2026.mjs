// scripts/compter-cheval-2026.mjs — DIAG : les sessions à cheval 2026/2027 du miroir.
// -----------------------------------------------------------------------------
// QUESTION : pourquoi une seule session à cheval 26/27 ressort-elle facturable ?
// Ce script montre, pour CHAQUE session à cheval 26/27 du miroir, la valeur réelle
// de `facturableAnneeN` — et distingue les trois cas qui se confondent à l'œil nu :
//   true    → partie année N (amont+cœur) terminée → elle sort dans l'onglet
//   false   → calculée, mais un module non-aval n'est pas encore fini
//   ABSENT  → champ JAMAIS écrit : doc pas resynchronisé depuis S18 (≠ "pas facturable")
//
// LECTURE SEULE FIRESTORE. ZÉRO appel Dendreo, ZÉRO écriture, ZÉRO commit.
// PII : on ne lit QUE `sessions` — aucun doc `signatures`, donc aucun nom.
// Coût : 1 lecture de la collection `sessions` (facturée au document).
//
// Même init Firebase que lire-session.mjs / resync-session.mjs (`getDb()` de
// src/firebase/admin, creds via .env.local, jamais loggées) → d'où `--import tsx`.
//
// Millésime figé (cf. nom du fichier) : pour regarder une autre année, changer
// ANNEE_DEBUT ci-dessous — la fin attendue en est déduite.
//
// Usage (PowerShell) :
//   node --import tsx scripts/compter-cheval-2026.mjs
// -----------------------------------------------------------------------------

import { getDb } from '../src/firebase/admin';

const ANNEE_DEBUT = '2026';
const ANNEE_FIN = String(Number(ANNEE_DEBUT) + 1); // 2027

const log = (...m) => console.log(...m);
const head = (t) => log(`\n${'='.repeat(96)}\n${t}\n${'='.repeat(96)}`);

/** Année d'une date ISO naïve (jour Paris, JAMAIS de new Date). */
const annee = (v) => String(v ?? '').slice(0, 4);
/** Jour "AAAA-MM-JJ" d'une date ISO naïve. */
const jour = (v) => String(v ?? '').slice(0, 10) || '(vide)';

/** true / false / ABSENT — la distinction qui fait tout l'intérêt du script. */
function etatFlag(doc) {
  if (!('facturableAnneeN' in doc)) return 'ABSENT';
  return doc.facturableAnneeN === true ? 'true' : 'false';
}
/** Ordre d'affichage : les true d'abord, puis false, puis ABSENT. */
const RANG = { true: 0, false: 1, ABSENT: 2 };

const show = (v) => (v === undefined ? '(absent)' : v === null ? 'null' : v === '' ? '(vide)' : String(v));

function printTable(rows, cols) {
  if (!rows.length) { log('(aucune ligne)'); return; }
  const w = {};
  for (const c of cols) w[c] = Math.max(c.length, ...rows.map((r) => show(r[c]).length));
  log(cols.map((c) => c.padEnd(w[c])).join(' | '));
  log(cols.map((c) => '-'.repeat(w[c])).join('-+-'));
  for (const r of rows) log(cols.map((c) => show(r[c]).padEnd(w[c])).join(' | '));
}

async function main() {
  head(`SESSIONS À CHEVAL ${ANNEE_DEBUT}/${ANNEE_FIN} — LECTURE SEULE (Firestore uniquement)`);
  log('# Aucune écriture, aucun appel Dendreo, aucun doc `signatures` lu (pas de PII).');
  log(`# Critère : année(dateDebut) === ${ANNEE_DEBUT} ET année(dateFin) === ${ANNEE_FIN}.`);

  const snap = await getDb().collection('sessions').get();
  log(`# ${snap.size} session(s) au miroir, toutes collections d'années confondues.`);

  const lignes = [];
  snap.forEach((d) => {
    const doc = d.data() ?? {};
    if (annee(doc.dateDebut) !== ANNEE_DEBUT || annee(doc.dateFin) !== ANNEE_FIN) return;
    const flag = etatFlag(doc);
    lignes.push({
      idAdf: show(doc.idAdf ?? d.id),
      dateDebut: jour(doc.dateDebut),
      dateFin: jour(doc.dateFin),
      facturableAnneeN: flag,
      etape: show(doc.etape),
      financeurAndpc: show(doc.financeurAndpc),
      lastSyncedAt: jour(doc.lastSyncedAt), // pour lire un ABSENT : doc jamais resynchronisé ?
      _rang: RANG[flag],
      _num: Number(doc.idAdf ?? d.id) || 0,
    });
  });

  // Tri : facturableAnneeN (true en premier), puis idAdf.
  lignes.sort((a, b) => (a._rang - b._rang) || (a._num - b._num));

  head(`1) LES ${lignes.length} SESSION(S) À CHEVAL ${ANNEE_DEBUT}/${ANNEE_FIN}`);
  printTable(lignes, ['idAdf', 'dateDebut', 'dateFin', 'facturableAnneeN', 'etape', 'financeurAndpc', 'lastSyncedAt']);

  // ===== RÉCAP =============================================================
  const total = lignes.length;
  const nb = (f) => lignes.filter((l) => l.facturableAnneeN === f).length;
  const vrais = nb('true');
  const faux = nb('false');
  const absents = nb('ABSENT');

  head('2) RÉCAP');
  printTable([
    { etat: 'true (sortent dans l\'onglet)', nb: vrais },
    { etat: 'false (partie année N pas finie)', nb: faux },
    { etat: 'ABSENT (champ jamais écrit)', nb: absents },
    { etat: 'TOTAL à cheval ' + ANNEE_DEBUT + '/' + ANNEE_FIN, nb: total },
  ], ['etat', 'nb']);

  if (total === 0) {
    log(`\nAucune session à cheval ${ANNEE_DEBUT}/${ANNEE_FIN} au miroir.`);
    log('Vérifier que le backfill/sync a bien couvert ces sessions.');
  } else {
    log(`\nLecture : ${vrais}/${total} session(s) remontent aujourd'hui dans l'onglet à cheval.`);
    if (absents > 0) {
      log(`\n⚠ ${absents} session(s) ont le champ ABSENT — ce n'est PAS "non facturable" :`);
      log('  leur doc n\'a jamais été resynchronisé depuis S18, donc le flag n\'a jamais été calculé.');
      log('  Elles sont exclues de l\'onglet par le filtre strict, quelle que soit la réalité terrain.');
      const ids = lignes.filter((l) => l.facturableAnneeN === 'ABSENT').map((l) => l.idAdf);
      log(`  → node --import tsx scripts/resync-session.mjs --idAdfs=${ids.join(',')}`);
    }
    if (faux > 0) {
      log(`\n${faux} session(s) à false : le flag A été calculé, mais au moins un module non-aval`);
      log('  (catégorie != 21) a une date_fin non encore passée. Détail module par module :');
      const ids = lignes.filter((l) => l.facturableAnneeN === 'false').map((l) => l.idAdf);
      log(`  → node scripts/recon-modules-facturables.mjs ${ids[0]}   (un idAdf à la fois)`);
      if (ids.length > 1) log(`     autres : ${ids.slice(1).join(', ')}`);
    }
  }

  head('FIN');
  log('Lecture seule : aucun document écrit, aucun appel Dendreo, aucun commit.');
}

main().catch((err) => {
  console.error('ERREUR:', String(err && err.message ? err.message : err).replace(/\s+/g, ' ').slice(0, 300));
  process.exit(1);
});
