// scripts/recon-lien-participant-financement.mjs — S11.0d DIAGNOSTIC (LECTURE SEULE, no commit).
// -----------------------------------------------------------------------------
// Question : pour CHAQUE participant à relancer (attestation PENDING), peut-on
// savoir si son financement est ANDPC (id 360) ou hors-DPC ?
//
// 1. PROUVER le champ de liaison participant ↔ financement (hypothèse : le champ
//    `id_finance` d'un financement = id_participant). On NE DEVINE PAS : on croise
//    les ensembles {id_finance} vs {id_participant} vs {id_lap} sur données réelles
//    et on regarde lequel matche.
// 2. Une fois le lien établi : sur ~20 sessions ANDPC du périmètre 2026, croiser les
//    attestations PENDING avec les financements → combien de PENDING sont ANDPC(360),
//    NON-360 (particulier/entreprise), ou SANS financement.
// 3. Un participant peut-il avoir PLUSIEURS financements (ANDPC + particulier) ?
//
// Réutilise la logique PROD read-only : getSessionSignatureStatus (attestations).
// Sécurité : GET only ; clé jamais loggée ; noms de personnes → INITIALES ; pas d'écriture.
// Usage : npx tsx scripts/recon-lien-participant-financement.mjs [YYYY-MM-DD_ceil]
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { loadDendreoEnv } from '../src/config';
import { DendreoClient } from '../src/dendreo/client';
import { getSessionSignatureStatus } from '../src/dendreo/signatures';

const TODAY = process.argv[3] || '2026-07-21';
const OUT_FILE =
  process.argv[2] ||
  'C:\\Users\\DTHI~1\\AppData\\Local\\Temp\\claude\\C--Users-D-thi--Documents-GitHub-medere-dendreo-dashboard\\d276e222-ee90-4a8a-9352-b88693782e98\\scratchpad\\recon-lien-part-fin-raw.json';

const client = new DendreoClient(loadDendreoEnv());
const ANDPC_ID = '360';
const TARGET = 22;

let REQ = 0;
const dump = { note: 'S11.0d lien participant↔financement — brut local, non commité', q1: null, sessions: {}, analysis: {} };

function asArray(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.data)) return json.data;
  return json == null ? [] : [json];
}
async function get(resource, params) { REQ += 1; return asArray(await client.get(resource, params)); }
const initials = (s) => (String(s || '').trim().split(/\s+/).filter(Boolean).map((w) => (w[0] || '?').toUpperCase() + '.').join('') || '?.');

const SESSION_FIELDS = 'id_action_de_formation,numero_complet,date_debut,date_fin,total_participants,num_session_dpc';

/** Sessions du périmètre 2026 financées ANDPC (id_financeur=360). Charge les financements. */
async function selectPerimeter(target) {
  const list = await get('actions_de_formation.php', { started_after: '2026-01-01', ended_before: TODAY, fields: SESSION_FIELDS });
  const out = [];
  for (const s of list) {
    if (out.length >= target) break;
    const id = s.id_action_de_formation;
    let fin;
    try { fin = await get('financements.php', { id_action_de_formation: id }); } catch { continue; }
    if (!fin.some((f) => String(f.id_financeur) === ANDPC_ID)) continue;
    out.push({ id, numero: s.numero_complet, financements: fin });
  }
  return out;
}

async function main() {
  console.log(`# S11.0d — lien participant↔financement, périmètre 2026 (fin<=${TODAY}) — LECTURE SEULE\n`);
  const perim = await selectPerimeter(TARGET);
  console.log(`Sessions ANDPC périmètre retenues : ${perim.length}\n`);
  if (!perim.length) return finish();

  // ===========================================================================
  // Q1 — PROUVER le champ de liaison (id_finance vs id_participant vs id_lap)
  // ===========================================================================
  console.log('=== Q1 — champ de liaison participant ↔ financement ===');
  // On instrumente les 2 premières sessions en détail (laps + attestations).
  const q1Rows = [];
  let totFinPart = 0, totFinLap = 0, totFinNeither = 0, totFinLines = 0;
  for (const sess of perim.slice(0, 2)) {
    const laps = await get('laps.php', { id_action_de_formation: sess.id, include: 'participant' });
    const partById = new Map();
    const lapIds = new Set();
    for (const l of laps) {
      if (l.id_lap != null) lapIds.add(String(l.id_lap));
      const p = l.participant || {};
      const pid = String(l.id_participant ?? p.id_participant ?? '');
      if (pid) partById.set(pid, initials([p.prenom, p.nom].filter(Boolean).join(' ')));
    }
    const partIds = new Set(partById.keys());

    console.log(`\n  ── ${sess.numero} (id=${sess.id}) : ${sess.financements.length} financements, ${laps.length} inscriptions`);
    console.log(`     échantillon lignes financement (id_finance | id_financeur | type | id_finance∈participants? | ∈laps? | qui) :`);
    for (const f of sess.financements.slice(0, 10)) {
      const idf = String(f.id_finance);
      const inPart = partIds.has(idf);
      const inLap = lapIds.has(idf);
      totFinLines += 1;
      if (inPart) totFinPart += 1; else if (inLap) totFinLap += 1; else totFinNeither += 1;
      console.log(`       ${idf} | ${f.id_financeur} | ${f.type} | part=${inPart ? partById.get(idf) : 'non'} | lap=${inLap}`);
      q1Rows.push({ session: sess.numero, id_finance: idf, id_financeur: String(f.id_financeur), type: f.type, inPart, inLap });
    }
    // stats globales de la session
    const finIds = new Set(sess.financements.map((f) => String(f.id_finance)));
    const interPart = [...finIds].filter((x) => partIds.has(x)).length;
    const interLap = [...finIds].filter((x) => lapIds.has(x)).length;
    console.log(`     recouvrement (tous financements) : {id_finance}∩{id_participant}=${interPart}/${finIds.size} ; ∩{id_lap}=${interLap}/${finIds.size}`);
  }
  const verdict = totFinPart >= totFinLap && totFinPart > 0 ? 'id_finance = id_participant'
    : totFinLap > totFinPart ? 'id_finance = id_lap (inscription)'
      : 'NI participant NI lap → chercher un autre champ';
  console.log(`\n  >>> VERDICT liaison (sur ${totFinLines} lignes instrumentées) : ${verdict}`);
  console.log(`      matches participant=${totFinPart} lap=${totFinLap} aucun=${totFinNeither}`);
  dump.q1 = { verdict, totFinPart, totFinLap, totFinNeither, totFinLines, rows: q1Rows };

  const linkIsParticipant = totFinPart >= totFinLap && totFinPart > 0;

  // ===========================================================================
  // Q2 — croiser PENDING × financements sur ~20 sessions
  // ===========================================================================
  console.log('\n=== Q2 — attestations PENDING × financement (ANDPC / non-360 / aucun) ===');
  let pAndpc = 0, pNon360 = 0, pNone = 0, pTot = 0;
  const examples = [];
  const multiFinCases = [];
  for (const sess of perim) {
    let status;
    try { status = await getSessionSignatureStatus(sess.id, client); } catch { continue; }
    const pending = status.attestations.filter((a) => a.status === 'pending');
    // index financements par id_finance (= participant si Q1 confirmé)
    const byFinance = new Map();
    for (const f of sess.financements) {
      const k = String(f.id_finance);
      if (!byFinance.has(k)) byFinance.set(k, []);
      byFinance.get(k).push({ id_financeur: String(f.id_financeur), type: f.type });
    }
    for (const a of pending) {
      pTot += 1;
      const key = linkIsParticipant ? String(a.idParticipant) : String(a.idParticipant); // lien retenu
      const fins = byFinance.get(key) || [];
      const has360 = fins.some((x) => x.id_financeur === ANDPC_ID);
      const hasNon360 = fins.some((x) => x.id_financeur !== ANDPC_ID);
      let cls;
      if (!fins.length) { pNone += 1; cls = 'AUCUN'; }
      else if (has360) { pAndpc += 1; cls = 'ANDPC(360)'; } // ANDPC prime (à relancer)
      else { pNon360 += 1; cls = 'NON-360'; }
      if (fins.length > 1) multiFinCases.push({ session: sess.numero, who: initials(a.nom), fins });
      if (examples.length < 12) examples.push({ session: sess.numero, who: initials(a.nom), classe: cls, financeurs: fins.map((x) => `${x.id_financeur}/${x.type}`) });
    }
    dump.sessions[sess.id] = { numero: sess.numero, pending: pending.length };
  }
  console.log(`  PENDING total (périmètre) : ${pTot}`);
  console.log(`    → financement ANDPC (360)   [À RELANCER] : ${pAndpc}`);
  console.log(`    → financement NON-360 (part./entr.) [NE PAS relancer] : ${pNon360}`);
  console.log(`    → AUCUN financement         [À SIGNALER] : ${pNone}`);
  console.log('\n  Exemples (nom masqué) :');
  for (const e of examples) console.log(`     [${e.session}] ${e.who} → ${e.classe} (financeurs: ${JSON.stringify(e.financeurs)})`);
  dump.analysis.q2 = { pTot, pAndpc, pNon360, pNone, examples };

  // ===========================================================================
  // Q3 — participant à financements MULTIPLES
  // ===========================================================================
  console.log('\n=== Q3 — participants à financements MULTIPLES ===');
  console.log(`  Cas détectés (même id_finance, ≥2 lignes) : ${multiFinCases.length}`);
  for (const m of multiFinCases.slice(0, 5)) console.log(`     [${m.session}] ${m.who} → ${JSON.stringify(m.fins)}`);
  dump.analysis.q3 = { count: multiFinCases.length, examples: multiFinCases.slice(0, 10) };

  finish();
}

function finish() {
  try { writeFileSync(OUT_FILE, JSON.stringify(dump, null, 2), 'utf8'); console.log(`\n# Brut écrit : ${OUT_FILE}`); }
  catch (e) { console.log('# écriture brut KO :', String(e.message).slice(0, 120)); }
  console.log(`# Total requêtes Dendreo : ${REQ}`);
}

main().catch((err) => { console.error('!! recon interrompue :', String(err && err.message ? err.message : err).slice(0, 300)); process.exit(1); });
