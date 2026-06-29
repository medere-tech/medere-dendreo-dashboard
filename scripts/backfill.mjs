// scripts/backfill.mjs — Backfill historique Dendreo → Firestore (S2.2).
// LECTURE SEULE côté Dendreo ; écriture uniquement vers NOTRE Firestore.
// Lancé via tsx :  npm run backfill -- [--dry-run] [--year YYYY] [--limit N] [--force]
//
// - Découvre la 1re année en scannant chaque année (année courante → plancher 2015),
//   SANS early-stop, sans hardcoder de date de fondation.
// - Par session : getSessionSignatureStatus (S1) → upsertSession + upsertSignature(s)
//   + recalcSessionCounts (transaction). Idempotent (rejouer = aucun doublon).
// - Reprenable via _meta/backfill.yearsProcessed (sauf --force).
// - Résilient (une session en échec n'arrête pas le run), pacing concurrence 5,
//   arrêt propre sur quota Firestore (RESOURCE_EXHAUSTED), logs SANS PII.

import { loadDendreoEnv, DENDREO } from '../src/config';
import { DendreoClient } from '../src/dendreo/client';
import { getSessionSignatureStatus } from '../src/dendreo/signatures';
import { getDb } from '../src/firebase/admin';
import { recalcSessionCounts, upsertSession, upsertSignature } from '../src/firebase/firestore';

const FLOOR_YEAR = 2015;
const CONCURRENCY = 5;

// --- args -------------------------------------------------------------------
function parseArgs(argv) {
  const a = { dryRun: false, force: false, year: null, limit: null };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--dry-run') a.dryRun = true;
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

// --- mappers ----------------------------------------------------------------
function mapSession(s) {
  const id = String(s.id_action_de_formation);
  const idEtape = String(s.id_etape_process ?? '');
  return {
    idAdf: id,
    numeroComplet: s.numero_complet ?? `ADF_${id}`,
    intitule: s.intitule ?? '(sans intitulé)',
    dateDebut: normDate(s.date_debut),
    dateFin: normDate(s.date_fin),
    idEtapeProcess: idEtape,
    etape: etapesMap.get(idEtape) ?? `etape_${idEtape || '?'}`,
    idCentre: String(s.id_centre_de_formation ?? ''),
    type: s.type ?? '',
    totalParticipants: Number(s.total_participants ?? 0) || 0,
  };
}

function mapSig(entry, status, session) {
  return {
    idAdf: session.idAdf,
    idParticipant: String(entry.idParticipant),
    doctypeId: DENDREO.DOCTYPE_CONVENTION,
    nom: entry.nom && entry.nom.trim() ? entry.nom : '—',
    status,
    signatureDate: status === 'signed' ? normDate(entry.signatureDate) : null,
    sentDate: status === 'pending' ? normDate(entry.sentDate) : null,
    viewerUrl: status === 'notSent' ? null : (entry.viewerUrl ?? null),
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
].join(',');

async function countYear(year) {
  const json = await client.get('actions_de_formation.php', {
    started_after: `${year}-01-01`, started_before: `${year}-12-31`, fields: 'id_action_de_formation',
  });
  return asArray(json).length;
}

async function listYearSessions(year) {
  const json = await client.get('actions_de_formation.php', {
    started_after: `${year}-01-01`, started_before: `${year}-12-31`, fields: SESSION_FIELDS,
  });
  return asArray(json);
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
    const counts = { signed: st.signed.length, pending: st.pending.length, notSent: st.notSent.length };

    if (!args.dryRun) {
      try {
        await upsertSession(session);
        for (const e of st.signed) await upsertSignature(mapSig(e, 'signed', session));
        for (const e of st.pending) await upsertSignature(mapSig(e, 'pending', session));
        for (const e of st.notSent) await upsertSignature(mapSig(e, 'notSent', session));
        await recalcSessionCounts(session.idAdf);
      } catch (werr) {
        if (isQuotaError(werr)) { quotaHit = true; return { quota: true, idAdf: session.idAdf }; }
        throw werr;
      }
    }
    return { ok: true, counts, zeroParticipant: session.totalParticipants === 0 };
  } catch (err) {
    return { error: true, idAdf: session.idAdf, reason: shortReason(err) };
  }
}

// --- traitement d'une année -------------------------------------------------
async function processYear(year, budget) {
  let sessions = await listYearSessions(year);
  if (budget.limit != null) {
    const room = Math.max(0, budget.limit - budget.processed);
    if (sessions.length > room) sessions = sessions.slice(0, room);
  }
  log(`\n=== Année ${year} : ${sessions.length} session(s) à traiter${args.dryRun ? ' (dry-run)' : ''} ===`);

  const mapped = sessions.map(mapSession);
  const results = await pool(mapped, CONCURRENCY, processSession);
  budget.processed += sessions.length;

  const agg = { sessions: 0, signed: 0, pending: 0, notSent: 0, zeroParticipant: 0, errors: [] };
  for (const r of results) {
    if (!r || r.skipped || r.quota) continue;
    if (r.error) { agg.errors.push({ idAdf: r.idAdf, reason: r.reason }); continue; }
    agg.sessions += 1;
    agg.signed += r.counts.signed;
    agg.pending += r.counts.pending;
    agg.notSent += r.counts.notSent;
    if (r.zeroParticipant) agg.zeroParticipant += 1;
  }
  log(`année ${year} → sessions:${agg.sessions} signed:${agg.signed} pending:${agg.pending} notSent:${agg.notSent} zeroPart:${agg.zeroParticipant} erreurs:${agg.errors.length}`);
  return agg;
}

// --- rapport ----------------------------------------------------------------
function printReport(perYear, meta, floorHasData) {
  log(`\n################ RAPPORT BACKFILL ${args.dryRun ? '(DRY-RUN)' : ''} ################`);
  const tot = { sessions: 0, signed: 0, pending: 0, notSent: 0, zeroParticipant: 0, errors: 0 };
  for (const [year, a] of Object.entries(perYear)) {
    log(`  ${year}: sessions=${a.sessions} signed=${a.signed} pending=${a.pending} notSent=${a.notSent} zeroPart=${a.zeroParticipant} err=${a.errors.length}`);
    tot.sessions += a.sessions; tot.signed += a.signed; tot.pending += a.pending;
    tot.notSent += a.notSent; tot.zeroParticipant += a.zeroParticipant; tot.errors += a.errors.length;
  }
  log(`  ---`);
  log(`  TOTAUX: sessions=${tot.sessions} signed=${tot.signed} pending=${tot.pending} notSent=${tot.notSent}`);
  log(`  notSent>0 réel : ${tot.notSent > 0 ? 'OUI ✅ (à relancer = ' + tot.notSent + ')' : 'aucun sur ce périmètre'}`);

  log(`\n  ANOMALIES :`);
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
  log(`# BACKFILL S2.2 — mode=${args.dryRun ? 'DRY-RUN' : 'WRITE'}${args.year ? ' year=' + args.year : ''}${args.limit != null ? ' limit=' + args.limit : ''}${args.force ? ' force' : ''}`);
  etapesMap = await fetchEtapesMap();

  const currentYear = new Date().getFullYear();
  let yearsToProcess = [];
  let firstYearDiscovered = null;
  let floorHasData = false;

  if (args.year) {
    yearsToProcess = [args.year];
  } else {
    // Découverte : scan de chaque année (courante → plancher), SANS early-stop.
    log(`# Découverte : scan ${currentYear} → ${FLOOR_YEAR} (1 req/année)`);
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
