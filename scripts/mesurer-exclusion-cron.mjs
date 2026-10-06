// scripts/mesurer-exclusion-cron.mjs — MESURE : combien de sessions le cron nocturne
// pourrait-il ARRÊTER de rafraîchir, et combien d'appels API cela économise-t-il ?
// -----------------------------------------------------------------------------
// PROBLÈME : le cron resynchronise chaque nuit TOUTES les sessions du miroir
// (~5 endpoints Dendreo par session). On veut passer sous 120 000 appels/mois.
//
// HYPOTHÈSE TESTÉE : deux familles de sessions n'ont plus rien à apprendre de
// Dendreo et peuvent sortir du cron nocturne (un resync manuel reste possible) :
//
//   RÈGLE A — « entièrement payée » (l'argent est rentré, le dossier est clos) :
//     • session NON à cheval : factureMontantHt > 0 ET factureDatePaiement renseignée
//     • session À CHEVAL     : factureMontantHt > 0 ET facture2DatePaiement renseignée
//       (à cheval = 2 factures ; c'est la facture 2, budget de l'année de FIN,
//        qui solde le dossier — la facture 1 payée ne suffit PAS)
//     Note : `factureMontantHt` est déjà la Σ des factures ANDPC/DPC PAYÉES —
//     c'est le seul champ « montant » du miroir, il sert donc aux deux branches.
//
//   RÈGLE B — « normale ancienne » : NON à cheval ET année(dateDebut) <= 2025.
//     Volontairement bornée aux NON à cheval : une session à cheval 2025/2026 vit
//     encore en 2026, elle ne doit JAMAIS être exclue par l'ancienneté. Le script
//     VÉRIFIE ce point explicitement (§4) au lieu de le supposer.
//
// Une session est EXCLUE du cron si A **ou** B. Les autres RESTENT.
//
// LECTURE SEULE FIRESTORE. ZÉRO appel Dendreo, ZÉRO écriture, ZÉRO commit.
// PII : on ne lit QUE la collection `sessions` — aucun doc `signatures`, donc
// aucun nom, aucun e-mail. Les seuls identifiants affichés sont des idAdf.
// Coût : 1 lecture de la collection `sessions` (facturée au document).
//
// Même init Firebase que compter-cheval-2026.mjs (`getDb()` de src/firebase/admin,
// creds via .env.local, jamais loggées) → d'où `--import tsx`.
//
// Usage (PowerShell) :
//   node --import tsx scripts/mesurer-exclusion-cron.mjs
// -----------------------------------------------------------------------------

import { getDb } from '../src/firebase/admin';

/** Seuil règle B : une session NON à cheval commencée cette année-là ou avant est ancienne. */
const ANNEE_ANCIENNE_MAX = 2025;
/** Endpoints Dendreo appelés par le cron pour UNE session (ordre de grandeur assumé). */
const APPELS_PAR_SESSION = 5;
/** Nuits par mois — le cron tourne une fois par nuit. */
const NUITS_PAR_MOIS = 30;
/** Plafond visé, tous appels confondus. */
const PLAFOND_MENSUEL = 120000;

const log = (...m) => console.log(...m);
const head = (t) => log(`\n${'='.repeat(96)}\n${t}\n${'='.repeat(96)}`);
const pct = (n, d) => (d === 0 ? '—' : `${((n / d) * 100).toFixed(1)} %`);
const num = (n) => Number(n).toLocaleString('fr-FR');

/** Année (nombre) d'une date ISO naïve — jour Paris, JAMAIS de `new Date`. */
const annee = (v) => {
  const a = Number(String(v ?? '').slice(0, 4));
  return Number.isInteger(a) && a > 1900 ? a : null;
};
/** « Renseignée » = chaîne non vide après trim. null/undefined/'' → false. */
const rempli = (v) => typeof v === 'string' && v.trim() !== '';
/** Montant facturé > 0 ? (champ `number | null` ; tout le reste → false). */
const montantPositif = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

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
  head("MESURE D'EXCLUSION DU CRON NOCTURNE — LECTURE SEULE (Firestore uniquement)");
  log('# Aucune écriture, aucun appel Dendreo, aucun doc `signatures` lu (pas de PII).');
  log(`# Règle A : facture payée (facture 2 si à cheval). Règle B : NON à cheval ET dateDebut <= ${ANNEE_ANCIENNE_MAX}.`);

  const snap = await getDb().collection('sessions').get();
  log(`# ${snap.size} session(s) au miroir, tous millésimes confondus.`);

  const sessions = [];
  snap.forEach((d) => {
    const doc = d.data() ?? {};
    const aCheval = doc.aCheval === true;
    const an = annee(doc.dateDebut);
    const paiement = aCheval ? doc.facture2DatePaiement : doc.factureDatePaiement;

    const regleA = montantPositif(doc.factureMontantHt) && rempli(paiement);
    // Règle B : jamais appliquée aux sessions à cheval (garde `!aCheval`, vérifiée en §4).
    const regleB = !aCheval && an !== null && an <= ANNEE_ANCIENNE_MAX;

    sessions.push({
      idAdf: String(doc.idAdf ?? d.id),
      aCheval,
      anneeDebut: an,
      regleA,
      regleB,
      exclue: regleA || regleB,
      // Une dateDebut illisible/absente ne peut JAMAIS déclencher la règle B :
      // on la signale au lieu de la traiter comme « ancienne ».
      anneeIllisible: an === null,
    });
  });

  const total = sessions.length;
  const cheval = sessions.filter((s) => s.aCheval);
  const normales = sessions.filter((s) => !s.aCheval);

  const nA = sessions.filter((s) => s.regleA).length;
  const nB = sessions.filter((s) => s.regleB).length;
  const nAseule = sessions.filter((s) => s.regleA && !s.regleB).length;
  const nBseule = sessions.filter((s) => s.regleB && !s.regleA).length;
  const nAetB = sessions.filter((s) => s.regleA && s.regleB).length;
  const exclues = sessions.filter((s) => s.exclue).length;
  const restantes = total - exclues;

  // ===== 1) RÉCAP GLOBAL ====================================================
  head('1) RÉCAP GLOBAL');
  printTable([
    { critere: 'TOTAL sessions au miroir', nb: total, part: pct(total, total) },
    { critere: 'exclues par A SEULE (payée, pas ancienne)', nb: nAseule, part: pct(nAseule, total) },
    { critere: 'exclues par B SEULE (ancienne, pas payée)', nb: nBseule, part: pct(nBseule, total) },
    { critere: 'exclues par A ET B (les deux)', nb: nAetB, part: pct(nAetB, total) },
    { critere: 'EXCLUES au total (A ou B)', nb: exclues, part: pct(exclues, total) },
    { critere: 'RESTANTES dans le cron (ni A ni B)', nb: restantes, part: pct(restantes, total) },
  ], ['critere', 'nb', 'part']);
  log(`\n# Contrôle : A seule + B seule + (A et B) + restantes = ${nAseule + nBseule + nAetB + restantes} (doit valoir ${total}).`);
  log(`# Totaux bruts : règle A = ${nA}, règle B = ${nB} — elles se recouvrent sur ${nAetB} session(s).`);

  // ===== 2) DÉTAIL PAR FAMILLE ==============================================
  head('2) DÉTAIL PAR FAMILLE (à cheval vs normales)');
  const detail = (arr, nom) => ({
    famille: nom,
    total: arr.length,
    exclues_A: arr.filter((s) => s.regleA).length,
    exclues_B: arr.filter((s) => s.regleB).length,
    exclues_total: arr.filter((s) => s.exclue).length,
    restantes: arr.filter((s) => !s.exclue).length,
  });
  printTable([
    detail(cheval, 'à cheval (aCheval=true)'),
    detail(normales, 'normales (aCheval=false)'),
    detail(sessions, 'TOUTES'),
  ], ['famille', 'total', 'exclues_A', 'exclues_B', 'exclues_total', 'restantes']);

  const chevalExcluesA = cheval.filter((s) => s.regleA).length;
  const chevalRestantes = cheval.filter((s) => !s.exclue).length;
  log(`\n# À cheval : ${chevalExcluesA}/${cheval.length} exclue(s) par A (facture 2 payée), ${chevalRestantes} restent dans le cron.`);

  // ===== 3) RÉPARTITION DES RESTANTES =======================================
  head('3) LES RESTANTES, PAR ANNÉE DE DÉBUT (ce que le cron continuera de lire)');
  const parAnnee = new Map();
  for (const s of sessions.filter((x) => !x.exclue)) {
    const k = `${s.anneeDebut ?? '(année illisible)'}${s.aCheval ? ' (à cheval)' : ''}`;
    parAnnee.set(k, (parAnnee.get(k) ?? 0) + 1);
  }
  printTable(
    [...parAnnee.entries()]
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      .map(([k, n]) => ({ anneeDebut: k, restantes: n })),
    ['anneeDebut', 'restantes'],
  );

  // ===== 4) VÉRIFICATION : la règle B ne touche AUCUNE session à cheval =====
  head('4) VÉRIFICATION — la règle B ne doit toucher QUE les sessions NON à cheval');
  const chevalExcluesParB = cheval.filter((s) => s.regleB);
  if (chevalExcluesParB.length === 0) {
    log(`OK CONFIRMÉ : 0 session à cheval exclue par la règle B (sur ${cheval.length} session(s) à cheval).`);
    log("   Une session à cheval 2025/2026 reste donc dans le cron tant que sa facture 2 n'est pas payée.");
  } else {
    log(`ANOMALIE : ${chevalExcluesParB.length} session(s) à cheval sont exclues par la règle B.`);
    log("   C'est un bug de ce script (la règle B est gardée par `!aCheval`) — NE PAS appliquer l'exclusion.");
    printTable(
      chevalExcluesParB.slice(0, 20).map((s) => ({ idAdf: s.idAdf, anneeDebut: s.anneeDebut })),
      ['idAdf', 'anneeDebut'],
    );
  }

  const illisibles = sessions.filter((s) => s.anneeIllisible);
  if (illisibles.length > 0) {
    log(`\nATTENTION : ${illisibles.length} session(s) ont une dateDebut illisible/absente. Elles ne sont`);
    log("  JAMAIS exclues par la règle B (on ne devine pas leur année) — elles restent dans le cron.");
    printTable(
      illisibles.slice(0, 20).map((s) => ({ idAdf: s.idAdf, aCheval: s.aCheval, exclueParA: s.regleA })),
      ['idAdf', 'aCheval', 'exclueParA'],
    );
  }

  // ===== 5) ESTIMATION DES APPELS API =======================================
  head('5) ESTIMATION DES APPELS DENDREO');
  const nuitActuelle = total * APPELS_PAR_SESSION;
  const nuitApres = restantes * APPELS_PAR_SESSION;
  const moisActuel = nuitActuelle * NUITS_PAR_MOIS;
  const moisApres = nuitApres * NUITS_PAR_MOIS;
  const economieAppels = moisActuel - moisApres;
  const economiePct = moisActuel === 0 ? '—' : `${(((moisActuel - moisApres) / moisActuel) * 100).toFixed(1)} %`;

  log(`# Hypothèse : ${APPELS_PAR_SESSION} endpoints par session, ${NUITS_PAR_MOIS} nuits par mois.`);
  log('# Base = VOLUME RÉEL du miroir (toutes les sessions, tous millésimes) : c\'est bien ce que le');
  log('#        cron balaie chaque nuit quand il réconcilie 2025 ET 2026 dans le même passage.');
  printTable([
    { poste: 'par NUIT — aujourd\'hui', sessions: total, appels: num(nuitActuelle) },
    { poste: 'par NUIT — après exclusion', sessions: restantes, appels: num(nuitApres) },
    { poste: 'par MOIS — aujourd\'hui', sessions: total, appels: num(moisActuel) },
    { poste: 'par MOIS — après exclusion', sessions: restantes, appels: num(moisApres) },
  ], ['poste', 'sessions', 'appels']);

  log(`\nÉconomie : ${num(economieAppels)} appels/mois en moins, soit ${economiePct} du volume actuel.`);
  log(`Plafond visé : ${num(PLAFOND_MENSUEL)} appels/mois.`);
  if (moisApres <= PLAFOND_MENSUEL) {
    const marge = PLAFOND_MENSUEL - moisApres;
    log(`OK : ${num(moisApres)} <= ${num(PLAFOND_MENSUEL)} — objectif ATTEINT par le seul cron nocturne.`);
    log(`   Marge restante : ${num(marge)} appels/mois, soit ~${Math.floor(marge / (APPELS_PAR_SESSION * NUITS_PAR_MOIS))} session(s) balayée(s) chaque nuit en plus,`);
    log(`   ou ~${Math.floor(marge / APPELS_PAR_SESSION)} resync(s) ponctuel(s). C'est là-dedans que doivent tenir le sync`);
    log('   mensuel, les webhooks et les resyncs manuels : à budgéter avant de conclure.');
  } else {
    const surplus = moisApres - PLAFOND_MENSUEL;
    const cible = Math.floor(PLAFOND_MENSUEL / (APPELS_PAR_SESSION * NUITS_PAR_MOIS));
    log(`DÉPASSEMENT : ${num(moisApres)} > ${num(PLAFOND_MENSUEL)} — il reste ${num(surplus)} appels/mois de trop.`);
    log(`   Pour tenir, il faudrait descendre à ~${num(cible)} session(s) balayée(s) chaque nuit (on est à ${num(restantes)}),`);
    log(`   ou espacer le cron, ou réduire les ${APPELS_PAR_SESSION} endpoints par session.`);
  }
  log('\nATTENTION : ces chiffres ne couvrent QUE le cron nocturne. Le sync mensuel, les webhooks et');
  log('  les resyncs manuels s\'ajoutent au total facturé — ils ne sont pas mesurés ici.');

  head('FIN');
  log('Lecture seule : aucun document écrit, aucun appel Dendreo, aucun commit.');
}

main().catch((err) => {
  console.error('ERREUR:', String(err && err.message ? err.message : err).replace(/\s+/g, ' ').slice(0, 300));
  process.exit(1);
});
