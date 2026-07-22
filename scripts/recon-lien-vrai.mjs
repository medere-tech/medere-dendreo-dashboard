// scripts/recon-lien-vrai.mjs — S11.0e DISCOVERY du VRAI lien participant↔financement.
// LECTURE SEULE (GET only), aucun commit. Hypothèse id_finance=idParticipant/id_lap RÉFUTÉE.
// -----------------------------------------------------------------------------
// On ne devine plus : on DUMPE le brut, on teste les include, on RÉSOUT un id_finance réel.
//   1. JSON complet brut d'UN financement + d'UNE inscription (laps) + d'UN participant.
//      → repérer un champ commun (id_lap / id_participant / id_finance / id_financement…).
//   2. financements.php?...&include=participant|lap|finance|entreprise|financeur|tiers|contact.
//      → un include peut matérialiser l'entité liée. On montre les NOUVELLES clés/objets.
//   3. Résoudre un id_finance ANDPC réel via plusieurs endpoints (financeurs/entreprises/
//      participants/laps/tiers/contacts). → à QUOI correspond id_finance ?
//   4. laps.php : porte-t-il un champ de financement/prix par participant ? (le lien est peut-être ici)
//
// Sécurité : GET only ; clé jamais loggée ; noms de personnes masqués ; brut → scratchpad (hors repo).
// Usage : npx tsx scripts/recon-lien-vrai.mjs [YYYY-MM-DD_ceil]
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { loadDendreoEnv } from '../src/config';
import { DendreoClient } from '../src/dendreo/client';

const TODAY = process.argv[3] || '2026-07-21';
const OUT_FILE =
  process.argv[2] ||
  'C:\\Users\\DTHI~1\\AppData\\Local\\Temp\\claude\\C--Users-D-thi--Documents-GitHub-medere-dendreo-dashboard\\d276e222-ee90-4a8a-9352-b88693782e98\\scratchpad\\recon-lien-vrai-raw.json';

const client = new DendreoClient(loadDendreoEnv());
const ANDPC_ID = '360';
let REQ = 0;
const dump = { note: 'S11.0e vrai lien — brut local, non commité', steps: {} };

function asArray(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.data)) return json.data;
  return json == null ? [] : [json];
}
async function tryGet(resource, params) {
  REQ += 1;
  try { const json = await client.get(resource, params); return { ok: true, json, arr: asArray(json) }; }
  catch (err) { return { ok: false, error: String(err && err.message ? err.message : err).split('\n')[0].slice(0, 160) }; }
}

// masque récursif des PII personnes ; garde ids, montants, dates, raison_sociale (organisme)
const PII_KEY = /(prenom|prénom|^nom$|nom_complet|nom_usage|email|e?_?mail|telephone|^tel$|portable|mobile|^fax$|adresse|naissance|secu|^iban$|^bic$|^rib$|civilite|signataire|contact_|num_secu)/i;
function mask(v, key = '') {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map((x) => mask(x));
  if (typeof v === 'object') { const o = {}; for (const [k, val] of Object.entries(v)) o[k] = mask(val, k); return o; }
  if (PII_KEY.test(key)) return '‹pii›';
  if (/@/.test(String(v))) return '‹email›';
  return v;
}
const keys = (o) => (o && typeof o === 'object' ? Object.keys(o) : []);
const pretty = (o) => JSON.stringify(mask(o), null, 2).split('\n').map((l) => '    ' + l).join('\n');

async function pickSession() {
  REQ += 1;
  const list = asArray(await client.get('actions_de_formation.php', {
    started_after: '2026-01-01', ended_before: TODAY,
    fields: 'id_action_de_formation,numero_complet,date_debut,date_fin',
  }));
  for (const s of list) {
    const fin = await tryGet('financements.php', { id_action_de_formation: s.id_action_de_formation });
    if (fin.ok && fin.arr.some((f) => String(f.id_financeur) === ANDPC_ID)) {
      return { session: s, financements: fin.arr };
    }
  }
  return null;
}

async function main() {
  console.log(`# S11.0e — VRAI lien participant↔financement (périmètre 2026) — LECTURE SEULE\n`);
  const picked = await pickSession();
  if (!picked) { console.log('Aucune session ANDPC trouvée.'); return finish(); }
  const { session, financements } = picked;
  const idAdf = session.id_action_de_formation;
  console.log(`Session : ${session.numero_complet} (id=${idAdf}) — ${financements.length} financements\n`);

  // === STEP 1 — JSON complet brut : financement / lap / participant ==========
  console.log('=== STEP 1 — JSON BRUT complet (financement, inscription, participant) ===');
  const finOpca = financements.find((f) => String(f.id_financeur) === ANDPC_ID) || financements[0];
  const finPart = financements.find((f) => f.type === 'particulier') || null;
  console.log('\n[1a] FINANCEMENT ANDPC brut (toutes clés) :');
  console.log('  clés:', keys(finOpca).join(', '));
  console.log(pretty(finOpca));
  if (finPart) { console.log('\n[1a bis] FINANCEMENT particulier brut :'); console.log(pretty(finPart)); }

  const lapsRes = await tryGet('laps.php', { id_action_de_formation: idAdf, include: 'participant' });
  const laps = lapsRes.ok ? lapsRes.arr : [];
  const lap0 = laps[0] || null;
  console.log('\n[1b] INSCRIPTION (laps.php) brut — 1re :');
  if (lap0) { console.log('  clés:', keys(lap0).join(', ')); console.log(pretty(lap0)); }
  else console.log('  (laps indisponible :', lapsRes.error, ')');

  const pid = lap0 ? (lap0.id_participant ?? lap0.participant?.id_participant) : null;
  if (pid) {
    const pRes = await tryGet('participants.php', { id: pid });
    console.log(`\n[1c] PARTICIPANT (participants.php?id=${pid}) brut :`);
    if (pRes.ok && pRes.arr[0]) { console.log('  clés:', keys(pRes.arr[0]).join(', ')); console.log(pretty(pRes.arr[0])); }
    else console.log('  (indisponible :', pRes.error, ')');
    dump.steps.participant = pRes.ok ? pRes.arr[0] : { error: pRes.error };
  }

  // repérage de champs candidats de liaison présents des 2 côtés
  const finKeys = new Set(keys(finOpca));
  const lapKeys = new Set(keys(lap0 || {}));
  const common = [...finKeys].filter((k) => lapKeys.has(k));
  console.log('\n[1d] Clés COMMUNES financement ∩ inscription :', common.length ? common.join(', ') : '(aucune)');
  console.log('     Clés du financement évoquant un lien (id_*):', [...finKeys].filter((k) => /^id_/.test(k)).join(', '));
  console.log('     Clés de l\'inscription évoquant financement/prix:', [...lapKeys].filter((k) => /financ|prix|montant|opca|tarif|cout|tva|tiers|payeur|finance/i.test(k)).join(', ') || '(aucune)');
  dump.steps.step1 = { finKeys: [...finKeys], lapKeys: [...lapKeys], common, finOpca, lap0 };

  // === STEP 2 — INCLUDE sur financements.php ================================
  console.log('\n=== STEP 2 — financements.php?...&include=… (matérialiser l\'entité liée) ===');
  const includes = ['participant', 'lap', 'finance', 'entreprise', 'financeur', 'tiers', 'contact', 'inscription'];
  const baseKeys = new Set(keys(finOpca));
  dump.steps.includes = {};
  for (const inc of includes) {
    const r = await tryGet('financements.php', { id_action_de_formation: idAdf, include: inc });
    if (!r.ok) { console.log(`  include=${inc} → ERR ${r.error}`); dump.steps.includes[inc] = { error: r.error }; continue; }
    const o = r.arr[0] || {};
    const newKeys = keys(o).filter((k) => !baseKeys.has(k));
    console.log(`  include=${inc} → ${r.arr.length} lignes ; NOUVELLES clés: ${newKeys.length ? newKeys.join(', ') : '(aucune)'}`);
    if (newKeys.length) console.log('     détail nouvelles clés :', JSON.stringify(mask(Object.fromEntries(newKeys.map((k) => [k, o[k]])))));
    dump.steps.includes[inc] = { count: r.arr.length, newKeys, sample: newKeys.length ? Object.fromEntries(newKeys.map((k) => [k, o[k]])) : null };
  }

  // === STEP 3 — résoudre un id_finance réel ================================
  const idFinance = String(finOpca.id_finance);
  console.log(`\n=== STEP 3 — résoudre id_finance=${idFinance} (financement ANDPC) ===`);
  const resolvers = ['financeurs.php', 'entreprises.php', 'participants.php', 'laps.php', 'tiers.php', 'contacts.php', 'organismes.php', 'financements.php'];
  dump.steps.resolve = {};
  for (const res of resolvers) {
    const r = await tryGet(res, { id: idFinance });
    if (!r.ok) { console.log(`  ${res}?id=${idFinance} → ERR ${r.error}`); dump.steps.resolve[res] = { error: r.error }; continue; }
    const o = r.arr[0] || {};
    const nameKey = keys(o).find((k) => /raison_sociale|^nom$|intitule|libelle/i.test(k));
    console.log(`  ${res}?id=${idFinance} → ${r.arr.length} obj ; clés=[${keys(o).slice(0, 14).join(',')}] ; nom(${nameKey})=${nameKey ? JSON.stringify(mask(o[nameKey], nameKey)) : '—'}`);
    dump.steps.resolve[res] = { count: r.arr.length, keys: keys(o), sample: mask(o) };
  }

  // === STEP 4 — laps.php : champ de financement/prix par participant ? ======
  console.log('\n=== STEP 4 — laps.php : y a-t-il un financement/prix PAR inscription ? ===');
  // includes possibles sur laps pour révéler le financement
  for (const inc of ['financement', 'financements', 'finance', 'opca', 'financeur']) {
    const r = await tryGet('laps.php', { id_action_de_formation: idAdf, include: inc });
    if (!r.ok) { console.log(`  laps include=${inc} → ERR ${r.error}`); continue; }
    const o = r.arr[0] || {};
    const finish2 = keys(o).filter((k) => /financ|opca|prix|montant|tarif|cout|finance/i.test(k));
    const nested = keys(o).filter((k) => o[k] && typeof o[k] === 'object');
    console.log(`  laps include=${inc} → clés finance: ${finish2.join(', ') || '(aucune)'} ; sous-objets: ${nested.join(', ') || '(aucun)'}`);
    if (nested.some((k) => /financ|opca|finance/i.test(k))) {
      const fk = nested.find((k) => /financ|opca|finance/i.test(k));
      console.log(`     → ${fk} =`, JSON.stringify(mask(o[fk])).slice(0, 400));
    }
  }
  dump.steps.step4Note = 'voir clés laps ci-dessus';

  finish();
}

function finish() {
  try { writeFileSync(OUT_FILE, JSON.stringify(dump, null, 2), 'utf8'); console.log(`\n# Brut écrit : ${OUT_FILE}`); }
  catch (e) { console.log('# écriture brut KO :', String(e.message).slice(0, 120)); }
  console.log(`# Total requêtes Dendreo : ${REQ}`);
}

main().catch((err) => { console.error('!! recon interrompue :', String(err && err.message ? err.message : err).slice(0, 300)); process.exit(1); });
