// scripts/lire-session.mjs — Doc BRUT d'une session du miroir Firestore.
// -----------------------------------------------------------------------------
// LECTURE SEULE FIRESTORE. ZÉRO appel Dendreo, ZÉRO écriture, ZÉRO commit.
// Sert à répondre à « pourquoi cette session ne sort pas dans l'export ? » en
// montrant les valeurs RÉELLES du miroir, sans les interpréter.
//
// PII : on lit UNIQUEMENT `sessions/{idAdf}`. Les documents `signatures/*` (qui
// portent les noms de participants) ne sont JAMAIS lus ici.
//
// Même init Firebase que resync-session.mjs / diag-elsa.mjs : `getDb()` de
// src/firebase/admin (creds via .env.local, jamais loggées) → d'où `--import tsx`.
//
// Usage (PowerShell) :
//   node --import tsx scripts/lire-session.mjs            # défaut idAdf=3818
//   node --import tsx scripts/lire-session.mjs 3818
//   node --import tsx scripts/lire-session.mjs 3818 2026  # 2e arg = debutYear à tester
// -----------------------------------------------------------------------------

import { getDb } from '../src/firebase/admin';

const log = (...m) => console.log(...m);
const head = (t) => log(`\n${'='.repeat(88)}\n${t}\n${'='.repeat(88)}`);
const sub = (t) => log(`\n--- ${t} ---`);

/** Clés montrées EN PREMIER (ordre imposé), avant le dump du reste. */
const PRIORITAIRES = [
  'idAdf', 'dateDebut', 'dateFin', 'aCheval', 'etape', 'idEtapeProcess',
  'financeurAndpc', 'numeroCompteProduit', 'eligibleDpc', 'type', 'lastSyncedAt',
  'facturableAnneeN', 'counts',
];

/** Rendu d'une valeur brute, sans interprétation. `undefined` = clé ABSENTE du doc. */
function rendu(v) {
  if (v === undefined) return '(ABSENT du doc)';
  if (v === null) return 'null';
  if (typeof v === 'object') return JSON.stringify(v);
  if (v === '') return '(chaîne vide)';
  return String(v);
}
const typeDe = (v) => (v === undefined ? '—' : v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

function ligne(cle, v, largeur) {
  log(`  ${cle.padEnd(largeur)} = ${rendu(v)}   [${typeDe(v)}]`);
}

/** Année d'une date ISO naïve, telle que la lit l'export (slice, JAMAIS de new Date). */
const annee = (v) => String(v ?? '').slice(0, 4);

async function main() {
  const idAdf = String(process.argv[2] || '3818').trim();
  const debutYear = String(process.argv[3] || '2026').trim();

  head(`LIRE-SESSION — sessions/${idAdf} — LECTURE SEULE (Firestore uniquement)`);
  log('# Aucune écriture, aucun appel Dendreo, aucun doc `signatures` lu (pas de PII).');

  const snap = await getDb().collection('sessions').doc(idAdf).get();

  if (!snap.exists) {
    head('RÉSULTAT : DOCUMENT ABSENT');
    log(`Le document sessions/${idAdf} N'EXISTE PAS dans le miroir Firestore.`);
    log('Autrement dit : cette session n\'a jamais été synchronisée (ou a été supprimée).');
    log('Elle ne peut donc apparaître dans AUCUN export — le filtre n\'y est pour rien.');
    log(`\nPour la créer : node --import tsx scripts/resync-session.mjs --idAdfs=${idAdf}`);
    return;
  }

  const doc = snap.data() ?? {};
  const cles = Object.keys(doc).sort();
  const largeur = Math.max(...[...PRIORITAIRES, ...cles].map((k) => k.length));

  // ===== 1) Clés prioritaires, dans l'ordre demandé =========================
  head('1) CHAMPS CLÉS (ordre imposé) — valeurs BRUTES du miroir');
  for (const k of PRIORITAIRES) {
    if (k === 'counts') continue; // détaillé juste après
    ligne(k, doc[k], largeur);
  }

  sub('counts (détail, avec les sous-objets S18)');
  const counts = doc.counts;
  if (counts === undefined || counts === null || typeof counts !== 'object') {
    log(`  counts = ${rendu(counts)}  ← pas d'objet counts sur ce doc`);
  } else {
    const sousLargeur = 22;
    for (const k of ['envoyes', 'signes', 'nonSignes', 'participantsConcernes', 'participantsARelancer']) {
      log(`  counts.${k.padEnd(sousLargeur)} = ${rendu(counts[k])}`);
    }
    for (const k of ['amontCoeur', 'aval']) {
      log(`  counts.${k.padEnd(sousLargeur)} = ${rendu(counts[k])}`);
    }
    const autres = Object.keys(counts).filter(
      (k) => !['envoyes', 'signes', 'nonSignes', 'participantsConcernes', 'participantsARelancer', 'amontCoeur', 'aval'].includes(k),
    );
    if (autres.length) for (const k of autres) log(`  counts.${k.padEnd(sousLargeur)} = ${rendu(counts[k])}   [clé inattendue]`);
  }

  // ===== 2) Dates & test debutYear =========================================
  head('2) DATES — valeur exacte ET année lue par l\'export (slice 0,4)');
  const aDebut = annee(doc.dateDebut);
  const aFin = annee(doc.dateFin);
  log(`  dateDebut = ${rendu(doc.dateDebut)}`);
  log(`      → année(dateDebut) = "${aDebut}"`);
  log(`  dateFin   = ${rendu(doc.dateFin)}`);
  log(`      → année(dateFin)   = "${aFin}"`);

  sub(`Test du filtre ?debutYear=${debutYear} (règle EXACTE de web/src/app/api/export/sheet/route.ts)`);
  const attenduFin = String(Number(debutYear) + 1);
  const okDebut = aDebut === debutYear;
  const okFin = aFin === attenduFin;
  log(`  La règle exige : année(dateDebut) === "${debutYear}"  ET  année(dateFin) === "${attenduFin}"`);
  log(`    année(dateDebut) === "${debutYear}"   → ${okDebut ? 'OUI' : `NON (c'est "${aDebut}")`}`);
  log(`    année(dateFin)   === "${attenduFin}"   → ${okFin ? 'OUI' : `NON (c'est "${aFin}")`}`);
  log(`  VERDICT : la session ${okDebut && okFin ? 'PASSE' : 'NE PASSE PAS'} le filtre debutYear=${debutYear}.`);
  if (!(okDebut && okFin)) {
    if (aDebut && aFin && aDebut !== aFin) {
      log(`  → Elle est à cheval ${aDebut}→${aFin} : c'est donc debutYear=${aDebut} qui la matcherait.`);
    } else if (aDebut && aDebut === aFin) {
      log(`  → Début et fin sont dans la MÊME année (${aDebut}) : elle n'est à cheval sur aucune année, aucun debutYear ne la prendra.`);
    }
  }
  log('\n  Rappel : la borne haute dateFin <= aujourd\'hui (Paris) s\'applique TOUJOURS en plus,');
  log('  et les sessions en étape "Échec" sont exclues. Voir les champs etape / dateFin ci-dessus.');

  // ===== 3) Dump complet ===================================================
  head(`3) TOUTES LES CLÉS DU DOC (${cles.length}) — brut, ordre alphabétique`);
  for (const k of cles) ligne(k, doc[k], largeur);

  const manquantes = PRIORITAIRES.filter((k) => !(k in doc));
  if (manquantes.length) {
    sub('Clés attendues ABSENTES de ce doc');
    for (const k of manquantes) log(`  • ${k}`);
  }

  // ===== 4) Fraîcheur S18 (constat de présence, pas d'interprétation) ======
  head('4) CE DOC A-T-IL ÉTÉ RESYNCHRONISÉ DEPUIS S18 ?');
  const aFlag = 'facturableAnneeN' in doc;
  const aBlocs = !!(counts && typeof counts === 'object' && (counts.amontCoeur !== undefined || counts.aval !== undefined));
  log(`  champ facturableAnneeN présent      : ${aFlag ? 'OUI' : 'NON'}`);
  log(`  counts.amontCoeur / counts.aval     : ${aBlocs ? 'OUI' : 'NON'}`);
  log(`  lastSyncedAt                        : ${rendu(doc.lastSyncedAt)}`);
  if (!aFlag || !aBlocs) {
    log('\n  → Doc écrit AVANT S18. Les colonnes de bloc sortiront "-" et "❌" dans l\'export :');
    log('    c\'est le défaut sûr, pas une valeur calculée. Un resync remplit ces champs :');
    log(`      node --import tsx scripts/resync-session.mjs --idAdfs=${idAdf}`);
  } else {
    log('\n  → Doc à jour S18 : les 3 colonnes de l\'onglet à cheval 2026 sont alimentées.');
  }

  head('FIN');
  log('Lecture seule : aucun document écrit, aucun appel Dendreo, aucun commit.');
}

main().catch((err) => {
  console.error('ERREUR:', String(err && err.message ? err.message : err).replace(/\s+/g, ' ').slice(0, 300));
  process.exit(1);
});
