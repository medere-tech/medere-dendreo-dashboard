// scripts/recon-andpc-verif.mjs — S11.0b VÉRIF (LECTURE SEULE, GET only, no commit).
// -----------------------------------------------------------------------------
// Répond à 3 questions par des DONNÉES RÉELLES (zéro supposition) :
//   1. PROUVER que id_financeur/id_opca = "360" est bien l'ANDPC.
//      - a) existe-t-il un endpoint qui NOMME les financeurs (résoudre 360 → nom) ?
//      - b) sinon/aussi : corrélation id_financeur=360 (financements) ⟺ facture
//           id_opca=360 & raison_sociale "ANDPC", mesurée sur N sessions (+ taux).
//      - c) AUCUN autre id ne correspond-il à l'ANDPC ? (map id_opca → raison_sociale)
//   2. montant_finance = HT ou TTC ? somme(montant_finance) vs facture
//      montant_total_ht vs montant_total_ttc. NB : sur ANDPC HT==TTC (TVA 0) → on
//      ajoute des sessions TAXÉES (TVA>0) pour trancher réellement.
//   3. Sessions ANDPC : 0 / 1 / plusieurs factures id_opca=360 ? distribution sur ~20+.
//
// Champs réels confirmés en S11.0 (recon) :
//   financement : id_financeur, montant_finance, type, id_action_de_formation
//   facture     : id_opca, raison_sociale, montant_total_ht, montant_total_ttc,
//                 montant_total_tva, date_emission, date_envoi, date_paiement, statut_facturation
//
// Sécurité : GET only ; clé jamais loggée (client) ; PII personnes masquées en console ;
//   raison_sociale révélée UNIQUEMENT pour un id_opca d'organisme (≠ "0"/"").
//   Brut complet écrit dans le scratchpad (hors repo, non commité).
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { loadDendreoEnv } from '../src/config';
import { DendreoClient } from '../src/dendreo/client';

const OUT_FILE =
  process.argv[2] ||
  'C:\\Users\\DTHI~1\\AppData\\Local\\Temp\\claude\\C--Users-D-thi--Documents-GitHub-medere-dendreo-dashboard\\d276e222-ee90-4a8a-9352-b88693782e98\\scratchpad\\recon-andpc-verif-raw.json';

const client = new DendreoClient(loadDendreoEnv());
const ANDPC_ID = '360';
const MAX_ANDPC = 30; // plafond de sessions ANDPC candidates à sonder
const MAX_TAXED = 8; // sessions taxées (TVA>0) pour trancher HT/TTC

let REQ = 0;
const dump = { note: 'S11.0b verif ANDPC — brut local, non commité', financeurEndpoints: [], sessions: {}, analysis: {} };

function asArray(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.data)) return json.data;
  return json == null ? [] : [json];
}
const num = (v) => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const r2 = (n) => Math.round(n * 100) / 100;
const isAndpcName = (s) => /andpc|agence\s+nationale.*(dpc|développement professionnel)|^dpc$/i.test(String(s || ''));

async function tryGet(label, resource, params) {
  REQ += 1;
  try {
    const json = await client.get(resource, params);
    const arr = asArray(json);
    return { ok: true, json, arr };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err).split('\n')[0].slice(0, 150) };
  }
}

// =============================================================================
// PART 1 — endpoint qui NOMME les financeurs ? (résoudre 360 → nom)
// =============================================================================
async function resolveFinanceurName() {
  console.log('=== PART 1 — endpoint de nommage des financeurs (résoudre id 360) ===');
  const candidates = [
    ['financeurs.php?id=360', 'financeurs.php', { id: ANDPC_ID }],
    ['organismes.php?id=360', 'organismes.php', { id: ANDPC_ID }],
    ['organismes_financeurs.php?id=360', 'organismes_financeurs.php', { id: ANDPC_ID }],
    ['opcas.php?id=360', 'opcas.php', { id: ANDPC_ID }],
    ['opca.php?id=360', 'opca.php', { id: ANDPC_ID }],
    ['entreprises.php?id=360', 'entreprises.php', { id: ANDPC_ID }],
  ];
  let named = null;
  for (const [label, resource, params] of candidates) {
    const r = await tryGet(label, resource, params);
    if (r.ok) {
      const o = r.arr[0] || {};
      // cherche un champ "nom" plausible (raison_sociale / nom / intitule / libelle)
      const nameKey = Object.keys(o).find((k) => /raison_sociale|^nom$|intitule|libelle/i.test(k) && o[k]);
      const nameVal = nameKey ? o[nameKey] : null;
      console.log(`  OK  ${label} → ${r.arr.length} obj ; clés=[${Object.keys(o).slice(0, 12).join(',')}] ; nom(${nameKey})=${JSON.stringify(nameVal)}`);
      dump.financeurEndpoints.push({ label, ok: true, keys: Object.keys(o), nameKey, nameVal, sample: o });
      if (!named && nameVal) named = { label, nameKey, nameVal };
    } else {
      console.log(`  --  ${label} → ${r.error}`);
      dump.financeurEndpoints.push({ label, ok: false, error: r.error });
    }
  }
  // include=financeur sur un financement ? (test sur 1 session ANDPC connue)
  console.log(named
    ? `\n  >>> Endpoint de nommage TROUVÉ : ${named.label} → 360 = ${JSON.stringify(named.nameVal)}`
    : '\n  >>> AUCUN endpoint de nommage direct exploitable pour id 360 (on prouvera via corrélation facture, PART 3).');
  dump.analysis.financeurNamed = named;
  return named;
}

// =============================================================================
// PART 2 — collecte de sessions (ANDPC candidates + taxées) et de leurs
//          financements + factures
// =============================================================================
const SESSION_FIELDS = 'id_action_de_formation,numero_complet,date_debut,date_fin,type,total_participants,num_session_dpc';

async function listYear(year) {
  REQ += 1;
  return asArray(await client.get('actions_de_formation.php', {
    started_after: `${year}-01-01`, started_before: `${year}-12-31`, fields: SESSION_FIELDS,
  }));
}

async function fetchSession(s) {
  const id = s.id_action_de_formation;
  const fin = await tryGet('fin', 'financements.php', { id_action_de_formation: id });
  const fac = await tryGet('fac', 'factures.php', { id_action_de_formation: id });
  const financements = fin.ok ? fin.arr : [];
  const factures = fac.ok ? fac.arr : [];
  const rec = {
    numero: s.numero_complet, numSessionDpc: String(s.num_session_dpc ?? '').trim(),
    financements: financements.map((f) => ({ id_financeur: String(f.id_financeur), type: f.type, montant_finance: f.montant_finance })),
    factures: factures.map((f) => ({
      id_opca: String(f.id_opca), raison_sociale: f.raison_sociale,
      montant_total_ht: f.montant_total_ht, montant_total_ttc: f.montant_total_ttc, montant_total_tva: f.montant_total_tva,
      date_emission: f.date_emission, date_envoi: f.date_envoi, date_paiement: f.date_paiement, statut_facturation: f.statut_facturation,
    })),
  };
  dump.sessions[id] = rec;
  return { id, ...rec };
}

// =============================================================================
async function main() {
  console.log('# S11.0b — VÉRIF ANDPC (id=360) — LECTURE SEULE\n');
  await resolveFinanceurName();

  // Pool de sessions : 2024 + 2025 (DPC plus riche en factures/paiements).
  let all = [];
  for (const y of [2024, 2025]) {
    try { all = all.concat(await listYear(y)); } catch (e) { console.log(`list ${y} KO: ${String(e.message).slice(0, 100)}`); }
  }
  const withDpc = all.filter((s) => String(s.num_session_dpc ?? '').trim() !== '').slice(0, MAX_ANDPC);
  const noDpc = all.filter((s) => String(s.num_session_dpc ?? '').trim() === '' && num(s.total_participants) > 0).slice(0, MAX_TAXED);
  console.log(`\n=== PART 2 — sondage : ${withDpc.length} sessions DPC + ${noDpc.length} sessions non-DPC (taxées probables) ===`);

  const andpcRecs = [];
  for (const s of withDpc) andpcRecs.push(await fetchSession(s));
  const taxedRecs = [];
  for (const s of noDpc) taxedRecs.push(await fetchSession(s));

  // ---- ANALYSE Q1 : corrélation + unicité du mapping ------------------------
  console.log('\n=== Q1 — PREUVE que 360 = ANDPC ===');
  // map id_opca -> set(raison_sociale) sur TOUTES les sessions sondées
  const opcaNames = new Map();
  for (const rec of [...andpcRecs, ...taxedRecs]) {
    for (const f of rec.factures) {
      const k = f.id_opca || '';
      if (!opcaNames.has(k)) opcaNames.set(k, new Set());
      opcaNames.get(k).add(String(f.raison_sociale || ''));
    }
  }
  console.log('  Map id_opca → raison_sociale (organismes ; personnes masquées) :');
  const opcaTable = [];
  for (const [id, names] of [...opcaNames.entries()].sort()) {
    const isOrg = id && id !== '0';
    const shown = isOrg ? [...names].join(' | ') : '‹pers/particulier masqué›';
    console.log(`    id_opca=${id || '∅'} → ${shown}`);
    opcaTable.push({ id_opca: id, raisons: isOrg ? [...names] : ['(masqué)'] });
  }
  dump.analysis.opcaTable = opcaTable;

  // corrélation sur les sessions DPC : has fin 360 ⟺ facture id_opca 360 & raison ANDPC
  let both = 0, finOnly = 0, facOnly = 0, neither = 0, andpcRaisonOk = 0, andpcFacTotal = 0;
  for (const rec of andpcRecs) {
    const hasFin360 = rec.financements.some((f) => f.id_financeur === ANDPC_ID);
    const fac360 = rec.factures.filter((f) => f.id_opca === ANDPC_ID);
    andpcFacTotal += fac360.length;
    for (const f of fac360) if (isAndpcName(f.raison_sociale)) andpcRaisonOk += 1;
    if (hasFin360 && fac360.length) both += 1;
    else if (hasFin360) finOnly += 1;
    else if (fac360.length) facOnly += 1;
    else neither += 1;
  }
  const denom = both + finOnly + facOnly;
  console.log(`\n  Corrélation sur ${andpcRecs.length} sessions DPC sondées :`);
  console.log(`    fin360 & fac360 : ${both}`);
  console.log(`    fin360 seul (pas de facture 360) : ${finOnly}`);
  console.log(`    fac360 seul (pas de financement 360) : ${facOnly}`);
  console.log(`    ni l'un ni l'autre : ${neither}`);
  console.log(`    → taux de concordance fin360⟺fac360 : ${denom ? r2((both / denom) * 100) : 0}% (${both}/${denom})`);
  console.log(`    → factures id_opca=360 dont raison_sociale ~ "ANDPC" : ${andpcRaisonOk}/${andpcFacTotal}`);
  // autre id = ANDPC ?
  const otherAndpc = [...opcaNames.entries()].filter(([id, names]) => id !== ANDPC_ID && [...names].some(isAndpcName));
  const id360names = [...(opcaNames.get(ANDPC_ID) || [])];
  console.log(`\n  Unicité : id_opca=360 → raison(s) = ${JSON.stringify(id360names)}`);
  console.log(`  Autre(s) id_opca portant un nom "ANDPC" : ${otherAndpc.length ? otherAndpc.map(([id]) => id).join(', ') : 'AUCUN'}`);
  dump.analysis.correlation = { sessions: andpcRecs.length, both, finOnly, facOnly, neither, andpcRaisonOk, andpcFacTotal, id360names, otherAndpc: otherAndpc.map(([id]) => id) };

  // ---- ANALYSE Q2 : HT ou TTC ? --------------------------------------------
  console.log('\n=== Q2 — montant_finance = HT ou TTC ? ===');
  const cmp = (rec, financeurId) => {
    const sumFin = r2(rec.financements.filter((f) => f.id_financeur === financeurId).reduce((a, f) => a + num(f.montant_finance), 0));
    const facs = rec.factures.filter((f) => f.id_opca === financeurId);
    const sumHt = r2(facs.reduce((a, f) => a + num(f.montant_total_ht), 0));
    const sumTtc = r2(facs.reduce((a, f) => a + num(f.montant_total_ttc), 0));
    const sumTva = r2(facs.reduce((a, f) => a + num(f.montant_total_tva), 0));
    return { numero: rec.numero, financeurId, nFin: rec.financements.filter((f) => f.id_financeur === financeurId).length, nFac: facs.length, sumFin, sumHt, sumTtc, sumTva };
  };
  console.log('  (a) Sessions ANDPC (id 360) — attention HT==TTC si TVA 0 :');
  const q2andpc = andpcRecs.filter((r) => r.financements.some((f) => f.id_financeur === ANDPC_ID) && r.factures.some((f) => f.id_opca === ANDPC_ID)).slice(0, 3).map((r) => cmp(r, ANDPC_ID));
  for (const c of q2andpc) console.log(`    ${c.numero}: Σfin=${c.sumFin} | HT=${c.sumHt} | TTC=${c.sumTtc} | TVA=${c.sumTva} | (finΣ==HT? ${c.sumFin === c.sumHt} ; finΣ==TTC? ${c.sumFin === c.sumTtc})`);
  console.log('  (b) Sessions TAXÉES (TVA>0) pour trancher — financeur dominant :');
  const q2tax = [];
  for (const rec of taxedRecs) {
    // financeur dominant = celui avec le + de factures ayant TVA>0
    const taxed = rec.factures.filter((f) => num(f.montant_total_tva) > 0);
    if (!taxed.length) continue;
    const fid = taxed[0].id_opca; // souvent 0 pour entreprise/particulier
    // pour type entreprise/particulier id_financeur==id_finance ; on compare toute la session
    const sumFinAll = r2(rec.financements.reduce((a, f) => a + num(f.montant_finance), 0));
    const sumHtAll = r2(rec.factures.reduce((a, f) => a + num(f.montant_total_ht), 0));
    const sumTtcAll = r2(rec.factures.reduce((a, f) => a + num(f.montant_total_ttc), 0));
    const sumTvaAll = r2(rec.factures.reduce((a, f) => a + num(f.montant_total_tva), 0));
    const row = { numero: rec.numero, sumFinAll, sumHtAll, sumTtcAll, sumTvaAll };
    q2tax.push(row);
    console.log(`    ${rec.numero}: Σfin(all)=${sumFinAll} | ΣHT(all)=${sumHtAll} | ΣTTC(all)=${sumTtcAll} | ΣTVA=${sumTvaAll} | (finΣ≈HT? ${Math.abs(sumFinAll - sumHtAll) < 0.02} ; finΣ≈TTC? ${Math.abs(sumFinAll - sumTtcAll) < 0.02})`);
    if (q2tax.length >= 4) break;
  }
  dump.analysis.q2 = { andpc: q2andpc, taxed: q2tax };

  // ---- ANALYSE Q3 : multiplicité des factures ANDPC -------------------------
  console.log('\n=== Q3 — nb de factures id_opca=360 par session ANDPC ===');
  const dist = {};
  const andpcSessions = andpcRecs.filter((r) => r.financements.some((f) => f.id_financeur === ANDPC_ID));
  const anomalies = [];
  for (const rec of andpcSessions) {
    const n = rec.factures.filter((f) => f.id_opca === ANDPC_ID).length;
    dist[n] = (dist[n] || 0) + 1;
    if (n !== 1) anomalies.push({ numero: rec.numero, nFac360: n });
  }
  console.log(`  Sessions ANDPC (financement 360) mesurées : ${andpcSessions.length}`);
  console.log(`  Distribution nb factures 360/session : ${JSON.stringify(dist)}`);
  console.log(`  Anomalies (≠1 facture) : ${anomalies.length ? JSON.stringify(anomalies) : 'aucune'}`);
  // rappel : combien de LIGNES de financement 360 par session (pour montrer fin≫fac)
  const finLineStats = andpcSessions.map((r) => r.financements.filter((f) => f.id_financeur === ANDPC_ID).length);
  console.log(`  (rappel) lignes financement 360/session : min=${Math.min(...finLineStats)} max=${Math.max(...finLineStats)} → les financements sont PAR PARTICIPANT, la facture AGRÈGE.`);
  dump.analysis.q3 = { andpcSessions: andpcSessions.length, dist, anomalies };

  // ---- bonus V3 : aperçu des champs date sur factures ANDPC -----------------
  console.log('\n=== Bonus V3 — champs date sur factures ANDPC (pour "date de dépôt/envoi") ===');
  const sample = andpcSessions.flatMap((r) => r.factures.filter((f) => f.id_opca === ANDPC_ID)).slice(0, 5);
  for (const f of sample) console.log(`    emission=${JSON.stringify(f.date_emission)} envoi=${JSON.stringify(f.date_envoi)} paiement=${JSON.stringify(f.date_paiement)} statut=${f.statut_facturation}`);

  finish();
}

function finish() {
  try { writeFileSync(OUT_FILE, JSON.stringify(dump, null, 2), 'utf8'); console.log(`\n# Brut écrit : ${OUT_FILE}`); }
  catch (e) { console.log('# écriture brut KO :', String(e.message).slice(0, 120)); }
  console.log(`# Total requêtes Dendreo : ${REQ}`);
}

main().catch((err) => { console.error('!! verif interrompue :', String(err && err.message ? err.message : err).slice(0, 300)); process.exit(1); });
