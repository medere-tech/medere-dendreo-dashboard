// scripts/backfill.mjs — Backfill historique Dendreo → Firestore (S2.2).
// LECTURE SEULE côté Dendreo ; écriture uniquement vers NOTRE Firestore.
// Lancé via tsx :  npm run backfill -- [--dry-run] [--year YYYY] [--limit N] [--force]
//
// - Découvre la 1re année en scannant chaque année (année courante → plancher 2015),
//   SANS early-stop, sans hardcoder de date de fondation.
// - COUVERTURE = CHEVAUCHEMENT : par année, on prend les sessions qui COMMENCENT
//   OU qui FINISSENT dans l'année (started_* ∪ ended_*), dédupliquées par idAdf
//   (inter-années aussi). Corrige le trou des sessions "à cheval entrantes"
//   (début avant la période, fin dedans) que le filtre par début seul ratait.
// - Par session : getSessionSignatureStatus (S1) → upsertSession + upsertSignature(s)
//   + recalcSessionCounts (transaction). Idempotent (rejouer = aucun doublon).
// - Reprenable via _meta/backfill.yearsProcessed (sauf --force).
// - Résilient (une session en échec n'arrête pas le run), pacing concurrence 5,
//   arrêt propre sur quota Firestore (RESOURCE_EXHAUSTED), logs SANS PII.
// - S17.4 : --purge active la PURGE DES FANTÔMES (mêmes critère et garde-fous que
//   scripts/purge-fantomes.mjs, via la fonction partagée purgeGhostSignatures).
//   OPT-IN : sans le flag, comportement strictement inchangé. Seul le cron NOCTURNE
//   le passe (cf. .github/workflows/backfill-nightly.yml). Zéro appel Dendreo ajouté.
//   Ses logs sont SANS PII comme le reste du backfill (clé + doctype + status).

import { loadDendreoEnv, DENDREO } from '../src/config';
import { DendreoClient } from '../src/dendreo/client';
import { getSessionSignatureStatus } from '../src/dendreo/signatures';
import { deriveEligibleDpc, deriveNumeroCompteProduit, eppConnecte, extractDatesSynchrones, formatLabel, hasEpp, isACheval, parseHeures } from '../src/dendreo/enrich';
import { enrichFinancement, ensureAndpcValidated, loadCommerciauxReferentiel } from '../src/dendreo/financement';
import { purgeGhostSignatures } from '../src/dendreo/sync';
import { getDb } from '../src/firebase/admin';
import { recalcSessionCounts, upsertSession, upsertSignature } from '../src/firebase/firestore';

const FLOOR_YEAR = 2015;
const CONCURRENCY = 5;

// --- args -------------------------------------------------------------------
function parseArgs(argv) {
  const a = { dryRun: false, force: false, year: null, limit: null, purge: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--dry-run') a.dryRun = true;
    else if (t === '--purge') a.purge = true; // S17.4 : opt-in, jamais par défaut
    else if (t === '--force') a.force = true;
    else if (t === '--year') a.year = Number(argv[++i]);
    else if (t.startsWith('--year=')) a.year = Number(t.slice('--year='.length));
    else if (t === '--limit') a.limit = Number(argv[++i]);
    else if (t.startsWith('--limit=')) a.limit = Number(t.slice('--limit='.length));
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
const client = new DendreoClient(loadDendreoEnv());

// --- helpers ----------------------------------------------------------------
const log = (...m) => console.log(...m); // ids & compteurs uniquement, jamais de PII
const META_PATH = '_meta/backfill';

/** ISO naïf : espace -> "T". Pas de toISOString, pas de fuseau (cf. firestore-model §6).
 *  Les valeurs déjà ISO (dates fichiers.php en "...Z") sont laissées telles quelles. */
function normDate(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v);
  return s.includes(' ') ? s.replace(' ', 'T') : s;
}

function shortReason(err) {
  const msg = err && err.message ? String(err.message) : String(err);
  return msg.replace(/\s+/g, ' ').slice(0, 200); // pas de PII : ce sont des erreurs HTTP/SDK
}

function isQuotaError(err) {
  const code = err && err.code;
  const msg = String((err && err.message) || '');
  return code === 8 || /RESOURCE_EXHAUSTED|Quota exceeded/i.test(msg);
}

function asArray(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.data)) return json.data;
  return json == null ? [] : [json];
}

/** Pool de concurrence borné. Arrête de piocher si quotaHit. */
async function pool(items, size, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length && !quotaHit) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}

// --- état global ------------------------------------------------------------
let quotaHit = false;
let etapesMap = new Map();
let commerciauxRef = new Map(); // S13.1 : référentiel commerciaux, chargé 1× au démarrage (comme ANDPC)
// Dédup inter-années : une session à cheval (start année N, end année N+1) est
// listée par 2 années → on ne la traite qu'UNE fois, rattachée à sa 1re année
// rencontrée (ordre croissant). Upsert idempotent par idAdf de toute façon.
const processedIds = new Set();

// --- mappers ----------------------------------------------------------------
function mapSession(s) {
  const id = String(s.id_action_de_formation);
  const idEtape = String(s.id_etape_process ?? '');
  // N° session DPC & compte produit : optionnels côté Dendreo → null si vide/absent
  // (sessions non-DPC). Jamais '' stocké.
  const dpcRaw = s.num_session_dpc == null ? '' : String(s.num_session_dpc).trim();
  const numeroSessionDpc = dpcRaw === '' ? null : dpcRaw;
  const compteRaw = s.numero_comptable == null ? '' : String(s.numero_comptable).trim();
  const numeroCompteProduit = compteRaw === '' ? null : compteRaw; // provisoire ; corrigé par les modules (cf. processSession)
  // Dates "molles" : '' si absentes (jamais null) → la session s'écrit toujours.
  const dateDebut = normDate(s.date_debut) ?? '';
  const dateFin = normDate(s.date_fin) ?? '';
  return {
    idAdf: id,
    numeroComplet: s.numero_complet ?? `ADF_${id}`,
    numeroSessionDpc,
    numeroCompteProduit,
    intitule: s.intitule ?? '(sans intitulé)',
    dateDebut,
    dateFin,
    idEtapeProcess: idEtape,
    etape: etapesMap.get(idEtape) ?? `etape_${idEtape || '?'}`,
    idCentre: String(s.id_centre_de_formation ?? ''),
    type: s.type ?? '',
    totalParticipants: Number(s.total_participants ?? 0) || 0,
    // Enrichissement S5.1b : format + aCheval sont ADF-only (aucune lecture module) ;
    // eppAmontConnecte/eppAvalConnecte + numeroCompteProduit corrigé = fixés dans
    // processSession après lecture des modules (cf. enrichWithModules).
    format: formatLabel(s.mode_organisation),
    // Transient (S12.1) : mode_organisation BRUT de la session, consommé par
    // enrichWithModules pour datesSynchrones puis SUPPRIMÉ avant écriture (jamais dans le doc).
    modeOrganisation: String(s.mode_organisation ?? ''),
    aCheval: isACheval(dateDebut, dateFin),
    eppAmontConnecte: false,
    eppAvalConnecte: false,
    eligibleDpc: false, // provisoire → fixé par enrichWithModules
    aEpp: false, // provisoire → fixé par enrichWithModules
    datesSynchrones: [], // S12.1 : provisoire → fixé par enrichWithModules (défaut sûr si lecture LAM KO)
    // S11.1 : défauts sûrs → la session valide même si enrichFinancement échoue ;
    // écrasés dans processSession par le résultat réel (cf. Object.assign).
    financeurAndpc: false,
    montantAndpc: null,
    factureDateEnvoi: null,
    factureMontantHt: null,
    factureDatePaiement: null,
    // S15 : facture 1/2 (sessions à cheval) — défauts sûrs, écrasés par enrichFinancement.
    facture1DateEnvoi: null,
    facture1DatePaiement: null,
    facture2DateEnvoi: null,
    facture2DatePaiement: null,
  };
}

/** LAM d'une session (1 lecture : lams.php?include=module,creneaux) → porte modules
 *  ET créneaux synchrones (S12.1). Aucune lecture Dendreo en plus qu'avant. */
async function fetchSessionLams(idAdf) {
  return asArray(await client.get('lams.php', { id_action_de_formation: idAdf, include: 'module,creneaux' }));
}

/** Vue modules (dédupliquée par id_module) pour enrich.ts. */
function toModuleViews(lams) {
  const out = [];
  const seen = new Set();
  for (const l of lams) {
    const m = l.module;
    if (!m || !m.id_module || seen.has(String(m.id_module))) continue;
    seen.add(String(m.id_module));
    out.push({
      categorie: String(m.id_categorie_module ?? ''),
      heuresConnectees: parseHeures(m.c_nombre_dheures_connectees),
      numProgrammeDpc: String(m.num_programme_dpc ?? '').trim(),
      eligibleDpc: String(m.eligible_dpc ?? '').trim(),
    });
  }
  return out;
}

/**
 * Enrichit la session par les MODULES (mutation en place) : eppAmont/AvalConnecte
 * + numeroCompteProduit corrigé (module cœur si l'ADF n'a pas numero_comptable).
 * Une lecture module KO ne perd JAMAIS la session : on garde les valeurs ADF-only.
 */
async function enrichWithModules(session) {
  try {
    const lams = await fetchSessionLams(session.idAdf);
    const mods = toModuleViews(lams);
    session.eppAmontConnecte = eppConnecte(mods, 'amont');
    session.eppAvalConnecte = eppConnecte(mods, 'aval');
    session.aEpp = hasEpp(mods);
    session.eligibleDpc = deriveEligibleDpc(mods);
    session.datesSynchrones = extractDatesSynchrones(lams, session.modeOrganisation); // S12.1 : règle niveau session
    // deriveNumeroCompteProduit garde l'ADF s'il est renseigné (session.numeroCompteProduit
    // non-null), sinon prend le num du module cœur.
    session.numeroCompteProduit = deriveNumeroCompteProduit(session.numeroCompteProduit, mods);
    return { modulesRead: 1 };
  } catch (err) {
    log(`  ! modules illisibles idAdf=${session.idAdf} (enrichissement partiel) : ${shortReason(err)}`);
    return { modulesRead: 0 };
  }
}

// entry = AttestationLine (dates déjà normalisées ISO|null par signatures.ts).
function mapSig(a, session, financeurAndpc, commercial, parcours) {
  return {
    idAdf: session.idAdf,
    idParticipant: String(a.idParticipant),
    doctypeId: String(a.doctypeId),
    documentName: a.documentName,
    nom: a.nom && a.nom.trim() ? a.nom : '—',
    status: a.status, // "signed" | "pending"
    signatureDate: a.signatureDate ?? null,
    sentDate: a.sentDate ?? null,
    viewerUrl: a.viewerUrl ?? null,
    financeurAndpc: financeurAndpc ?? null, // S11.1 : true=ANDPC | false=autre | null=aucun
    commercial: commercial ?? null, // S13.1 : "Prénom NOM" du commercial de l'inscription
    assidu: parcours ? parcours.assidu : null, // S14 : laps absent/KO → null (inconnu), jamais false
    inscrit: parcours ? parcours.inscrit : null, // S14 : idem
    sessionNumeroComplet: session.numeroComplet,
    sessionIntitule: session.intitule,
    sessionDateDebut: session.dateDebut,
  };
}

// --- Dendreo reads ----------------------------------------------------------
async function fetchEtapesMap() {
  try {
    const json = await client.get('etapes.php');
    const m = new Map();
    for (const e of asArray(json)) m.set(String(e.id_etape_process ?? e.id), e.intitule ?? e.nom ?? '');
    return m;
  } catch (err) {
    log(`! etapes.php indisponible (non bloquant) : ${shortReason(err)}`);
    return new Map();
  }
}

const SESSION_FIELDS = [
  'id_action_de_formation', 'numero_complet', 'intitule', 'date_debut', 'date_fin',
  'id_etape_process', 'total_participants', 'id_centre_de_formation', 'type',
  'num_session_dpc', 'numero_comptable', // N° session DPC (toujours présent) + N° compte produit (optionnel)
  'mode_organisation', // S5.1b : source du libellé Format (niveau session)
].join(',');

/**
 * Sessions qui CHEVAUCHENT l'année : celles qui COMMENCENT dans l'année OU qui
 * FINISSENT dans l'année (2 requêtes Dendreo), dédupliquées par idAdf (une session
 * à cheval matche les deux). Corrige le trou "entrantes à cheval" : une session
 * commencée avant l'année mais finissant dedans est désormais capturée via ended_*.
 */
async function fetchYearSessionsRaw(year, fields) {
  const started = asArray(await client.get('actions_de_formation.php', {
    started_after: `${year}-01-01`, started_before: `${year}-12-31`, fields,
  }));
  const ended = asArray(await client.get('actions_de_formation.php', {
    ended_after: `${year}-01-01`, ended_before: `${year}-12-31`, fields,
  }));
  const byId = new Map();
  for (const s of [...started, ...ended]) byId.set(String(s.id_action_de_formation), s);
  return [...byId.values()];
}

async function countYear(year) {
  return (await fetchYearSessionsRaw(year, 'id_action_de_formation,date_debut,date_fin')).length;
}

async function listYearSessions(year) {
  return fetchYearSessionsRaw(year, SESSION_FIELDS);
}

// --- _meta ------------------------------------------------------------------
async function readMeta() {
  const snap = await getDb().doc(META_PATH).get();
  return snap.exists ? snap.data() : {};
}
async function writeMeta(patch) {
  // lastRunAt = vrai instant (métadonnée à nous), toISOString OK ici (pas une date murale Dendreo).
  await getDb().doc(META_PATH).set({ ...patch, lastRunAt: new Date().toISOString() }, { merge: true });
}

// --- traitement d'une session ----------------------------------------------
async function processSession(session) {
  if (quotaHit) return { skipped: true };
  try {
    const st = await getSessionSignatureStatus(session.idAdf, client); // Dendreo (read-only)
    const counts = st.counts; // { envoyes, signes, nonSignes, participantsConcernes, participantsARelancer }
    let ignoredLines = st.ignored; // lignes trackées sans doctype_id (dérivation) → déjà écartées

    // Enrichissement modules (S5.1b) : +1 lecture Dendreo/session (lams.php?include=module,creneaux).
    await enrichWithModules(session);
    delete session.modeOrganisation; // transient consommé (datesSynchrones) → hors du doc Firestore

    // Enrichissement financements/factures (S11.1) : +3 lectures RÉSILIENTES/session
    // (financements + laps + factures). Échec → valeurs par défaut (false/null) déjà
    // posées par mapSession → la session n'est JAMAIS perdue. MÊME fonction que sync.ts.
    // S15 : `session.aCheval` est déjà posé par mapSession → alimente le split facture 1/2.
    const fin = await enrichFinancement(session.idAdf, client, session.aCheval);
    Object.assign(session, fin.session);

    let purge = { purged: 0, signedMissing: 0, skipped: null };
    if (!args.dryRun) {
      try {
        await upsertSession(session); // la SESSION s'écrit TOUJOURS (avant les lignes)
        for (const a of st.attestations) {
          try {
            const idp = String(a.idParticipant);
            const commercialId = fin.commercialIdByParticipant.get(idp);
            const commercial = commercialId ? commerciauxRef.get(commercialId) ?? null : null;
            await upsertSignature(
              mapSig(a, session, fin.financeurByParticipant.get(idp) ?? null, commercial, fin.parcoursByParticipant.get(idp)),
            );
          } catch (lineErr) {
            if (isQuotaError(lineErr)) throw lineErr; // quota → remonte (arrêt propre)
            ignoredLines += 1; // une ligne KO n'abat JAMAIS la session : on l'ignore + compte
            log(`  ! ligne ignorée idAdf=${session.idAdf} : ${shortReason(lineErr)}`);
          }
        }
        // S17.4 : purge des fantômes AVANT le recalcul → les compteurs du cockpit
        // sont calculés sur un miroir déjà nettoyé. `st` est réutilisé tel quel :
        // ZÉRO appel Dendreo ajouté. purgeGhostSignatures ne lève jamais.
        if (args.purge) purge = await purgeGhostSignatures(session.idAdf, st);
        await recalcSessionCounts(session.idAdf); // toujours recalculé après écriture
      } catch (werr) {
        if (isQuotaError(werr)) { quotaHit = true; return { quota: true, idAdf: session.idAdf }; }
        throw werr;
      }
    }
    return { ok: true, counts, ignored: ignoredLines, purge, zeroParticipant: session.totalParticipants === 0 };
  } catch (err) {
    return { error: true, idAdf: session.idAdf, reason: shortReason(err) };
  }
}

// --- traitement d'une année -------------------------------------------------
async function processYear(year, budget) {
  const sessions = await listYearSessions(year);
  // Chevauchement + dédup inter-années : on retire les idAdf déjà traités par une
  // année précédente (session à cheval). On ne marque comme "traité" que ce qui
  // passe réellement (après application de --limit) pour ne pas masquer une session
  // écartée par la limite lors d'une prochaine année.
  const candidates = sessions.map(mapSession).filter((s) => !processedIds.has(s.idAdf));
  const dupCrossYear = sessions.length - candidates.length;
  let mapped = candidates;
  if (budget.limit != null) {
    const room = Math.max(0, budget.limit - budget.processed);
    if (mapped.length > room) mapped = mapped.slice(0, room);
  }
  for (const s of mapped) processedIds.add(s.idAdf);
  log(`\n=== Année ${year} : ${mapped.length} session(s) à traiter (chevauchement ; ${dupCrossYear} déjà vue(s) année(s) précédente(s))${args.dryRun ? ' (dry-run)' : ''} ===`);

  const results = await pool(mapped, CONCURRENCY, processSession);
  budget.processed += mapped.length;

  const agg = { sessions: 0, envoyes: 0, signes: 0, nonSignes: 0, ignored: 0, zeroParticipant: 0, errors: [], purged: 0, signedMissing: 0, purgeSkips: 0 };
  for (const r of results) {
    if (!r || r.skipped || r.quota) continue;
    if (r.error) { agg.errors.push({ idAdf: r.idAdf, reason: r.reason }); continue; }
    agg.sessions += 1;
    agg.envoyes += r.counts.envoyes;
    agg.signes += r.counts.signes;
    agg.nonSignes += r.counts.nonSignes;
    agg.ignored += r.ignored ?? 0;
    if (r.purge) { // S17.4
      agg.purged += r.purge.purged;
      agg.signedMissing += r.purge.signedMissing;
      if (r.purge.skipped) agg.purgeSkips += 1;
    }
    if (r.zeroParticipant) agg.zeroParticipant += 1;
  }
  log(`année ${year} → sessions:${agg.sessions} envoyes:${agg.envoyes} signes:${agg.signes} nonSignes:${agg.nonSignes} ignoredLines:${agg.ignored} zeroPart:${agg.zeroParticipant} erreurs:${agg.errors.length}` +
      (args.purge ? ` | purge → supprimés:${agg.purged} skips:${agg.purgeSkips} signéesAbsentes:${agg.signedMissing}` : ''));
  return agg;
}

// --- rapport ----------------------------------------------------------------
function printReport(perYear, meta, floorHasData) {
  log(`\n################ RAPPORT BACKFILL ${args.dryRun ? '(DRY-RUN)' : ''} ################`);
  const tot = { sessions: 0, envoyes: 0, signes: 0, nonSignes: 0, ignored: 0, zeroParticipant: 0, errors: 0, purged: 0, signedMissing: 0, purgeSkips: 0 };
  for (const [year, a] of Object.entries(perYear)) {
    log(`  ${year}: sessions=${a.sessions} envoyes=${a.envoyes} signes=${a.signes} nonSignes=${a.nonSignes} ignoredLines=${a.ignored} zeroPart=${a.zeroParticipant} err=${a.errors.length}`);
    tot.sessions += a.sessions; tot.envoyes += a.envoyes; tot.signes += a.signes;
    tot.nonSignes += a.nonSignes; tot.ignored += a.ignored; tot.zeroParticipant += a.zeroParticipant; tot.errors += a.errors.length;
    tot.purged += a.purged ?? 0; tot.signedMissing += a.signedMissing ?? 0; tot.purgeSkips += a.purgeSkips ?? 0;
  }
  log(`  ---`);
  log(`  TOTAUX: sessions=${tot.sessions} envoyes=${tot.envoyes} signes=${tot.signes} nonSignes=${tot.nonSignes}`);
  log(`  à relancer (nonSignes) : ${tot.nonSignes}`);
  log(`  invariant signes+nonSignes==envoyes : ${tot.signes + tot.nonSignes === tot.envoyes ? 'OK ✅' : 'KO ❌'}`);

  if (args.purge) {
    log(`\n  PURGE DES FANTÔMES (S17.4) :`);
    log(`   - fantômes pending SUPPRIMÉS : ${tot.purged}   (clé absente de Dendreo ET status pending)`);
    log(`   - sessions où la purge a été SKIPPÉE (réponse douteuse) : ${tot.purgeSkips}   ← 0 suppression, docs gardés`);
    log(`   - 🚨 signées absentes de Dendreo : ${tot.signedMissing}   ← JAMAIS touchées (anomalies à examiner)`);
  }

  log(`\n  ANOMALIES :`);
  log(`   - lignes d'attestation ignorées (sans doctype_id exploitable) : ${tot.ignored}`);
  log(`   - sessions à 0 participant : ${tot.zeroParticipant}`);
  if (floorHasData) log(`   - ⚠ le plancher ${FLOOR_YEAR} contient des sessions → BAISSER le plancher (données plus anciennes existent)`);
  const errs = Object.entries(perYear).flatMap(([y, a]) => a.errors.map((e) => ({ year: y, ...e })));
  log(`   - sessions en erreur : ${errs.length}`);
  for (const e of errs.slice(0, 50)) log(`       [${e.year}] idAdf=${e.idAdf} : ${e.reason}`);
  if (errs.length > 50) log(`       … (+${errs.length - 50} autres)`);

  if (meta) log(`\n  _meta/backfill : firstYearDiscovered=${meta.firstYearDiscovered} yearsProcessed=[${(meta.yearsProcessed || []).join(',')}] status=${meta.status}`);
  log(`#####################################################\n`);
}

// --- main -------------------------------------------------------------------
async function main() {
  log(`# BACKFILL S2.2 — mode=${args.dryRun ? 'DRY-RUN' : 'WRITE'}${args.year ? ' year=' + args.year : ''}${args.limit != null ? ' limit=' + args.limit : ''}${args.force ? ' force' : ''}${args.purge ? ' PURGE-FANTÔMES' : ''}`);
  if (args.purge && args.dryRun) log('# ℹ --dry-run : la purge ne s\'exécute PAS (elle ne tourne que dans le chemin d\'écriture).');
  await ensureAndpcValidated(client); // S11.1 : valide le libellé "ANDPC" une fois (log d'alerte sinon)
  commerciauxRef = await loadCommerciauxReferentiel(client); // S13.1 : référentiel commerciaux (1 lecture, cache)
  etapesMap = await fetchEtapesMap();

  const currentYear = new Date().getFullYear();
  let yearsToProcess = [];
  let firstYearDiscovered = null;
  let floorHasData = false;

  if (args.year) {
    yearsToProcess = [args.year];
  } else {
    // Découverte : scan de chaque année (courante → plancher), SANS early-stop.
    log(`# Découverte : scan ${currentYear} → ${FLOOR_YEAR} (2 req/année : start + end)`);
    const scanned = [];
    for (let y = currentYear; y >= FLOOR_YEAR; y--) {
      const n = await countYear(y);
      scanned.push({ year: y, count: n });
      log(`  année ${y}: ${n} session(s)`);
    }
    const withData = scanned.filter((x) => x.count > 0).map((x) => x.year);
    firstYearDiscovered = withData.length ? Math.min(...withData) : currentYear;
    floorHasData = (scanned.find((x) => x.year === FLOOR_YEAR) || {}).count > 0;
    log(`# firstYearDiscovered = ${firstYearDiscovered}`);
    for (let y = firstYearDiscovered; y <= currentYear; y++) yearsToProcess.push(y);
  }

  // Reprise : sauter les années déjà faites (sauf --force, et hors --year explicite).
  let meta = {};
  if (!args.dryRun) {
    meta = await readMeta();
    if (!args.force && !args.year && Array.isArray(meta.yearsProcessed)) {
      const before = yearsToProcess.length;
      yearsToProcess = yearsToProcess.filter((y) => !meta.yearsProcessed.includes(y));
      if (before !== yearsToProcess.length) log(`# Reprise : ${before - yearsToProcess.length} année(s) déjà faite(s) ignorée(s)`);
    }
    await writeMeta({
      status: 'running',
      ...(firstYearDiscovered != null ? { firstYearDiscovered } : {}),
    });
  }

  const perYear = {};
  const budget = { limit: args.limit, processed: 0 };

  for (const year of yearsToProcess) {
    if (budget.limit != null && budget.processed >= budget.limit) { log(`# limite ${budget.limit} atteinte, arrêt`); break; }
    const agg = await processYear(year, budget);
    perYear[year] = agg;

    if (!args.dryRun && !quotaHit) {
      const prev = (await readMeta());
      const yp = new Set(Array.isArray(prev.yearsProcessed) ? prev.yearsProcessed : []);
      yp.add(year);
      await writeMeta({
        yearsProcessed: [...yp].sort(),
        sessionsProcessed: (prev.sessionsProcessed || 0) + agg.sessions,
        status: 'running',
      });
    }

    if (quotaHit) {
      log(`\n# ⚠ QUOTA Firestore atteint pendant l'année ${year} → arrêt propre.`);
      if (!args.dryRun) await writeMeta({ status: 'partial' });
      log(`# Année ${year} NON marquée comme faite (partielle). Relance demain : elle sera reprise sans doublon.`);
      break;
    }
  }

  if (!args.dryRun && !quotaHit) {
    await writeMeta({ status: args.year ? 'running' : 'complete' });
    meta = await readMeta();
  }

  printReport(perYear, args.dryRun ? null : meta, floorHasData);
}

main().catch((err) => {
  log(`!! BACKFILL interrompu : ${shortReason(err)}`);
  process.exit(1);
});
