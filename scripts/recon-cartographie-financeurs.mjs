// scripts/recon-cartographie-financeurs.mjs — S11.0g CARTOGRAPHIE + AMPLEUR (LECTURE SEULE, no commit).
// -----------------------------------------------------------------------------
// Sur TOUT le périmètre 2026 (début>=2026-01-01, fin<=aujourd'hui) :
//  1. CARTOGRAPHIE des financeurs : id_financeur distincts → résolus par LIBELLÉ
//     (financeurs.php?id, fallback entreprises.php). Table : id | type | libellé | nb lignes | nb sessions.
//     Les particuliers sont AGRÉGÉS (pas de résolution nominative → pas de PII).
//     Validation : id 360 → raison_sociale EXACTEMENT "ANDPC" (on valide par le libellé).
//  2. AMPLEUR : sur TOUTES les sessions, PENDING × financeur via la chaîne prouvée
//     (idParticipant → laps.id_entreprise → financement.id_finance → id_financeur → libellé) :
//     ANDPC (à relancer) / non-ANDPC ventilé PAR LIBELLÉ / aucun (à signaler).
//  3. COÛT : requêtes réelles + extrapolation backfill (~1500 sessions × 2 lectures).
//
// Réutilise getSessionSignatureStatus (prod read-only). GET only ; clé jamais loggée ;
// noms de personnes jamais révélés ; brut → scratchpad (hors repo).
// Usage : npx tsx scripts/recon-cartographie-financeurs.mjs [YYYY-MM-DD_ceil]
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { loadDendreoEnv } from '../src/config';
import { DendreoClient } from '../src/dendreo/client';
import { getSessionSignatureStatus } from '../src/dendreo/signatures';

const TODAY = process.argv[3] || '2026-07-21';
const OUT_FILE =
  process.argv[2] ||
  'C:\\Users\\DTHI~1\\AppData\\Local\\Temp\\claude\\C--Users-D-thi--Documents-GitHub-medere-dendreo-dashboard\\d276e222-ee90-4a8a-9352-b88693782e98\\scratchpad\\recon-cartographie-financeurs-raw.json';

const client = new DendreoClient(loadDendreoEnv());
const ANDPC_ID = '360';
const MAX_SESSIONS = 500; // garde-fou anti-runaway (périmètre borné, normalement < 300)

let REQ = 0;
const dump = { note: 'S11.0g cartographie financeurs — brut local, non commité', cartographie: [], ampleur: {}, cout: {} };

function asArray(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.data)) return json.data;
  return json == null ? [] : [json];
}
async function get(resource, params) { REQ += 1; return asArray(await client.get(resource, params)); }
async function tryGet(resource, params) { REQ += 1; try { return { ok: true, arr: asArray(await client.get(resource, params)) }; } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e).slice(0, 120) }; } }
const initials = (s) => (String(s || '').trim().split(/\s+/).filter(Boolean).map((w) => (w[0] || '?').toUpperCase() + '.').join('') || '?.');

// résout un id_financeur en libellé (organisme). Ne résout JAMAIS un particulier (PII).
const resolveCache = new Map();
async function resolveLibelle(id) {
  if (resolveCache.has(id)) return resolveCache.get(id);
  let lib = null;
  for (const res of ['financeurs.php', 'entreprises.php']) {
    const r = await tryGet(res, { id });
    if (r.ok && r.arr[0]) {
      const o = r.arr[0];
      const k = Object.keys(o).find((kk) => /raison_sociale|^nom$|intitule|libelle/i.test(kk) && o[kk]);
      if (k) { lib = { source: res, key: k, value: String(o[k]) }; break; }
    }
  }
  resolveCache.set(id, lib);
  return lib;
}

async function main() {
  console.log(`# S11.0g — CARTOGRAPHIE financeurs + AMPLEUR, périmètre 2026 (fin<=${TODAY}) — LECTURE SEULE\n`);

  const list = await get('actions_de_formation.php', {
    started_after: '2026-01-01', ended_before: TODAY,
    fields: 'id_action_de_formation,numero_complet,date_debut,date_fin',
  });
  const sessions = list.slice(0, MAX_SESSIONS);
  console.log(`Sessions périmètre [2026-01-01 → ${TODAY}] : ${list.length}${list.length > MAX_SESSIONS ? ` (traitées : ${MAX_SESSIONS})` : ''}\n`);

  // ---- PASS 1 : lecture par session (financements + laps + attestations) ----
  // financeurStats: id_financeur -> { types:Set, lines, sessions:Set }
  const finStats = new Map();
  const perSession = [];
  let done = 0;
  for (const s of sessions) {
    const idAdf = s.id_action_de_formation;
    let fin = [], laps = [];
    try { fin = await get('financements.php', { id_action_de_formation: idAdf }); } catch { fin = []; }
    try { laps = await get('laps.php', { id_action_de_formation: idAdf, include: 'participant' }); } catch { laps = []; }

    for (const f of fin) {
      const idf = String(f.id_financeur);
      if (!finStats.has(idf)) finStats.set(idf, { types: new Set(), lines: 0, sessions: new Set() });
      const st = finStats.get(idf);
      st.types.add(f.type); st.lines += 1; st.sessions.add(idAdf);
    }
    // index pour l'ampleur
    const finByEnt = new Map();
    for (const f of fin) {
      const k = String(f.id_finance);
      if (!finByEnt.has(k)) finByEnt.set(k, []);
      finByEnt.get(k).push({ id_financeur: String(f.id_financeur), type: f.type, montant: Number(String(f.montant_finance).replace(',', '.')) || 0 });
    }
    const entByPart = new Map();
    for (const l of laps) {
      const pid = String(l.id_participant ?? l.participant?.id_participant ?? '');
      if (pid) entByPart.set(pid, String(l.id_entreprise ?? ''));
    }
    perSession.push({ idAdf, numero: s.numero_complet, finByEnt, entByPart });
    done += 1;
    if (done % 25 === 0) console.log(`  … ${done}/${sessions.length} sessions lues (req=${REQ})`);
  }
  console.log(`Lecture terminée : ${done} sessions, ${REQ} requêtes.\n`);

  // ---- Q1 : CARTOGRAPHIE ----------------------------------------------------
  console.log('=== Q1 — CARTOGRAPHIE des financeurs (résolution par libellé) ===');
  // résout les organismes (types non exclusivement 'particulier')
  const carto = [];
  for (const [id, st] of finStats.entries()) {
    const types = [...st.types];
    const onlyParticulier = types.length === 1 && types[0] === 'particulier';
    let libelle;
    if (onlyParticulier) libelle = '(particulier — agrégé, non résolu)';
    else { const r = await resolveLibelle(id); libelle = r ? `${r.value}  [${r.source}:${r.key}]` : `#${id} (non résolu)`; }
    carto.push({ id_financeur: id, types: types.join('+'), libelle, lignes: st.lines, sessions: st.sessions.size, onlyParticulier });
  }
  // agrège les particuliers en UNE ligne
  const partRows = carto.filter((c) => c.onlyParticulier);
  const orgRows = carto.filter((c) => !c.onlyParticulier).sort((a, b) => b.lignes - a.lignes);
  const partAgg = partRows.reduce((a, c) => ({ ids: a.ids + 1, lignes: a.lignes + c.lignes, sessions: a.sessions + c.sessions }), { ids: 0, lignes: 0, sessions: 0 });

  console.log('  id_financeur | type | libellé | nb lignes | nb sessions');
  for (const c of orgRows) console.log(`   ${c.id_financeur} | ${c.types} | ${c.libelle} | ${c.lignes} | ${c.sessions}`);
  console.log(`   [particuliers agrégés] | particulier | ${partAgg.ids} entreprises perso distinctes | ${partAgg.lignes} | (≈ ${partAgg.sessions} sessions-lignes)`);

  const row360 = orgRows.find((c) => c.id_financeur === ANDPC_ID);
  const is360Andpc = row360 && /^ANDPC$/i.test(String(row360.libelle).split('  [')[0].trim());
  console.log(`\n  ✅ Validation libellé : id 360 → ${row360 ? row360.libelle : '(absent)'} → "ANDPC" exact ? ${is360Andpc ? 'OUI' : 'NON/À VÉRIFIER'}`);
  dump.cartographie = { orgRows, particuliers: partAgg, is360Andpc };

  // ---- Q2 : AMPLEUR ---------------------------------------------------------
  console.log('\n=== Q2 — AMPLEUR : PENDING × financeur (tout le périmètre) ===');
  const libelleOf = async (idFinanceur, type) => {
    if (type === 'particulier') return 'particulier';
    const r = await resolveLibelle(idFinanceur);
    return r ? r.value : `#${idFinanceur}`;
  };
  let pTot = 0, pAndpc = 0, pNon = 0, pNone = 0;
  const ventil = new Map(); // libellé non-ANDPC -> count
  const examples = [];
  let si = 0;
  for (const ps of perSession) {
    si += 1;
    let status;
    try { status = await getSessionSignatureStatus(ps.idAdf, client); } catch { continue; }
    const pending = status.attestations.filter((a) => a.status === 'pending');
    for (const a of pending) {
      pTot += 1;
      const ent = ps.entByPart.get(String(a.idParticipant));
      const fins = ent ? (ps.finByEnt.get(ent) || []) : [];
      if (!fins.length) { pNone += 1; if (examples.length < 8) examples.push({ session: ps.numero, who: initials(a.nom), classe: 'AUCUN' }); continue; }
      if (fins.some((x) => x.id_financeur === ANDPC_ID)) { pAndpc += 1; if (examples.length < 8) examples.push({ session: ps.numero, who: initials(a.nom), classe: 'ANDPC' }); continue; }
      pNon += 1;
      // financeur dominant = plus gros montant
      const dom = fins.slice().sort((x, y) => y.montant - x.montant)[0];
      const lib = await libelleOf(dom.id_financeur, dom.type);
      ventil.set(lib, (ventil.get(lib) || 0) + 1);
      if (examples.length < 8) examples.push({ session: ps.numero, who: initials(a.nom), classe: `NON-ANDPC:${lib}` });
    }
    if (si % 25 === 0) console.log(`  … ampleur ${si}/${perSession.length} (req=${REQ})`);
  }
  console.log(`\n  PENDING total (périmètre) : ${pTot}`);
  console.log(`    → ANDPC [À RELANCER]        : ${pAndpc}`);
  console.log(`    → NON-ANDPC [NE PAS]        : ${pNon}`);
  console.log('        ventilation par libellé :');
  for (const [lib, n] of [...ventil.entries()].sort((a, b) => b[1] - a[1])) console.log(`          ${lib}: ${n}`);
  console.log(`    → AUCUN financement [SIGNALER] : ${pNone}`);
  console.log('  Exemples :');
  for (const e of examples) console.log(`     [${e.session}] ${e.who} → ${e.classe}`);
  dump.ampleur = { pTot, pAndpc, pNon, pNone, ventilation: Object.fromEntries(ventil), examples };

  // ---- Q3 : COÛT ------------------------------------------------------------
  console.log('\n=== Q3 — COÛT ===');
  const perSessionReads = 2; // financements.php + laps.php (fichiers.php déjà lu au backfill)
  console.log(`  Requêtes réelles cette exécution (périmètre ${sessions.length} sessions + résolutions) : ${REQ}`);
  console.log(`  Coût V2 additionnel/session : ${perSessionReads} lectures (financements + laps).`);
  console.log(`  Extrapolation backfill ~1500 sessions × ${perSessionReads} = ~${1500 * perSessionReads} requêtes (hors résolutions financeurs, mises en cache).`);
  console.log(`  Sous le plafond : 100/10s (throttle client 80/10s) et 100 000/jour → ~${Math.ceil(1500 * perSessionReads / 80 * 10 / 60)} min de mur au pire.`);
  dump.cout = { reqRun: REQ, sessions: sessions.length, perSessionReads, backfillEstimate: 1500 * perSessionReads };

  finish();
}

function finish() {
  try { writeFileSync(OUT_FILE, JSON.stringify(dump, null, 2), 'utf8'); console.log(`\n# Brut écrit : ${OUT_FILE}`); }
  catch (e) { console.log('# écriture brut KO :', String(e.message).slice(0, 120)); }
  console.log(`# Total requêtes Dendreo : ${REQ}`);
}

main().catch((err) => { console.error('!! recon interrompue :', String(err && err.message ? err.message : err).slice(0, 300)); process.exit(1); });
