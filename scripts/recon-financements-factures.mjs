// scripts/recon-financements-factures.mjs — S11.0 RECON (LECTURE SEULE Dendreo).
// -----------------------------------------------------------------------------
// Script JETABLE, GET UNIQUEMENT. Objectif : DÉCOUVRIR (sans rien deviner) les
// endpoints/champs Dendreo pour V2 (FINANCEMENTS) et V3 (FACTURES) d'une session.
//
// Méthode "zéro supposition" :
//   - on ESSAIE plusieurs endpoints/paramètres candidats et on rapporte lequel
//     renvoie réellement des lignes (les autres échouent proprement, sans effet) ;
//   - pour l'endpoint qui marche, on DUMPE les CLÉS + VALEURS réelles → on lit les
//     vrais noms de champs (financeur, montant HT, dates…) au lieu de les inventer.
//
// Sécurité :
//   - GET only, jamais d'écriture Dendreo (DendreoClient est read-only).
//   - la clé API n'est jamais loggée (le client la rédige).
//   - CONSOLE : masque les PII de personnes (prénom, email, tel, adresse, IBAN…),
//     garde visibles les noms d'ORGANISMES financeurs (ANDPC, OPCO…) = le livrable.
//   - RAW : le JSON brut complet est écrit dans le SCRATCHPAD (hors repo, non commité)
//     pour analyse fine ; il n'est jamais imprimé tel quel dans la console.
//
// Usage (PowerShell) :
//   npx tsx scripts/recon-financements-factures.mjs
//   npx tsx scripts/recon-financements-factures.mjs "C:\chemin\raw.json"
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { loadDendreoEnv } from '../src/config';
import { DendreoClient } from '../src/dendreo/client';

const OUT_FILE =
  process.argv[2] ||
  'C:\\Users\\DTHI~1\\AppData\\Local\\Temp\\claude\\C--Users-D-thi--Documents-GitHub-medere-dendreo-dashboard\\d276e222-ee90-4a8a-9352-b88693782e98\\scratchpad\\recon-fin-fact-raw.json';

const client = new DendreoClient(loadDendreoEnv());

// --- compteur d'appels (pour l'estimation de coût quota) --------------------
let REQ = 0;
const rawDump = { generatedAtNote: 'S11.0 recon financements/factures — brut local, non commité', sessions: {}, probes: [] };

function asArray(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.data)) return json.data;
  return json == null ? [] : [json];
}

// --- masquage PII pour la CONSOLE -------------------------------------------
// Denylist = identité de personne. Allowlist = organisme financeur/payeur (le livrable).
const PII_KEY = /(prenom|prénom|^nom$|nom_complet|email|e?_?mail|telephone|^tel$|portable|mobile|^fax$|adresse|naissance|secu|securite_sociale|^iban$|^bic$|^rib$|civilite|signataire|contact_)/i;
const KEEP_KEY = /(financeur|organisme|payeur|opco|raison_sociale|type_financement|libelle|intitule|reference)/i;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

function maskConsole(value, key = '') {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => maskConsole(v));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskConsole(v, k);
    return out;
  }
  const str = String(value);
  if (KEEP_KEY.test(key)) return value; // organisme financeur → visible
  if (PII_KEY.test(key)) return '‹pii›';
  if (EMAIL_RE.test(str)) return '‹email›';
  return value;
}

function keysOf(obj) {
  return obj && typeof obj === 'object' ? Object.keys(obj) : [];
}

// --- GET tolérant : rapporte OK/échec sans jamais casser le run --------------
async function tryGet(label, resource, params) {
  REQ += 1;
  try {
    const json = await client.get(resource, params);
    const arr = asArray(json);
    const shape = Array.isArray(json) ? `array[${arr.length}]` : `object(keys=${keysOf(json).length})`;
    console.log(`  OK  ${label}  →  ${shape}`);
    rawDump.probes.push({ label, resource, params, ok: true, count: arr.length, sample: arr.slice(0, 3) });
    return { ok: true, json, arr };
  } catch (err) {
    const msg = String(err && err.message ? err.message : err).split('\n')[0].slice(0, 160);
    console.log(`  --  ${label}  →  ${msg}`);
    rawDump.probes.push({ label, resource, params, ok: false, error: msg });
    return { ok: false, error: msg };
  }
}

// =============================================================================
// 0) Choix de sessions réelles VARIÉES (avec / sans num_session_dpc)
// =============================================================================
const SESSION_FIELDS = [
  'id_action_de_formation', 'numero_complet', 'intitule',
  'date_debut', 'date_fin', 'type', 'total_participants',
  'num_session_dpc', 'numero_comptable', 'id_etape_process',
].join(',');

async function listYear(year) {
  REQ += 1;
  const a = asArray(await client.get('actions_de_formation.php', {
    started_after: `${year}-01-01`, started_before: `${year}-12-31`, fields: SESSION_FIELDS,
  }));
  return a;
}

function pickVaried(sessions) {
  const withDpc = sessions.filter((s) => String(s.num_session_dpc ?? '').trim() !== '');
  const noDpc = sessions.filter((s) => String(s.num_session_dpc ?? '').trim() === '' && Number(s.total_participants ?? 0) > 0);
  const chosen = [];
  for (const s of withDpc.slice(0, 3)) chosen.push({ ...s, hint: 'a_num_session_dpc' });
  for (const s of noDpc.slice(0, 3)) chosen.push({ ...s, hint: 'sans_num_session_dpc' });
  return chosen;
}

// =============================================================================
// 1) FINANCEMENTS — découverte d'endpoint/param
// =============================================================================
async function discoverFinancements(adfId) {
  console.log(`\n### FINANCEMENTS — découverte endpoint (session id=${adfId}) ###`);
  const candidates = [
    ['financements.php?id_action_de_formation', 'financements.php', { id_action_de_formation: adfId }],
    ['financements.php?id_adf', 'financements.php', { id_adf: adfId }],
    ['actions_de_formation.php?id&include=financements', 'actions_de_formation.php', { id: adfId, include: 'financements' }],
    ['actions_de_formation.php?id&include=financement', 'actions_de_formation.php', { id: adfId, include: 'financement' }],
  ];
  let winner = null;
  for (const [label, resource, params] of candidates) {
    const r = await tryGet(label, resource, params);
    if (r.ok && r.arr.length && !winner) winner = { label, resource, params, arr: r.arr, json: r.json };
  }
  if (!winner) {
    console.log('  (aucun candidat financement n\'a renvoyé de lignes pour cette session)');
    return null;
  }
  console.log(`\n  >>> Endpoint financement RETENU : ${winner.label} — ${winner.arr.length} ligne(s)`);
  const first = winner.arr[0];
  console.log('  Clés d\'un financement :', keysOf(first).join(', '));
  console.log('  Financement #1 (masqué console) :');
  console.log(JSON.stringify(maskConsole(first), null, 2).split('\n').map((l) => '    ' + l).join('\n'));
  return winner;
}

// =============================================================================
// 2) FACTURES — découverte d'endpoint/param
// =============================================================================
async function discoverFactures(adfId) {
  console.log(`\n### FACTURES — découverte endpoint (session id=${adfId}) ###`);
  const candidates = [
    ['factures.php?id_action_de_formation', 'factures.php', { id_action_de_formation: adfId }],
    ['factures.php?id_adf', 'factures.php', { id_adf: adfId }],
    ['factures.php?id_action_de_formation&include=lignes', 'factures.php', { id_action_de_formation: adfId, include: 'lignes' }],
    ['actions_de_formation.php?id&include=factures', 'actions_de_formation.php', { id: adfId, include: 'factures' }],
  ];
  let winner = null;
  for (const [label, resource, params] of candidates) {
    const r = await tryGet(label, resource, params);
    if (r.ok && r.arr.length && !winner) winner = { label, resource, params, arr: r.arr, json: r.json };
  }
  if (!winner) {
    console.log('  (aucun candidat facture n\'a renvoyé de lignes pour cette session)');
    return null;
  }
  console.log(`\n  >>> Endpoint facture RETENU : ${winner.label} — ${winner.arr.length} ligne(s)`);
  const first = winner.arr[0];
  console.log('  Clés d\'une facture :', keysOf(first).join(', '));
  console.log('  Facture #1 (masqué console) :');
  console.log(JSON.stringify(maskConsole(first), null, 2).split('\n').map((l) => '    ' + l).join('\n'));
  return winner;
}

// =============================================================================
// 3) Balayage multi-sessions avec l'endpoint retenu (financeurs + montants +
//    multiplicité) — sans deviner : on relit les clés trouvées à l'étape 1/2.
// =============================================================================
async function sweep(chosen, finWin, facWin) {
  console.log(`\n### BALAYAGE ${chosen.length} sessions (financements + factures) ###`);
  for (const s of chosen) {
    const id = s.id_action_de_formation;
    const tag = `${s.numero_complet} (id=${id}, ${s.hint}, dpc=${String(s.num_session_dpc ?? '').trim() || '—'})`;
    console.log(`\n  ── ${tag}`);

    if (finWin) {
      REQ += 1;
      try {
        const arr = asArray(await client.get(finWin.resource, { ...finWin.params, ...replaceId(finWin.params, id) }));
        const items = extractItems(arr, finWin, 'financements');
        console.log(`     financements : ${items.length}`);
        console.log('     brut (masqué) :', JSON.stringify(maskConsole(items), null, 0).slice(0, 900));
        rawDump.sessions[id] ||= {};
        rawDump.sessions[id].numero = s.numero_complet;
        rawDump.sessions[id].hint = s.hint;
        rawDump.sessions[id].financements = items;
      } catch (err) {
        console.log('     financements : échec', String(err.message).slice(0, 120));
      }
    }

    if (facWin) {
      REQ += 1;
      try {
        const arr = asArray(await client.get(facWin.resource, { ...facWin.params, ...replaceId(facWin.params, id) }));
        const items = extractItems(arr, facWin, 'factures');
        console.log(`     factures : ${items.length}`);
        console.log('     brut (masqué) :', JSON.stringify(maskConsole(items), null, 0).slice(0, 1200));
        rawDump.sessions[id] ||= {};
        rawDump.sessions[id].numero = s.numero_complet;
        rawDump.sessions[id].factures = items;
      } catch (err) {
        console.log('     factures : échec', String(err.message).slice(0, 120));
      }
    }
  }
}

// remplace la valeur d'id dans le param d'origine (le param d'id peut être
// id_action_de_formation OU id selon l'endpoint retenu)
function replaceId(params, id) {
  const out = {};
  for (const k of Object.keys(params)) if (/^id(_action_de_formation|_adf)?$/.test(k)) out[k] = id;
  return out;
}

// si l'endpoint retenu est actions_de_formation?include=..., les items sont
// imbriqués dans l'ADF ; sinon c'est déjà la liste. On relit la forme réelle.
function extractItems(arr, winner, kind) {
  if (winner.resource === 'actions_de_formation.php') {
    const adf = arr[0] || {};
    // on ne devine pas la clé : on prend la 1re clé tableau qui ressemble à kind
    for (const [k, v] of Object.entries(adf)) {
      if (Array.isArray(v) && (k.includes(kind.slice(0, 7)) || k.includes('financ') || k.includes('factur'))) return v;
    }
    return [];
  }
  return arr;
}

// =============================================================================
async function main() {
  console.log('# S11.0 RECON financements/factures — LECTURE SEULE (GET only)\n');

  // Sessions : on tente 2025 (plus de factures/paiements probables) puis 2026.
  let sessions = [];
  try { sessions = await listYear(2025); } catch (e) { console.log('list 2025 KO:', String(e.message).slice(0, 120)); }
  console.log(`Sessions 2025 : ${sessions.length}`);
  if (sessions.length < 6) {
    try {
      const s26 = await listYear(2026);
      console.log(`Sessions 2026 : ${s26.length}`);
      sessions = sessions.concat(s26);
    } catch (e) { console.log('list 2026 KO:', String(e.message).slice(0, 120)); }
  }

  const chosen = pickVaried(sessions);
  console.log(`\nSessions choisies (${chosen.length}) :`);
  for (const s of chosen) console.log(`  - ${s.numero_complet} id=${s.id_action_de_formation} [${s.hint}] part=${s.total_participants} dpc=${String(s.num_session_dpc ?? '').trim() || '—'}`);
  if (!chosen.length) { console.log('Aucune session — stop.'); return finish(); }

  // Découverte d'endpoint sur la 1re session choisie, puis fallback sur les suivantes
  let finWin = null, facWin = null;
  for (const s of chosen) {
    if (!finWin) finWin = await discoverFinancements(s.id_action_de_formation);
    if (!facWin) facWin = await discoverFactures(s.id_action_de_formation);
    if (finWin && facWin) break;
  }

  await sweep(chosen, finWin, facWin);

  finish();
}

function finish() {
  try {
    writeFileSync(OUT_FILE, JSON.stringify(rawDump, null, 2), 'utf8');
    console.log(`\n# Brut complet écrit dans : ${OUT_FILE}`);
  } catch (e) {
    console.log('# écriture brut KO (non bloquant) :', String(e.message).slice(0, 160));
  }
  console.log(`# Total requêtes Dendreo cette exécution : ${REQ}`);
  console.log('# (endpoint retenu : voir lignes ">>> ... RETENU" ci-dessus)');
}

main().catch((err) => {
  console.error('!! recon interrompue :', String(err && err.message ? err.message : err).slice(0, 300));
  process.exit(1);
});
