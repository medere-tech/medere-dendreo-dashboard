// scripts/purge-fantomes.mjs — S17.3 : PURGE des fantômes. DRY-RUN PAR DÉFAUT.
// -----------------------------------------------------------------------------
// Détection IDENTIQUE à diag-fantomes.mjs (S17.1/S17.2) : même endpoint, même règle
// sync (computeSignatureStatus), même classification AU NIVEAU DE LA CLÉ.
// La seule différence : avec --execute, ce script SUPPRIME les fantômes pending.
//
// ┌── CRITÈRE DE SUPPRESSION (verrouillé) ────────────────────────────────────┐
// │ Supprimer signatures/{idAdf}_{idParticipant}_{doctypeId} SI ET SEULEMENT  │
// │   (1) la clé est ABSENTE de la réponse fichiers.php de la session, ET     │
// │   (2) le status au miroir === 'pending'.                                  │
// │                                                                           │
// │ JAMAIS un 'signed', même absent de Dendreo : une attestation signée est   │
// │ une PREUVE DE CONFORMITÉ. Disparue de la source, c'est une ANOMALIE à     │
// │ signaler — jamais à effacer. Le critère ne regarde ni le participant, ni  │
// │ l'assiduité, ni l'inscription : uniquement la clé et le statut.           │
// └───────────────────────────────────────────────────────────────────────────┘
//
// GARDE-FOUS :
//  • --dry-run est le DÉFAUT. Sans --execute : rien n'est supprimé, tout est listé.
//  • Réponse Dendreo douteuse → SKIP la session, AUCUNE suppression. DEUX familles :
//    (A) INCONDITIONNELS — rien ne les neutralise, jamais :
//      - appel KO (HTTP != 200, réseau, non-JSON) ;
//      - réponse non-tableau ;
//      - miroir Firestore illisible.
//        Une réponse qu'on n'a pas eue ne prouve RIEN : on ne peut pas en conclure
//        qu'un document a disparu.
//    (B) VOLUMÉTRIQUE — appel RÉUSSI, réponse bien formée, mais moins peuplée que
//        le miroir (réponse VIDE, ou < 50% des docs du miroir) :
//      - par défaut → SKIP (hoquet Dendreo probable) ;
//      - avec --force-skip (S17.3b) → session traitée quand même. RÉSERVÉ au manuel,
//        après vérification dans Dendreo ; exige --idAdfs, refusé avec --acheval,
//        refusé en run global. JAMAIS utilisé par le cron.
//  • --force-skip ne touche QUE ce seuil. Le CRITÈRE de suppression (clé absente ET
//    status pending, jamais un signed) est strictement le même, forcé ou pas.
//  • --execute sur TOUT le parc (sans --idAdfs/--acheval/--limit/--from) exige EN PLUS
//    --confirme-tout : une purge globale est irréversible, elle ne doit pas partir
//    d'une faute de frappe.
//  • Chaque suppression est loggée (idAdf, clé, nom, documentName) pour audit.
//  • Après suppression sur une session : recalcSessionCounts → compteurs du cockpit
//    justes (c'est ce qui corrige l'affichage de Justine).
//  • Quota Firestore (RESOURCE_EXHAUSTED) → arrêt propre exit 0 + commande de reprise.
//
// ÉCRITURES : uniquement avec --execute, uniquement vers NOTRE Firestore
// (suppression de docs `signatures` + recalcul `counts`). ZÉRO écriture Dendreo.
// La suppression Firestore est IRRÉVERSIBLE : pas d'undo, pas de corbeille.
//
// Usage :
//   npx tsx scripts/purge-fantomes.mjs --idAdfs=3129,3094            (dry-run)
//   npx tsx scripts/purge-fantomes.mjs --acheval --limit=50 --verbose (dry-run)
//   npx tsx scripts/purge-fantomes.mjs --idAdfs=3094 --execute        (SUPPRIME)
//
// Session SKIPPÉE par le seuil volumétrique (S17.3b) — après avoir OUVERT la session
// dans Dendreo et constaté qu'elle n'a réellement plus d'attestation :
//   npx tsx scripts/purge-fantomes.mjs --idAdfs=3534 --force-skip              (simule le forçage)
//   npx tsx scripts/purge-fantomes.mjs --idAdfs=3534 --force-skip --execute    (SUPPRIME)
//
// LOGS — SANS PII (S17.3c, aligné sur le cron S17.4b) : ni nom de participant, ni nom
// de document. Chaque ligne porte idAdf + la clé {idAdf}_{idParticipant}_{doctypeId}
// + doctype + status — assez pour auditer et retrouver la personne dans Dendreo,
// sans qu'un copier-coller de la sortie (ticket, Slack, capture) ne divulgue d'identité.
// -----------------------------------------------------------------------------

import { DENDREO, loadDendreoEnv } from '../src/config';
import { DendreoClient } from '../src/dendreo/client';
import { computeSignatureStatus } from '../src/dendreo/signatures';
import { getDb } from '../src/firebase/admin';
import { recalcSessionCounts } from '../src/firebase/firestore';

const RATIO_SUSPECT = 0.5; // Dendreo < 50% du miroir → SKIP (réponse partielle probable)
const CONCURRENCY_DEFAUT = 3; // plus prudent qu'en diag : ce script écrit

// --- args -------------------------------------------------------------------
function parseArgs(argv) {
  const a = {
    idAdfs: null, acheval: false, limit: null, from: null,
    execute: false, confirmeTout: false, forceSkip: false, verbose: false, concurrency: CONCURRENCY_DEFAUT,
  };
  const value = (t, name, i) => (t.startsWith(`--${name}=`) ? t.slice(name.length + 3) : argv[i + 1]);
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--acheval') a.acheval = true;
    else if (t === '--execute') a.execute = true;
    else if (t === '--confirme-tout') a.confirmeTout = true;
    else if (t === '--force-skip') a.forceSkip = true; // S17.3b : opt-in, exige --idAdfs
    else if (t === '--dry-run') a.execute = false; // explicite, mais c'est déjà le défaut
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
const val = (v) => (v === null || v === undefined || String(v).trim() === '' ? '—' : String(v));
const shortReason = (err) => String(err && err.message ? err.message : err).replace(/\s+/g, ' ').slice(0, 160);

function isQuotaError(err) {
  const code = err && err.code;
  const msg = String((err && err.message) || '');
  return code === 8 || /RESOURCE_EXHAUSTED|Quota exceeded/i.test(msg);
}

let quotaHit = false;
let appelsDendreo = 0;

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

async function listerSessions() {
  const col = getDb().collection('sessions');
  if (args.idAdfs) {
    const snaps = await Promise.all(args.idAdfs.map((id) => col.doc(id).get()));
    return snaps.filter((s) => s.exists).map((s) => ({ idAdf: s.id, ...s.data() }));
  }
  let q = col;
  if (args.acheval) q = q.where('aCheval', '==', true);
  const snap = await q.get();
  return snap.docs.map((d) => ({ idAdf: d.id, ...d.data() }));
}

// --- traitement d'une session ------------------------------------------------
async function traiterSession(session) {
  if (quotaHit) return { idAdf: session.idAdf, skipped: true };
  const idAdf = String(session.idAdf);

  // 1) miroir — on garde la RÉFÉRENCE du doc : on supprimera exactement ce qu'on a lu,
  //    jamais une clé reconstruite (aucun risque de viser un autre document).
  let miroir;
  try {
    const snap = await getDb().collection('signatures').where('idAdf', '==', idAdf).get();
    miroir = snap.docs.map((d) => ({ _id: d.id, _ref: d.ref, ...d.data() }));
  } catch (err) {
    if (isQuotaError(err)) { quotaHit = true; return { idAdf, quota: true }; }
    return { idAdf, skip: true, raison: `miroir illisible : ${shortReason(err)}` };
  }

  // 2) Dendreo — 1 appel, exactement celui du sync.
  let brut;
  try {
    appelsDendreo += 1;
    brut = await client.get('fichiers.php', {
      cible: DENDREO.CIBLE_ADF,
      id_cible: idAdf,
      collection_name: DENDREO.COLLECTION_SIGNATURE,
    });
  // --- GARDE-FOUS (A) : INCONDITIONNELS -------------------------------------
  // --force-skip ne les neutralise JAMAIS. Un appel qui échoue ou une réponse
  // illisible ne prouve RIEN sur l'état réel de la session : on ne peut pas
  // conclure qu'un document a disparu à partir d'une réponse qu'on n'a pas eue.
  } catch (err) {
    return { idAdf, miroirCount: miroir.length, skip: true, raison: `appel Dendreo KO : ${shortReason(err)}` };
  }
  if (!Array.isArray(brut)) {
    return { idAdf, miroirCount: miroir.length, skip: true, raison: `réponse non-tableau (${typeof brut})` };
  }
  const fichiers = brut;

  // 3) règle sync + classification niveau CLÉ (S17.2)
  const statut = computeSignatureStatus(idAdf, fichiers);
  const att = statut.attestations;
  const clesDendreo = new Set(att.map((a) => `${a.idParticipant}_${a.doctypeId}`));

  // --- GARDE-FOU (B) : VOLUMÉTRIE — le SEUL que --force-skip neutralise ------
  // Ici l'appel a RÉUSSI et la réponse est bien formée : elle est juste moins
  // peuplée que le miroir. Deux lectures possibles, indiscernables depuis le code :
  //   • hoquet Dendreo (réponse tronquée) → purger viderait la session à tort ;
  //   • les documents ont réellement disparu → ce sont de vrais fantômes.
  // Par défaut on tranche pour la prudence (SKIP). Seul un opérateur qui a OUVERT
  // la session dans Dendreo peut trancher pour l'autre lecture : c'est --force-skip
  // (manuel, --idAdfs obligatoire, jamais le cron).
  const reponseVide = fichiers.length === 0 && miroir.length > 0;
  const reponsePartielle = miroir.length > 0 && att.length < miroir.length * RATIO_SUSPECT;
  let force = false;
  if (reponseVide || reponsePartielle) {
    const raison = reponseVide
      ? 'réponse VIDE alors que le miroir a des docs'
      : `réponse partielle probable : ${att.length} attestation(s) Dendreo vs ${miroir.length} au miroir (< ${RATIO_SUSPECT * 100}%)`;
    if (!args.forceSkip) {
      return { idAdf, miroirCount: miroir.length, dendreoCount: att.length, skip: true, raison };
    }
    // Trace SANS PII : idAdf + volumétrie + raison technique. Le critère de
    // suppression ci-dessous, lui, n'est PAS touché (pending only, jamais un signed).
    force = true;
    log(`  [PURGE FORCE-SKIP] idAdf=${idAdf} — seuil volumétrique neutralisé (${raison}) — appel Dendreo OK, critère pending/signed INCHANGÉ`);
  }

  const absentes = miroir.filter((x) => !clesDendreo.has(`${x.idParticipant}_${x.doctypeId}`));
  const fantomes = absentes.filter((x) => x.status === 'pending'); // ← LES SEULS SUPPRIMABLES
  const signedAbsents = absentes.filter((x) => x.status !== 'pending'); // signalés, jamais touchés

  // 4) suppression (ou simulation)
  let supprimes = 0;
  const echecs = [];
  for (const f of fantomes) {
    // Ceinture et bretelles : on re-vérifie le critère sur CE doc juste avant d'agir.
    if (f.status !== 'pending' || clesDendreo.has(`${f.idParticipant}_${f.doctypeId}`)) {
      echecs.push({ cle: f._id, raison: 'critère non revérifié — non supprimé' });
      continue;
    }
    const trace = `idAdf=${idAdf} clé=${f._id} | doctype=${val(f.doctypeId)} | status=pending`;
    if (!args.execute) {
      log(`  [DRY-RUN] à supprimer : ${trace}`);
      supprimes += 1;
      continue;
    }
    try {
      await f._ref.delete();
      log(`  [SUPPRIMÉ] ${trace}`);
      supprimes += 1;
    } catch (err) {
      if (isQuotaError(err)) { quotaHit = true; return { idAdf, quota: true, supprimes, fantomes, signedAbsents, miroirCount: miroir.length, dendreoCount: att.length }; }
      echecs.push({ cle: f._id, raison: shortReason(err) });
      log(`  [ÉCHEC] ${trace} → ${shortReason(err)}`);
    }
  }

  // 5) recalcul des counts — seulement si on a réellement supprimé.
  let recalc = null;
  if (args.execute && supprimes > 0) {
    try {
      const { counts } = await recalcSessionCounts(idAdf);
      recalc = counts;
      log(`  [COUNTS] idAdf=${idAdf} → envoyes=${counts.envoyes} signes=${counts.signes} nonSignes=${counts.nonSignes} aRelancer=${counts.participantsARelancer}`);
    } catch (err) {
      if (isQuotaError(err)) { quotaHit = true; return { idAdf, quota: true, supprimes, fantomes, signedAbsents, miroirCount: miroir.length, dendreoCount: att.length }; }
      log(`  [COUNTS ÉCHEC] idAdf=${idAdf} : ${shortReason(err)} — compteurs à recalculer au prochain sync`);
    }
  }

  return {
    idAdf,
    miroirCount: miroir.length,
    dendreoCount: att.length,
    fantomes,
    signedAbsents,
    supprimes,
    echecs,
    recalc,
    force, // S17.3b : session traitée grâce à --force-skip (seuil volumétrique neutralisé)
  };
}

// --- main -------------------------------------------------------------------
async function main() {
  const mode = args.execute ? 'EXECUTE (SUPPRESSION RÉELLE)' : 'DRY-RUN (aucune suppression)';
  log(`# S17.3 PURGE-FANTÔMES — mode=${mode}`);
  log('# Critère : clé absente de Dendreo ET status miroir === pending. JAMAIS un signed.');
  log(`# filtres : ${args.idAdfs ? `idAdfs=${args.idAdfs.join(',')}` : args.acheval ? 'sessions À CHEVAL' : 'TOUT le miroir'}` +
      `${args.from ? ` | from=${args.from}` : ''}${args.limit != null ? ` | limit=${args.limit}` : ''}` +
      ` | concurrence=${args.concurrency}${args.forceSkip ? ' | FORCE-SKIP' : ''}${args.verbose ? ' | VERBOSE' : ''}`);

  // --- S17.3b : recevabilité de --force-skip --------------------------------
  // Neutraliser le seuil volumétrique n'est légitime QUE sur des sessions que
  // l'opérateur vient d'ouvrir dans Dendreo une par une. Donc : périmètre nommé
  // obligatoire, aucun forçage en masse.
  if (args.forceSkip && !args.idAdfs) {
    log('\n⛔ REFUS : --force-skip exige --idAdfs=... (liste explicite de sessions).');
    log('   Ce flag neutralise le garde-fou qui protège d\'un hoquet Dendreo : il ne se justifie');
    log('   QUE session par session, après vérification manuelle dans Dendreo. Jamais en masse.');
    process.exit(1);
  }
  if (args.forceSkip && args.acheval) {
    log('\n⛔ REFUS : --force-skip est incompatible avec --acheval (périmètre non nommé).');
    log('   Cible les sessions vérifiées une par une : --idAdfs=3534,3129');
    process.exit(1);
  }

  const nonCible = !args.idAdfs && !args.acheval && args.limit == null && !args.from;
  if (args.execute && nonCible && !args.confirmeTout) {
    log('\n⛔ REFUS : --execute sur TOUT le parc sans périmètre.');
    log('   Une purge globale est IRRÉVERSIBLE. Ajoute un périmètre (--idAdfs / --acheval / --limit / --from),');
    log('   ou, si la purge totale est bien voulue, ajoute --confirme-tout.');
    process.exit(1);
  }
  if (args.execute) {
    log('\n⚠ SUPPRESSION RÉELLE ACTIVÉE — les docs supprimés ne sont PAS récupérables.');
  } else {
    log('\nℹ DRY-RUN : rien ne sera supprimé. Ajouter --execute pour agir.');
  }
  if (args.forceSkip) {
    log('\n⚠ --FORCE-SKIP : le garde-fou volumétrique (réponse Dendreo vide ou < 50 % du miroir)');
    log('   est NEUTRALISÉ sur les sessions ciblées. Tu affirmes avoir VÉRIFIÉ dans Dendreo qu\'elles');
    log('   n\'ont réellement plus d\'attestation. Restent actifs et non contournables :');
    log('     • appel Dendreo KO / réponse illisible → SKIP ;   • miroir illisible → SKIP ;');
    log('     • critère de suppression : clé absente ET status pending — JAMAIS un signed.');
    if (!args.execute) log('   (dry-run : les sessions forcées sont listées, rien n\'est supprimé)');
  }
  log('');

  let sessions;
  try {
    sessions = await listerSessions();
  } catch (err) {
    if (isQuotaError(err)) { log('# ⚠ QUOTA Firestore dès la liste des sessions → arrêt propre, rien fait.'); process.exit(0); }
    throw err;
  }

  sessions.sort((a, b) => Number(a.idAdf) - Number(b.idAdf) || String(a.idAdf).localeCompare(String(b.idAdf)));
  const total = sessions.length;
  if (args.from) sessions = sessions.filter((s) => Number(s.idAdf) >= Number(args.from));
  const apresFrom = sessions.length;
  if (args.limit != null && Number.isFinite(args.limit)) sessions = sessions.slice(0, args.limit);

  log(`# ${total} session(s) dans le périmètre${args.from ? ` → ${apresFrom} après --from` : ''}` +
      ` → ${sessions.length} traitée(s) ce run (≈ ${sessions.length} appels Dendreo)\n`);
  if (sessions.length === 0) { log('# Rien à traiter.'); return; }

  const resultats = await pool(sessions, args.concurrency, async (s) => {
    const r = await traiterSession(s);
    if (r.quota) { log(`idAdf=${r.idAdf} : ⚠ QUOTA FIRESTORE — arrêt`); return r; }
    if (r.skipped) return r;
    if (r.skip) { log(`idAdf=${String(r.idAdf).padEnd(7)} ⛔ SKIP — ${r.raison} (aucune suppression)`); return r; }
    const resume = `idAdf=${String(r.idAdf).padEnd(7)} miroir=${String(r.miroirCount).padStart(3)} dendreo=${String(r.dendreoCount).padStart(3)}` +
      ` fantômes=${String(r.fantomes.length).padStart(3)} ${args.execute ? 'supprimés' : 'à supprimer'}=${r.supprimes}` +
      `${r.force ? ' | ⚠ FORCÉE (seuil neutralisé)' : ''}` +
      `${r.signedAbsents.length ? ` | 🚨 ${r.signedAbsents.length} SIGNÉE(S) absente(s) — NON touchée(s)` : ''}`;
    if (r.fantomes.length || r.signedAbsents.length || r.force || args.verbose) log(resume);
    if (r.signedAbsents.length) {
      for (const f of r.signedAbsents) {
        log(`  [ANOMALIE — NON SUPPRIMÉE] idAdf=${r.idAdf} clé=${f._id} | doctype=${val(f.doctypeId)} | status=${val(f.status)}`);
      }
    }
    return r;
  });

  // --- TOTAUX ---------------------------------------------------------------
  const traitees = resultats.filter((r) => r && !r.skip && !r.skipped && !r.quota);
  const skips = resultats.filter((r) => r && r.skip);
  const somme = (arr, f) => arr.reduce((n, r) => n + f(r), 0);
  const totalSupprimes = somme(traitees, (r) => r.supprimes);
  const totalSignedAbs = somme(traitees, (r) => r.signedAbsents.length);
  const totalEchecs = somme(traitees, (r) => (r.echecs ? r.echecs.length : 0));
  const recalcs = traitees.filter((r) => r.recalc).length;

  log(`\n${'#'.repeat(78)}`);
  log(`# TOTAUX — ${mode}`);
  log('#'.repeat(78));
  log(`  sessions traitées                    : ${traitees.length}`);
  log(`  sessions SKIP (réponse douteuse)     : ${skips.length}   ← aucune suppression`);
  log(`  appels Dendreo consommés             : ${appelsDendreo}`);
  log(`\n  fantômes pending ${args.execute ? 'SUPPRIMÉS         ' : 'qui seraient supprimés'} : ${totalSupprimes}`);
  log(`  sessions touchées                    : ${traitees.filter((r) => r.supprimes > 0).length}`);
  log(`  recalculs counts effectués           : ${recalcs}${!args.execute ? `   (dry-run : ${traitees.filter((r) => r.supprimes > 0).length} auraient lieu)` : ''}`);
  log(`\n  🚨 signées absentes de Dendreo        : ${totalSignedAbs}   ← JAMAIS touchées (anomalies à examiner)`);
  if (totalEchecs) log(`  ❌ suppressions en échec              : ${totalEchecs}`);
  if (args.forceSkip) {
    const forcees = traitees.filter((r) => r.force);
    log(`\n  ⚠ sessions FORCÉES (--force-skip)     : ${forcees.length}   ← seuil volumétrique neutralisé après vérif manuelle`);
    for (const f of forcees) log(`      idAdf=${f.idAdf} : miroir=${f.miroirCount} dendreo=${f.dendreoCount} → ${args.execute ? 'supprimés' : 'à supprimer'}=${f.supprimes}`);
  }

  if (skips.length) {
    log('\n  --- SKIPS (à re-tester, rien supprimé) ---');
    for (const s of skips.slice(0, 40)) log(`   idAdf=${String(s.idAdf).padEnd(7)} : ${s.raison}`);
    if (skips.length > 40) log(`   … (+${skips.length - 40} autres)`);
  }

  if (quotaHit) {
    const abouties = new Set(traitees.concat(skips).map((r) => String(r.idAdf)));
    const restants = sessions.map((s) => Number(s.idAdf)).filter((n) => Number.isFinite(n) && !abouties.has(String(n)));
    const reprise = restants.length ? Math.min(...restants) : null;
    log('\n# ⚠ QUOTA FIRESTORE ATTEINT → arrêt propre. Le travail déjà fait est valide (idempotent).');
    if (reprise) {
      log(`# Reprise :  npx tsx scripts/purge-fantomes.mjs --from=${reprise}` +
          `${args.limit != null ? ` --limit=${args.limit}` : ''}${args.acheval ? ' --acheval' : ''}${args.execute ? ' --execute' : ''}`);
    }
    log(`# FIN — ${args.execute ? `${totalSupprimes} suppression(s) effectuée(s)` : '0 suppression (dry-run)'}, rien commité.`);
    process.exit(0);
  }

  if (!args.execute && totalSupprimes > 0) {
    log(`\n# DRY-RUN : rien n'a été supprimé. Pour agir sur ce même périmètre, rejouer avec --execute.`);
  }
  log(`\n# FIN — ${args.execute ? `${totalSupprimes} suppression(s) effectuée(s), ${recalcs} recalcul(s) counts` : '0 suppression (dry-run)'}. 0 écriture Dendreo, rien commité.`);
}

main().catch((err) => {
  if (isQuotaError(err)) { log(`# ⚠ QUOTA Firestore → arrêt propre. Appels Dendreo : ${appelsDendreo}`); process.exit(0); }
  log(`!! purge-fantomes interrompu : ${shortReason(err)}`);
  process.exit(1);
});
