// scripts/diag-fantomes.mjs — S17.1 : RECENSEMENT des fantômes à l'échelle du parc.
// -----------------------------------------------------------------------------
// DRY-RUN PUR. LECTURE SEULE. AUCUNE écriture, AUCUNE suppression, nulle part.
// Objectif : CHIFFRER le volume de fantômes AVANT toute décision de purge.
//
// « Fantôme » (S17.2) = un doc du miroir `signatures` dont la clé
// {idParticipant}_{doctypeId} n'est PLUS renvoyée par Dendreo pour cette session
// aujourd'hui, ET dont le status miroir est 'pending'. Le sync upsert et ne supprime
// jamais → la ligne survit à sa disparition côté source.
//
// La classification est au niveau de la CLÉ, jamais du participant. Deux mécanismes
// distincts sont prouvés, et seul le critère par clé les couvre tous les deux :
//   • RECON-3094 : le PARTICIPANT quitte la session → toutes ses lignes disparaissent.
//   • RECON-2721 : le participant RESTE, seule une LIGNE est retirée (PI_2026/doctype
//     177), ses attestations signées vivant sous une autre clé (doctype 172), intactes.
//
// Un doc 'signed' dont la clé a disparu n'est JAMAIS un fantôme : c'est une preuve de
// conformité évaporée de la source → compté et listé À PART, jamais purgeable.
//
// GARDE-FOU (non négociable) — une session est SKIPPÉE, jamais comptée en fantômes, si :
//   • l'appel fichiers.php échoue (HTTP != 200, réseau, non-JSON) ;
//   • la réponse n'est pas un tableau ;
//   • la réponse est VIDE alors que le miroir a des docs pour cette session.
// On ne conclut JAMAIS sur une réponse incertaine.
//
// SIGNAL "SUSPECT" (ne skippe pas, mais isole le chiffre) : si Dendreo renvoie moins
// de la moitié des docs du miroir, la session est comptée À PART (bucket « à vérifier »)
// pour que le total « sûr » ne soit jamais gonflé par une réponse partielle.
//
// Coût : 1 appel Dendreo par session + 1 requête Firestore (signatures) par session.
// Arrêt propre exit 0 sur quota Firestore (RESOURCE_EXHAUSTED), avec la commande de reprise.
//
// Usage :
//   npx tsx scripts/diag-fantomes.mjs --limit=20                 (échantillon prudent)
//   npx tsx scripts/diag-fantomes.mjs --acheval --verbose        (sessions à cheval, détail)
//   npx tsx scripts/diag-fantomes.mjs --idAdfs=3094,3822
//   npx tsx scripts/diag-fantomes.mjs --from=3500 --limit=50     (reprise après quota)
//
// Options : --idAdfs=a,b,c  --acheval  --limit=N  --from=<idAdf>  --verbose
//           --concurrency=N (défaut 4)
//
// ⚠ Avec --verbose la sortie contient des NOMS de participants : ne rien commiter.
// -----------------------------------------------------------------------------

import { DENDREO, loadDendreoEnv } from '../src/config';
import { DendreoClient } from '../src/dendreo/client';
import { computeSignatureStatus } from '../src/dendreo/signatures';
import { getDb } from '../src/firebase/admin';

// Doctypes d'attestation connus (référence S17.1). NON utilisé comme filtre : le sync
// ne filtre PAS par doctype (règle = nom "Attestation…" + cible Participant, cf.
// signatures.ts). Filtrer ici DIVERGERAIT du sync et fabriquerait de faux fantômes
// pour tout doctype hors liste. On s'en sert uniquement pour SIGNALER les inconnus.
const DOCTYPES_CONNUS = new Set(['165', '166', '173', '177', '141']);
const RATIO_SUSPECT = 0.5; // Dendreo < 50% du miroir → bucket « à vérifier »
const CONCURRENCY_DEFAUT = 4;

// --- args -------------------------------------------------------------------
function parseArgs(argv) {
  const a = { idAdfs: null, acheval: false, limit: null, from: null, verbose: false, concurrency: CONCURRENCY_DEFAUT };
  const value = (t, name, i) => (t.startsWith(`--${name}=`) ? t.slice(name.length + 3) : argv[i + 1]);
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--acheval') a.acheval = true;
    else if (t === '--verbose' || t === '-v') a.verbose = true;
    else if (t.startsWith('--idAdfs')) a.idAdfs = String(value(t, 'idAdfs', i)).split(',').map((s) => s.trim()).filter(Boolean);
    else if (t.startsWith('--limit')) a.limit = Number(value(t, 'limit', i));
    else if (t.startsWith('--from')) a.from = String(value(t, 'from', i)).trim();
    else if (t.startsWith('--concurrency')) a.concurrency = Number(value(t, 'concurrency', i)) || CONCURRENCY_DEFAUT;
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
const client = new DendreoClient(loadDendreoEnv());

// --- helpers ----------------------------------------------------------------
const log = (...m) => console.log(...m);
const val = (v) => (v === null || v === undefined || v === '' ? '—' : String(v));
const shortReason = (err) => String(err && err.message ? err.message : err).replace(/\s+/g, ' ').slice(0, 160);

/** Quota Firestore : code gRPC 8 / RESOURCE_EXHAUSTED (même test que backfill.mjs). */
function isQuotaError(err) {
  const code = err && err.code;
  const msg = String((err && err.message) || '');
  return code === 8 || /RESOURCE_EXHAUSTED|Quota exceeded/i.test(msg);
}

let quotaHit = false;
let appelsDendreo = 0;

/** Pool de concurrence borné, s'arrête de piocher dès que le quota est touché. */
async function pool(items, size, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length && !quotaHit) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, worker));
  return results;
}

// --- sélection des sessions (depuis le MIROIR : c'est lui qu'on audite) -------
async function listerSessions() {
  const col = getDb().collection('sessions');
  if (args.idAdfs) {
    const snaps = await Promise.all(args.idAdfs.map((id) => col.doc(id).get()));
    return snaps.filter((s) => s.exists).map((s) => ({ idAdf: s.id, ...s.data() }));
  }
  let q = col;
  if (args.acheval) q = q.where('aCheval', '==', true); // index existant
  const snap = await q.get();
  return snap.docs.map((d) => ({ idAdf: d.id, ...d.data() }));
}

// --- traitement d'une session ------------------------------------------------
async function analyserSession(session) {
  if (quotaHit) return { idAdf: session.idAdf, skipped: true };
  const idAdf = String(session.idAdf);

  // 1) le miroir (Firestore) — 1 requête
  let miroir;
  try {
    const snap = await getDb().collection('signatures').where('idAdf', '==', idAdf).get();
    miroir = snap.docs.map((d) => ({ _id: d.id, ...d.data() }));
  } catch (err) {
    if (isQuotaError(err)) { quotaHit = true; return { idAdf, quota: true }; }
    return { idAdf, skip: true, raison: `miroir illisible : ${shortReason(err)}` };
  }

  // 2) Dendreo — 1 appel, EXACTEMENT celui du sync (cf. signatures.ts §getSessionSignatureStatus)
  let brut;
  try {
    appelsDendreo += 1;
    brut = await client.get('fichiers.php', {
      cible: DENDREO.CIBLE_ADF,
      id_cible: idAdf,
      collection_name: DENDREO.COLLECTION_SIGNATURE,
    });
  } catch (err) {
    // GARDE-FOU : appel KO (HTTP != 200, réseau, non-JSON) → aucun fantôme compté.
    return { idAdf, miroirCount: miroir.length, skip: true, raison: `appel Dendreo KO : ${shortReason(err)}` };
  }

  // GARDE-FOU : réponse non exploitable.
  if (!Array.isArray(brut)) {
    return { idAdf, miroirCount: miroir.length, skip: true, raison: `réponse non-tableau (${typeof brut})` };
  }
  const fichiers = brut;
  if (fichiers.length === 0 && miroir.length > 0) {
    return { idAdf, miroirCount: miroir.length, skip: true, raison: 'réponse VIDE alors que le miroir a des docs' };
  }

  // 3) même règle que le sync (filtre nom+cible, dédup participant×doctype, statut)
  const statut = computeSignatureStatus(idAdf, fichiers);
  const att = statut.attestations;
  const clesDendreo = new Set(att.map((a) => `${a.idParticipant}_${a.doctypeId}`));

  // 4) CLASSIFICATION AU NIVEAU DE LA CLÉ {idParticipant}_{doctypeId} — S17.2.
  // Le participant n'entre PAS dans le critère : sur 2721, les 4 écarts portaient sur
  // des participants toujours présents (seule la ligne PI_2026/doctype 177 avait été
  // retirée), et leurs attestations signées vivaient sous une AUTRE clé (doctype 172),
  // intacte. Juger au participant confondait ces deux niveaux.
  const absentes = miroir.filter((x) => !clesDendreo.has(`${x.idParticipant}_${x.doctypeId}`));
  // FANTÔME = clé absente de Dendreo ET status miroir 'pending'. Le compte principal.
  const fantomes = absentes.filter((x) => x.status === 'pending');
  // ANOMALIE = clé absente de Dendreo mais status 'signed'. Une attestation signée est
  // une preuve de conformité : on la SIGNALE, on ne la purge JAMAIS. Comptée à part,
  // jamais additionnée aux fantômes.
  const signedAbsents = absentes.filter((x) => x.status === 'signed');
  const nouveaux = att.filter((a) => !miroir.some((x) => `${x.idParticipant}_${x.doctypeId}` === `${a.idParticipant}_${a.doctypeId}`));

  // Signal : doctype du miroir hors liste de référence (ne change RIEN au calcul).
  const doctypesInconnus = [...new Set(miroir.map((x) => String(x.doctypeId)).filter((d) => !DOCTYPES_CONNUS.has(d)))];

  // Signal : réponse courte → on isole ce chiffre au lieu de le fondre dans le total.
  const suspect = miroir.length > 0 && att.length > 0 && att.length < miroir.length * RATIO_SUSPECT;

  return {
    idAdf,
    numeroComplet: session.numeroComplet ?? '',
    miroirCount: miroir.length,
    miroirPending: miroir.filter((x) => x.status === 'pending').length,
    dendreoCount: att.length,
    dendreoPending: att.filter((a) => a.status === 'pending').length,
    fantomes, // pending uniquement (à purger)
    signedAbsents, // signed absents de Dendreo (anomalies, jamais purgeables)
    nouveauxCount: nouveaux.length,
    ignoredLines: statut.ignored,
    doctypesInconnus,
    suspect,
  };
}

// --- main -------------------------------------------------------------------
async function main() {
  log('# S17.1 DIAG-FANTÔMES — DRY-RUN, LECTURE SEULE. 0 écriture, 0 suppression.');
  log(`# filtres : ${args.idAdfs ? `idAdfs=${args.idAdfs.join(',')}` : args.acheval ? 'sessions À CHEVAL' : 'TOUT le miroir'}` +
      `${args.from ? ` | from=${args.from}` : ''}${args.limit != null ? ` | limit=${args.limit}` : ''}` +
      ` | concurrence=${args.concurrency}${args.verbose ? ' | VERBOSE (contient des noms)' : ''}\n`);

  let sessions;
  try {
    sessions = await listerSessions();
  } catch (err) {
    if (isQuotaError(err)) {
      log('# ⚠ QUOTA Firestore atteint dès la liste des sessions → arrêt propre, rien analysé.');
      process.exit(0);
    }
    throw err;
  }

  // Ordre déterministe (idAdf croissant) : c'est ce qui rend --from fiable.
  sessions.sort((a, b) => Number(a.idAdf) - Number(b.idAdf) || String(a.idAdf).localeCompare(String(b.idAdf)));
  const total = sessions.length;
  if (args.from) sessions = sessions.filter((s) => Number(s.idAdf) >= Number(args.from));
  const apresFrom = sessions.length;
  if (args.limit != null && Number.isFinite(args.limit)) sessions = sessions.slice(0, args.limit);

  log(`# ${total} session(s) dans le périmètre` +
      `${args.from ? ` → ${apresFrom} après --from` : ''}` +
      ` → ${sessions.length} analysée(s) ce run (≈ ${sessions.length} appels Dendreo, ${sessions.length} requêtes Firestore)\n`);
  if (sessions.length === 0) { log('# Rien à analyser.'); return; }

  const entete = 'idAdf    | miroir | Dendreo | fantômes |';
  log(entete);
  log('-'.repeat(entete.length));

  const resultats = await pool(sessions, args.concurrency, async (s) => {
    const r = await analyserSession(s);
    if (r.quota) { log(`${String(r.idAdf).padEnd(8)} | ⚠ QUOTA FIRESTORE — arrêt`); return r; }
    if (r.skipped) return r;
    if (r.skip) {
      log(`${String(r.idAdf).padEnd(8)} | ${String(r.miroirCount ?? '?').padStart(6)} |       ? |     SKIP | ⛔ ${r.raison}`);
      return r;
    }
    const flags = [
      r.fantomes.length > 0 ? '👻' : '',
      r.signedAbsents.length > 0 ? `🚨 ${r.signedAbsents.length} SIGNÉE(S) absente(s) de Dendreo — ANOMALIE, ne pas purger` : '',
      r.suspect ? '⚠ réponse courte → bucket À VÉRIFIER' : '',
      r.nouveauxCount > 0 ? `+${r.nouveauxCount} chez Dendreo hors miroir` : '',
      r.ignoredLines > 0 ? `${r.ignoredLines} ligne(s) sans doctype_id` : '',
      r.doctypesInconnus.length ? `doctype(s) hors référence: ${r.doctypesInconnus.join(',')}` : '',
    ].filter(Boolean).join(' | ');
    log(`${String(r.idAdf).padEnd(8)} | ${String(r.miroirCount).padStart(6)} | ${String(r.dendreoCount).padStart(7)} | ${String(r.fantomes.length).padStart(8)} |${flags ? ' ' + flags : ''}`);
    if (args.verbose) {
      for (const f of r.fantomes) {
        log(`         ↳ 👻 ${val(f.nom).padEnd(28)} | ${String(f.status).padEnd(7)} | doctype=${String(f.doctypeId).padEnd(4)} | ${val(f.documentName)}`);
        log(`           clé=${f._id}  sentDate=${val(f.sentDate)}  lastSyncedAt=${val(f.lastSyncedAt)}`);
      }
      for (const f of r.signedAbsents) {
        log(`         ↳ 🚨 ${val(f.nom).padEnd(28)} | ${String(f.status).padEnd(7)} | doctype=${String(f.doctypeId).padEnd(4)} | ${val(f.documentName)}`);
        log(`           clé=${f._id}  signé le ${val(f.signatureDate)}  ANOMALIE : signée au miroir, absente de Dendreo → NE PAS PURGER`);
      }
    }
    return r;
  });

  // --- TOTAUX ---------------------------------------------------------------
  const analysees = resultats.filter((r) => r && !r.skip && !r.skipped && !r.quota);
  const skips = resultats.filter((r) => r && r.skip);
  const nonTraitees = resultats.filter((r) => r && (r.skipped || r.quota));
  const surs = analysees.filter((r) => !r.suspect);
  const suspects = analysees.filter((r) => r.suspect);

  const somme = (arr, f) => arr.reduce((n, r) => n + f(r), 0);
  const fantSurs = somme(surs, (r) => r.fantomes.length);
  const fantSuspects = somme(suspects, (r) => r.fantomes.length);
  const signedAbsSurs = somme(surs, (r) => r.signedAbsents.length);
  const signedAbsSuspects = somme(suspects, (r) => r.signedAbsents.length);

  log(`\n${'#'.repeat(78)}`);
  log('# TOTAUX — RECENSEMENT (aucune suppression effectuée)');
  log('#'.repeat(78));
  log(`  sessions analysées            : ${analysees.length}`);
  log(`  sessions SKIP (douteuses)     : ${skips.length}   ← aucun fantôme compté pour elles`);
  if (nonTraitees.length) log(`  sessions non traitées (quota) : ${nonTraitees.length}`);
  log(`  appels Dendreo consommés      : ${appelsDendreo}`);

  log('\n  --- FANTÔMES PENDING (clé absente de Dendreo + status pending) → À PURGER ---');
  log(`  TOTAL fantômes pending (sûrs)         : ${fantSurs}`);
  log(`  sessions touchées (≥1 fantôme, sûres) : ${surs.filter((r) => r.fantomes.length > 0).length} / ${surs.length}`);
  if (suspects.length) {
    log(`\n  ⚠ bucket À VÉRIFIER (réponse Dendreo < ${RATIO_SUSPECT * 100}% du miroir) :`);
    log(`     ${suspects.length} session(s), ${fantSuspects} fantôme(s) pending potentiel(s)` +
        `${signedAbsSuspects ? ` + ${signedAbsSuspects} signée(s) absente(s)` : ''}`);
    log(`     NON inclus dans le total sûr. À trancher session par session avant toute purge.`);
    log(`     → ${suspects.map((r) => r.idAdf).slice(0, 30).join(', ')}${suspects.length > 30 ? ` … (+${suspects.length - 30})` : ''}`);
  }
  log(`\n  Fourchette purgeable : ${fantSurs} (sûrs) à ${fantSurs + fantSuspects} (avec le bucket à vérifier)`);

  log('\n  --- SIGNÉES ABSENTES DE DENDREO → ANOMALIES, JAMAIS PURGER ---');
  log(`  TOTAL signées absentes (sûres)        : ${signedAbsSurs}`);
  log(`  sessions touchées                     : ${surs.filter((r) => r.signedAbsents.length > 0).length}`);
  if (signedAbsSurs > 0) {
    log('  ⚠ Une attestation SIGNÉE au miroir mais absente de Dendreo est une preuve de');
    log('    conformité qui a disparu de la source. À EXAMINER (jamais à supprimer) :');
    for (const r of surs.filter((x) => x.signedAbsents.length > 0).slice(0, 20)) {
      log(`     idAdf=${String(r.idAdf).padEnd(7)} : ${r.signedAbsents.length} signée(s) absente(s)` +
          ` — doctype(s) ${[...new Set(r.signedAbsents.map((f) => String(f.doctypeId)))].join(',')}` +
          `   (détail nominatif avec --verbose)`);
    }
  } else {
    log('  ✅ aucune — aucune signature n\'a disparu de la source sur ce périmètre.');
  }

  log('\n  --- IMPACT RELANCE ---');
  log(`  pending au MIROIR   : ${somme(analysees, (r) => r.miroirPending)}`);
  log(`  pending chez DENDREO: ${somme(analysees, (r) => r.dendreoPending)}`);
  const ecart = somme(analysees, (r) => r.miroirPending) - somme(analysees, (r) => r.dendreoPending);
  log(`  → écart : ${ecart > 0 ? `le dashboard sur-relance ${ecart} attestation(s)` : ecart === 0 ? 'aucun' : `le dashboard sous-compte ${-ecart}`}`);

  const autres = {
    nouveaux: somme(analysees, (r) => r.nouveauxCount),
    ignored: somme(analysees, (r) => r.ignoredLines),
    doctypes: [...new Set(analysees.flatMap((r) => r.doctypesInconnus))],
  };
  log('\n  --- AUTRES SIGNAUX ---');
  log(`  attestations chez Dendreo absentes du miroir (sync en retard) : ${autres.nouveaux}`);
  log(`  lignes Dendreo ignorées (doctype_id vide)                     : ${autres.ignored}`);
  log(`  doctypes du miroir hors référence {${[...DOCTYPES_CONNUS].join(',')}} : ${autres.doctypes.length ? autres.doctypes.join(', ') : 'aucun'}`);

  if (skips.length) {
    log('\n  --- DÉTAIL DES SKIPS (réponses douteuses, à re-tester) ---');
    for (const s of skips.slice(0, 40)) log(`   idAdf=${String(s.idAdf).padEnd(7)} miroir=${String(s.miroirCount ?? '?').padStart(4)} : ${s.raison}`);
    if (skips.length > 40) log(`   … (+${skips.length - 40} autres)`);
  }

  if (quotaHit) {
    // Reprise = la plus petite session NON aboutie : celles marquées skipped/quota,
    // MAIS AUSSI celles que le pool n'a jamais piochées (trous `undefined` du tableau).
    const abouties = new Set(analysees.concat(skips).map((r) => String(r.idAdf)));
    const restants = sessions.map((s) => Number(s.idAdf)).filter((n) => Number.isFinite(n) && !abouties.has(String(n)));
    const reprise = restants.length ? Math.min(...restants) : null;
    log(`\n# ⚠ QUOTA FIRESTORE ATTEINT → arrêt propre. Les chiffres ci-dessus sont PARTIELS.`);
    if (reprise) log(`# Reprise (quota réinitialisé ~9h Paris) :  npx tsx scripts/diag-fantomes.mjs --from=${reprise}${args.limit != null ? ` --limit=${args.limit}` : ''}${args.acheval ? ' --acheval' : ''}`);
    log('# FIN — 0 écriture, 0 suppression, rien commité.');
    process.exit(0);
  }

  const dernier = analysees.concat(skips).map((r) => Number(r.idAdf)).filter(Number.isFinite);
  if (args.limit != null && sessions.length === args.limit && dernier.length) {
    log(`\n# Limite atteinte. Suite :  npx tsx scripts/diag-fantomes.mjs --from=${Math.max(...dernier) + 1} --limit=${args.limit}${args.acheval ? ' --acheval' : ''}`);
  }
  log('\n# FIN — 0 écriture, 0 suppression, rien commité.');
}

main().catch((err) => {
  if (isQuotaError(err)) {
    log(`# ⚠ QUOTA Firestore → arrêt propre. Appels Dendreo consommés : ${appelsDendreo}`);
    process.exit(0);
  }
  log(`!! diag-fantomes interrompu : ${shortReason(err)}`);
  process.exit(1);
});
