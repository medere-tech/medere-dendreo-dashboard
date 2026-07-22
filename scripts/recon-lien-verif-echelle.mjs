// scripts/recon-lien-verif-echelle.mjs — S11.0f VÉRIF du lien à l'échelle (LECTURE SEULE, no commit).
// -----------------------------------------------------------------------------
// Lien : financements.id_finance == laps.id_entreprise (entreprise de facturation
// du participant ; particulier → Dendreo crée une "entreprise" à son nom).
// Chaîne : idParticipant → laps.id_entreprise → financement.id_finance → id_financeur.
//
//   1. PREUVE échelle : sur 5 sessions ANDPC 2026, recouvrement
//      {financements.id_finance} ∩ {laps.id_entreprise} + 10 lignes appariées.
//   2. PENDING × financeur : ANDPC(360) / non-360 / aucun. Chiffres + 5 exemples.
//   3. Participant à financements MULTIPLES (id_entreprise sur ≥2 lignes).
//   4. COÛT : compte les lectures laps+financements/session (pour l'estim. backfill).
//
// Réutilise getSessionSignatureStatus (attestations PENDING, prod read-only).
// Sécurité : GET only ; clé jamais loggée ; noms → INITIALES ; brut → scratchpad.
// Usage : npx tsx scripts/recon-lien-verif-echelle.mjs [YYYY-MM-DD_ceil]
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { loadDendreoEnv } from '../src/config';
import { DendreoClient } from '../src/dendreo/client';
import { getSessionSignatureStatus } from '../src/dendreo/signatures';

const TODAY = process.argv[3] || '2026-07-21';
const OUT_FILE =
  process.argv[2] ||
  'C:\\Users\\DTHI~1\\AppData\\Local\\Temp\\claude\\C--Users-D-thi--Documents-GitHub-medere-dendreo-dashboard\\d276e222-ee90-4a8a-9352-b88693782e98\\scratchpad\\recon-lien-verif-echelle-raw.json';

const client = new DendreoClient(loadDendreoEnv());
const ANDPC_ID = '360';
const N_SESSIONS = 5;

let REQ = 0;
const dump = { note: 'S11.0f verif lien échelle — brut local, non commité', sessions: {}, analysis: {} };

function asArray(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.data)) return json.data;
  return json == null ? [] : [json];
}
async function get(resource, params) { REQ += 1; return asArray(await client.get(resource, params)); }
const initials = (s) => (String(s || '').trim().split(/\s+/).filter(Boolean).map((w) => (w[0] || '?').toUpperCase() + '.').join('') || '?.');

async function selectAndpc2026(n) {
  const list = await get('actions_de_formation.php', {
    started_after: '2026-01-01', ended_before: TODAY,
    fields: 'id_action_de_formation,numero_complet,date_debut,date_fin',
  });
  const out = [];
  for (const s of list) {
    if (out.length >= n) break;
    const fin = await get('financements.php', { id_action_de_formation: s.id_action_de_formation });
    if (fin.some((f) => String(f.id_financeur) === ANDPC_ID)) out.push({ s, fin });
  }
  return out;
}

async function main() {
  console.log(`# S11.0f — VÉRIF lien id_finance==id_entreprise à l'échelle (périmètre 2026) — LECTURE SEULE\n`);
  const sel = await selectAndpc2026(N_SESSIONS);
  console.log(`Sessions ANDPC retenues : ${sel.length}\n`);
  if (!sel.length) return finish();

  // ==== Q1 — recouvrement id_finance ∩ id_entreprise ========================
  console.log('=== Q1 — recouvrement {financements.id_finance} ∩ {laps.id_entreprise} ===');
  let printed = 0;
  const q1 = [];
  const perSession = []; // pour Q2/Q3 : réutilise laps+fin+attest
  for (const { s, fin } of sel) {
    const idAdf = s.id_action_de_formation;
    const laps = await get('laps.php', { id_action_de_formation: idAdf, include: 'participant' });
    const finFinanceIds = new Set(fin.map((f) => String(f.id_finance)));
    const lapEntIds = laps.map((l) => String(l.id_entreprise ?? '')).filter(Boolean);
    const lapEntSet = new Set(lapEntIds);
    const interLapSide = lapEntIds.filter((e) => finFinanceIds.has(e)).length; // inscriptions couvertes
    const interFinSide = [...finFinanceIds].filter((e) => lapEntSet.has(e)).length; // financements appariés
    console.log(`\n  ── ${s.numero_complet} (id=${idAdf}) : ${laps.length} inscriptions, ${fin.length} financements`);
    console.log(`     inscriptions dont id_entreprise ∈ {id_finance} : ${interLapSide}/${laps.length} (${laps.length ? Math.round(interLapSide / laps.length * 100) : 0}%)`);
    console.log(`     financements dont id_finance ∈ {id_entreprise} : ${interFinSide}/${fin.length} (${fin.length ? Math.round(interFinSide / fin.length * 100) : 0}%)`);
    q1.push({ numero: s.numero_complet, nLaps: laps.length, nFin: fin.length, interLapSide, interFinSide });

    // index financement par id_finance
    const finByEnt = new Map();
    for (const f of fin) {
      const k = String(f.id_finance);
      if (!finByEnt.has(k)) finByEnt.set(k, []);
      finByEnt.get(k).push({ id_financeur: String(f.id_financeur), type: f.type, montant: f.montant_finance });
    }
    // 10 lignes appariées (global, cumulées sur les sessions)
    for (const l of laps) {
      if (printed >= 10) break;
      const ent = String(l.id_entreprise ?? '');
      const pid = String(l.id_participant ?? l.participant?.id_participant ?? '');
      const fs = finByEnt.get(ent) || [];
      const fr = fs.map((x) => `${x.id_financeur}/${x.type}`).join(',') || '—';
      console.log(`     ROW id_lap=${l.id_lap} idPart=${pid} id_entreprise=${ent} → financeur(s)=${fr}`);
      printed += 1;
    }
    perSession.push({ idAdf, numero: s.numero_complet, laps, finByEnt });
  }
  const totLapSide = q1.reduce((a, x) => a + x.interLapSide, 0), totLaps = q1.reduce((a, x) => a + x.nLaps, 0);
  const totFinSide = q1.reduce((a, x) => a + x.interFinSide, 0), totFin = q1.reduce((a, x) => a + x.nFin, 0);
  console.log(`\n  GLOBAL : inscriptions appariées ${totLapSide}/${totLaps} (${totLaps ? Math.round(totLapSide / totLaps * 100) : 0}%) ; financements appariés ${totFinSide}/${totFin} (${totFin ? Math.round(totFinSide / totFin * 100) : 0}%)`);
  dump.analysis.q1 = { perSession: q1, totLapSide, totLaps, totFinSide, totFin };

  // ==== Q2 — PENDING × financeur ============================================
  console.log('\n=== Q2 — attestations PENDING × financeur (via id_entreprise) ===');
  let pAndpc = 0, pNon360 = 0, pNone = 0, pTot = 0;
  const examples = [];
  const multi = [];
  for (const ps of perSession) {
    let status;
    try { status = await getSessionSignatureStatus(ps.idAdf, client); } catch { continue; }
    const pending = status.attestations.filter((a) => a.status === 'pending');
    // idParticipant → id_entreprise
    const entByPart = new Map();
    for (const l of ps.laps) {
      const pid = String(l.id_participant ?? l.participant?.id_participant ?? '');
      if (pid) entByPart.set(pid, String(l.id_entreprise ?? ''));
    }
    for (const a of pending) {
      pTot += 1;
      const ent = entByPart.get(String(a.idParticipant));
      const fins = ent ? (ps.finByEnt.get(ent) || []) : [];
      const has360 = fins.some((x) => x.id_financeur === ANDPC_ID);
      const hasNon = fins.some((x) => x.id_financeur !== ANDPC_ID);
      let cls;
      if (!fins.length) { pNone += 1; cls = 'AUCUN'; }
      else if (has360) { pAndpc += 1; cls = 'ANDPC(360)'; }
      else { pNon360 += 1; cls = 'NON-360'; }
      if (fins.length > 1) multi.push({ session: ps.numero, who: initials(a.nom), id_entreprise: ent, fins });
      if (examples.length < 8) examples.push({ session: ps.numero, who: initials(a.nom), classe: cls, financeurs: fins.map((x) => `${x.id_financeur}/${x.type}`) });
    }
  }
  console.log(`  PENDING total : ${pTot}`);
  console.log(`    → ANDPC(360) [À RELANCER]        : ${pAndpc}`);
  console.log(`    → NON-360 (part./entr.) [NE PAS] : ${pNon360}`);
  console.log(`    → AUCUN financement [À SIGNALER] : ${pNone}`);
  console.log('  Exemples :');
  for (const e of examples.slice(0, 5)) console.log(`     [${e.session}] ${e.who} → ${e.classe} (${JSON.stringify(e.financeurs)})`);
  dump.analysis.q2 = { pTot, pAndpc, pNon360, pNone, examples };

  // ==== Q3 — financements multiples =========================================
  console.log('\n=== Q3 — participants (id_entreprise) à financements MULTIPLES ===');
  const multiEnt = [];
  for (const ps of perSession) {
    for (const [ent, fs] of ps.finByEnt.entries()) {
      if (fs.length > 1) {
        const financeurs = [...new Set(fs.map((x) => x.id_financeur))];
        multiEnt.push({ session: ps.numero, id_entreprise: ent, nLignes: fs.length, financeurs, mixteAndpc: financeurs.includes(ANDPC_ID) && financeurs.some((f) => f !== ANDPC_ID) });
      }
    }
  }
  console.log(`  id_entreprise avec ≥2 lignes de financement : ${multiEnt.length}`);
  console.log(`  dont MIXTE (ANDPC + non-ANDPC) : ${multiEnt.filter((m) => m.mixteAndpc).length}`);
  for (const m of multiEnt.slice(0, 6)) console.log(`     [${m.session}] id_entreprise=${m.id_entreprise} : ${m.nLignes} lignes, financeurs=${JSON.stringify(m.financeurs)}${m.mixteAndpc ? ' ⚠MIXTE' : ''}`);
  dump.analysis.q3 = { count: multiEnt.length, mixte: multiEnt.filter((m) => m.mixteAndpc).length, examples: multiEnt.slice(0, 10) };

  // ==== Q4 — coût ===========================================================
  console.log('\n=== Q4 — coût (lectures pour cette vérif) ===');
  console.log(`  Requêtes totales cette exécution : ${REQ}`);
  console.log(`  Par session, pour V2 il faut : financements.php (1) + laps.php (1) = 2 lectures/session.`);
  console.log(`  (getSessionSignatureStatus = fichiers.php, déjà lu au backfill ; laps.php n'est PLUS lu au backfill actuel.)`);
  dump.analysis.q4 = { reqTotal: REQ, sessions: sel.length };

  finish();
}

function finish() {
  try { writeFileSync(OUT_FILE, JSON.stringify(dump, null, 2), 'utf8'); console.log(`\n# Brut écrit : ${OUT_FILE}`); }
  catch (e) { console.log('# écriture brut KO :', String(e.message).slice(0, 120)); }
  console.log(`# Total requêtes Dendreo : ${REQ}`);
}

main().catch((err) => { console.error('!! recon interrompue :', String(err && err.message ? err.message : err).slice(0, 300)); process.exit(1); });
