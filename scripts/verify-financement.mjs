// scripts/verify-financement.mjs — VÉRIF RÉELLE de l'enrichissement S11.1.
// -----------------------------------------------------------------------------
// 100% LECTURE. AUCUNE écriture Firestore, AUCUN commit. Affichage de CONTRÔLE :
// appelle enrichFinancement(idAdf, client) POUR DE VRAI sur 4 sessions variées du
// périmètre 2026 et montre ce qui SERAIT écrit dans le miroir + la classification
// des participants (ANDPC / non-ANDPC / null). À comparer avec Dendreo à la main.
//
// Variété visée : (a) plusieurs factures ANDPC, (b) financement mixte ANDPC+particulier,
//                 (c) sans facture ANDPC, (d) une ANDPC quelconque en complément.
//
// Usage :
//   npx tsx scripts/verify-financement.mjs                 # 4 sessions variées du périmètre
//   npx tsx scripts/verify-financement.mjs <idAdf>         # UNE session ciblée (même hors périmètre)
//   npx tsx scripts/verify-financement.mjs YYYY-MM-DD      # override du plafond de périmètre
// -----------------------------------------------------------------------------

import { loadDendreoEnv } from '../src/config';
import { DendreoClient } from '../src/dendreo/client';
import { enrichFinancement, ensureAndpcValidated, ANDPC_ID } from '../src/dendreo/financement';

const ARG = process.argv[2];
const TARGET_ID = ARG && /^\d+$/.test(ARG) ? ARG : null; // idAdf = numérique pur
const TODAY = ARG && /^\d{4}-\d{2}-\d{2}$/.test(ARG) ? ARG : (process.argv[3] || '2026-07-21');
const client = new DendreoClient(loadDendreoEnv());
const SCAN_CAP = 90; // sessions max à sonder pour trouver la variété

let REQ = 0;
function asArray(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.data)) return json.data;
  return json == null ? [] : [json];
}
async function get(resource, params) { REQ += 1; return asArray(await client.get(resource, params)); }

/** Affiche le résultat enrichFinancement + la classification participants pour une session. */
async function showEnrich(id, header) {
  console.log(header);
  const r = await enrichFinancement(id, client);
  console.log('   → CE QUI SERAIT ÉCRIT dans sessions/{idAdf} :');
  console.log(`        financeurAndpc      : ${r.session.financeurAndpc}`);
  console.log(`        montantAndpc        : ${r.session.montantAndpc}`);
  console.log(`        factureMontantHt    : ${r.session.factureMontantHt}`);
  console.log(`        factureDateEnvoi    : ${r.session.factureDateEnvoi}`);
  console.log(`        factureDatePaiement : ${r.session.factureDatePaiement}`);
  let a = 0, n = 0, z = 0;
  for (const v of r.financeurByParticipant.values()) { if (v === true) a += 1; else if (v === false) n += 1; else z += 1; }
  console.log(`   → participants classés : ANDPC=${a} | non-ANDPC=${n} | null(aucun financement)=${z} | total inscriptions=${r.financeurByParticipant.size}`);
  return r;
}

/** Détail BRUT des factures id_opca=360 (pour comparaison directe avec Dendreo). */
async function showRawAndpcFactures(id) {
  let fac = [];
  try { fac = await get('factures.php', { id_action_de_formation: id }); } catch (e) { console.log('   (factures.php KO :', String(e.message).slice(0, 100), ')'); return; }
  const f360 = fac.filter((f) => String(f.id_opca) === ANDPC_ID);
  console.log(`   → factures brutes id_opca=360 (${f360.length}) — à recouper avec Dendreo :`);
  if (!f360.length) { console.log('        (aucune facture ANDPC sur cette session)'); return; }
  let somme = 0;
  for (const f of f360) {
    const ht = Number(String(f.montant_total_ht ?? '').replace(',', '.')) || 0;
    somme += ht;
    console.log(`        ${f.numero_complet ?? '(sans n°)'} | HT=${f.montant_total_ht} | envoi=${f.date_envoi || '∅'} | paiement=${f.date_paiement || '∅'} | émission=${f.date_emission || '∅'}`);
  }
  console.log(`        Σ HT (contrôle) = ${Math.round(somme * 100) / 100}`);
}

async function main() {
  console.log(`# VÉRIF S11.1 enrichFinancement — LECTURE SEULE (aucune écriture Firestore)${TARGET_ID ? ` — cible idAdf=${TARGET_ID}` : ` — plafond ${TODAY}`}\n`);
  const validated = await ensureAndpcValidated(client);
  console.log(`Validation libellé ANDPC (financeurs.php?id=${ANDPC_ID}) : ${validated ? 'OK "ANDPC"' : '⚠ NON validé (voir alerte ci-dessus)'}\n`);

  // ---- Mode CIBLÉ : une seule session par idAdf (même hors périmètre) -------
  if (TARGET_ID) {
    let numero = `id ${TARGET_ID}`;
    try {
      const adf = await get('actions_de_formation.php', { id: TARGET_ID, fields: 'id_action_de_formation,numero_complet,date_debut,date_fin' });
      if (adf[0]) numero = `${adf[0].numero_complet} (id=${TARGET_ID}) [${adf[0].date_debut} → ${adf[0].date_fin}]`;
      else console.log(`⚠ actions_de_formation.php?id=${TARGET_ID} ne renvoie rien — session inconnue côté Dendreo ?`);
    } catch (e) { console.log('lecture ADF KO :', String(e.message).slice(0, 100)); }

    await showEnrich(TARGET_ID, `══ ${numero}`);
    await showRawAndpcFactures(TARGET_ID);
    console.log(`\n# Total requêtes Dendreo : ${REQ}. AUCUNE écriture Firestore, aucun commit.`);
    return;
  }

  const list = await get('actions_de_formation.php', {
    started_after: '2026-01-01', ended_before: TODAY,
    fields: 'id_action_de_formation,numero_complet,date_debut,date_fin',
  });
  console.log(`Sessions périmètre : ${list.length} — scan variété (cap ${SCAN_CAP})…\n`);

  // Catégorisation par lecture brute (financements + factures)
  const picks = { multiFacture: null, mixed: null, noFacture: null, any: null };
  let scanned = 0;
  for (const s of list) {
    if (scanned >= SCAN_CAP) break;
    if (picks.multiFacture && picks.mixed && picks.noFacture && picks.any) break;
    const id = s.id_action_de_formation;
    let fin, fac;
    try { fin = await get('financements.php', { id_action_de_formation: id }); } catch { continue; }
    const has360 = fin.some((f) => String(f.id_financeur) === ANDPC_ID);
    if (!has360) continue; // on ne s'intéresse qu'aux sessions ANDPC
    scanned += 1;
    try { fac = await get('factures.php', { id_action_de_formation: id }); } catch { fac = []; }
    const nFac360 = fac.filter((f) => String(f.id_opca) === ANDPC_ID).length;
    const hasNon360 = fin.some((f) => String(f.id_financeur) !== ANDPC_ID);

    const cand = { id, numero: s.numero_complet, nFin360: fin.filter((f) => String(f.id_financeur) === ANDPC_ID).length, nFac360, hasNon360 };
    if (nFac360 > 1 && !picks.multiFacture) picks.multiFacture = cand;
    else if (hasNon360 && !picks.mixed) picks.mixed = cand;
    else if (nFac360 === 0 && !picks.noFacture) picks.noFacture = cand;
    else if (!picks.any) picks.any = cand;
  }

  const chosen = [];
  const seen = new Set();
  for (const [cat, c] of [['≥2 factures ANDPC', picks.multiFacture], ['mixte ANDPC+non-ANDPC', picks.mixed], ['sans facture ANDPC', picks.noFacture], ['ANDPC (complément)', picks.any]]) {
    if (c && !seen.has(c.id)) { chosen.push({ cat, ...c }); seen.add(c.id); }
  }
  console.log(`Sessions ANDPC sondées : ${scanned} ; sélection : ${chosen.length}`);
  if (!picks.multiFacture) console.log('  (⚠ aucune session à ≥2 factures ANDPC trouvée dans le scan — normal si le périmètre est peu facturé)');
  console.log('');

  // Affichage de contrôle via enrichFinancement RÉEL
  for (const c of chosen) {
    await showEnrich(c.id, `══ ${c.numero} (id=${c.id})  [${c.cat}]\n   brut : lignes financement 360=${c.nFin360} | factures id_opca=360=${c.nFac360} | financement non-360 présent=${c.hasNon360}`);
    console.log('');
  }

  console.log(`# Total requêtes Dendreo : ${REQ}. AUCUNE écriture Firestore, aucun commit.`);
}

main().catch((err) => { console.error('!! verif interrompue :', String(err && err.message ? err.message : err).slice(0, 300)); process.exit(1); });
