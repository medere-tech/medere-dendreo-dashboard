// scripts/recon-perimetre-2026.mjs — S11.0c RE-MESURE périmètre RÉEL (LECTURE SEULE, no commit).
// -----------------------------------------------------------------------------
// Périmètre V2 : dateDebut >= 2026-01-01 ET dateFin <= AUJOURD'HUI, financeur
// ANDPC (id 360). On sonde ~25 sessions réelles de CE périmètre et on mesure :
//   1. nb factures id_opca=360 / session (distribution + POURQUOI si >1 :
//      avoirs ? partielles ? duplicatas ? → champs id_avoir/avoir/statut_facturation).
//   2. taux de remplissage de date_envoi sur ces factures 2026 (X/25 non vides).
//   3. Σ montant_finance (lignes id_financeur=360 SEULES) vs montant_total_ht
//      des factures ANDPC : concordance ? 3 cas chiffrés.
//   4. combien de sessions du périmètre ont un financement NON-ANDPC mêlé.
//
// Sécurité : GET only ; clé jamais loggée ; pas d'écriture ; brut → scratchpad (hors repo).
// Usage : npx tsx scripts/recon-perimetre-2026.mjs [YYYY-MM-DD_ceil]
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { loadDendreoEnv } from '../src/config';
import { DendreoClient } from '../src/dendreo/client';

const TODAY = process.argv[3] || '2026-07-21'; // plafond dateFin (= aujourd'hui, cf. contexte)
const OUT_FILE =
  process.argv[2] ||
  'C:\\Users\\DTHI~1\\AppData\\Local\\Temp\\claude\\C--Users-D-thi--Documents-GitHub-medere-dendreo-dashboard\\d276e222-ee90-4a8a-9352-b88693782e98\\scratchpad\\recon-perimetre-2026-raw.json';

const client = new DendreoClient(loadDendreoEnv());
const ANDPC_ID = '360';
const TARGET = 25; // sessions ANDPC du périmètre à retenir

let REQ = 0;
const dump = { note: 'S11.0c périmètre 2026 — brut local, non commité', ceil: TODAY, sessions: {}, analysis: {} };

function asArray(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.data)) return json.data;
  return json == null ? [] : [json];
}
const num = (v) => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const r2 = (n) => Math.round(n * 100) / 100;
const nonEmpty = (v) => String(v ?? '').trim() !== '';

async function get(resource, params) {
  REQ += 1;
  return asArray(await client.get(resource, params));
}

const SESSION_FIELDS = 'id_action_de_formation,numero_complet,date_debut,date_fin,type,total_participants,num_session_dpc,numero_comptable';

async function main() {
  console.log(`# S11.0c — périmètre 2026 (début>=2026-01-01, fin<=${TODAY}, ANDPC id 360) — LECTURE SEULE\n`);

  // 1) Sessions entièrement contenues dans [2026-01-01, TODAY]
  const list = await get('actions_de_formation.php', {
    started_after: '2026-01-01', ended_before: TODAY, fields: SESSION_FIELDS,
  });
  console.log(`Sessions [2026-01-01 → ${TODAY}] (début & fin dans la fenêtre) : ${list.length}`);

  // 2) Ne garder que celles financées ANDPC (id_financeur=360), jusqu'à TARGET
  const perim = [];
  let scanned = 0;
  for (const s of list) {
    if (perim.length >= TARGET) break;
    scanned += 1;
    const id = s.id_action_de_formation;
    let fin = [];
    try { fin = await get('financements.php', { id_action_de_formation: id }); } catch { continue; }
    const has360 = fin.some((f) => String(f.id_financeur) === ANDPC_ID);
    if (!has360) continue;
    let fac = [];
    try { fac = await get('factures.php', { id_action_de_formation: id }); } catch { fac = []; }
    const rec = {
      numero: s.numero_complet, dateDebut: s.date_debut, dateFin: s.date_fin,
      numSessionDpc: String(s.num_session_dpc ?? '').trim(), numeroComptable: String(s.numero_comptable ?? '').trim(),
      financements: fin.map((f) => ({ id_financeur: String(f.id_financeur), type: f.type, montant_finance: f.montant_finance })),
      factures: fac.map((f) => ({
        numero_complet: f.numero_complet, id_opca: String(f.id_opca), raison_sociale: f.raison_sociale,
        montant_total_ht: f.montant_total_ht, montant_total_ttc: f.montant_total_ttc, montant_total_tva: f.montant_total_tva,
        date_emission: f.date_emission, date_envoi: f.date_envoi, date_paiement: f.date_paiement,
        id_avoir: f.id_avoir, avoir: f.avoir, id_parent: f.id_parent, statut_facturation: f.statut_facturation,
      })),
    };
    dump.sessions[id] = rec;
    perim.push({ id, ...rec });
  }
  console.log(`Scannées : ${scanned} ; retenues ANDPC (fin 360) : ${perim.length}\n`);
  if (!perim.length) { console.log('Aucune session ANDPC dans le périmètre — stop.'); return finish(); }

  // ---- Q1 : nb factures id_opca=360 / session ------------------------------
  console.log('=== Q1 — nb factures id_opca=360 par session ===');
  const dist = {};
  const multi = [];
  for (const rec of perim) {
    const fac360 = rec.factures.filter((f) => f.id_opca === ANDPC_ID);
    const n = fac360.length;
    dist[n] = (dist[n] || 0) + 1;
    if (n > 1) multi.push(rec);
  }
  console.log(`  Distribution : ${JSON.stringify(dist)}  (sur ${perim.length} sessions)`);
  console.log(`  Sessions avec >1 facture 360 : ${multi.length}`);
  console.log('\n  POURQUOI >1 ? — 2 cas réels (champs bruts factures 360) :');
  for (const rec of multi.slice(0, 2)) {
    console.log(`  ── ${rec.numero} :`);
    for (const f of rec.factures.filter((x) => x.id_opca === ANDPC_ID)) {
      console.log(`     ${f.numero_complet} | emission=${f.date_emission} | HT=${f.montant_total_ht} | TTC=${f.montant_total_ttc} | id_avoir=${JSON.stringify(f.id_avoir)} | avoir=${JSON.stringify(f.avoir)} | id_parent=${JSON.stringify(f.id_parent)} | statut=${f.statut_facturation}`);
    }
  }
  dump.analysis.q1 = { dist, multiCount: multi.length };

  // ---- Q2 : date_envoi renseignée ? ----------------------------------------
  console.log('\n=== Q2 — taux de remplissage date_envoi (factures 360) ===');
  let facTot = 0, envoiOk = 0, emissionOk = 0, paiementOk = 0;
  for (const rec of perim) {
    for (const f of rec.factures.filter((x) => x.id_opca === ANDPC_ID)) {
      facTot += 1;
      if (nonEmpty(f.date_envoi)) envoiOk += 1;
      if (nonEmpty(f.date_emission)) emissionOk += 1;
      if (nonEmpty(f.date_paiement)) paiementOk += 1;
    }
  }
  console.log(`  factures 360 total : ${facTot}`);
  console.log(`  date_envoi non vide  : ${envoiOk}/${facTot} (${facTot ? r2(envoiOk / facTot * 100) : 0}%)`);
  console.log(`  date_emission non vide : ${emissionOk}/${facTot}`);
  console.log(`  date_paiement non vide : ${paiementOk}/${facTot}`);
  console.log('  Exemples (5) : ');
  const ex = perim.flatMap((r) => r.factures.filter((f) => f.id_opca === ANDPC_ID)).slice(0, 5);
  for (const f of ex) console.log(`     ${f.numero_complet}: envoi=${JSON.stringify(f.date_envoi)} emission=${JSON.stringify(f.date_emission)} paiement=${JSON.stringify(f.date_paiement)}`);
  dump.analysis.q2 = { facTot, envoiOk, emissionOk, paiementOk };

  // ---- Q3 : Σ financement 360 vs Σ HT factures 360 -------------------------
  console.log('\n=== Q3 — Σ montant_finance(360) vs Σ montant_total_ht(factures 360) ===');
  const q3 = [];
  for (const rec of perim) {
    const sumFin = r2(rec.financements.filter((f) => f.id_financeur === ANDPC_ID).reduce((a, f) => a + num(f.montant_finance), 0));
    const facs = rec.factures.filter((f) => f.id_opca === ANDPC_ID);
    const sumHt = r2(facs.reduce((a, f) => a + num(f.montant_total_ht), 0));
    const match = Math.abs(sumFin - sumHt) < 0.02;
    q3.push({ numero: rec.numero, nFin360: rec.financements.filter((f) => f.id_financeur === ANDPC_ID).length, nFac360: facs.length, sumFin, sumHt, match });
  }
  const matches = q3.filter((x) => x.match).length;
  console.log(`  Concordance Σfin360==ΣHT360 : ${matches}/${q3.length} sessions`);
  console.log('  3 cas chiffrés :');
  for (const c of q3.slice(0, 3)) console.log(`     ${c.numero}: nFin=${c.nFin360} nFac=${c.nFac360} | Σfin=${c.sumFin} | ΣHT=${c.sumHt} | match=${c.match}`);
  const mism = q3.filter((x) => !x.match).slice(0, 5);
  if (mism.length) { console.log('  Non-concordances (à comprendre) :'); for (const c of mism) console.log(`     ${c.numero}: Σfin=${c.sumFin} ΣHT=${c.sumHt} (écart ${r2(c.sumFin - c.sumHt)})`); }
  dump.analysis.q3 = { matches, total: q3.length, rows: q3 };

  // ---- Q4 : sessions avec financement NON-ANDPC mêlé -----------------------
  console.log('\n=== Q4 — sessions du périmètre avec un financement NON-ANDPC mêlé ===');
  let mixed = 0;
  const mixedEx = [];
  for (const rec of perim) {
    const non360 = rec.financements.filter((f) => f.id_financeur !== ANDPC_ID);
    if (non360.length) {
      mixed += 1;
      const types = [...new Set(non360.map((f) => f.type))];
      mixedEx.push({ numero: rec.numero, nNon360: non360.length, types });
    }
  }
  console.log(`  Sessions ANDPC avec ≥1 ligne NON-360 : ${mixed}/${perim.length}`);
  for (const m of mixedEx.slice(0, 8)) console.log(`     ${m.numero}: ${m.nNon360} ligne(s) non-360, types=${JSON.stringify(m.types)}`);
  console.log('  → confirme qu\'il faut filtrer id_financeur=360 pour la somme ANDPC.');
  dump.analysis.q4 = { mixed, total: perim.length, examples: mixedEx };

  finish();
}

function finish() {
  try { writeFileSync(OUT_FILE, JSON.stringify(dump, null, 2), 'utf8'); console.log(`\n# Brut écrit : ${OUT_FILE}`); }
  catch (e) { console.log('# écriture brut KO :', String(e.message).slice(0, 120)); }
  console.log(`# Total requêtes Dendreo : ${REQ}`);
}

main().catch((err) => { console.error('!! recon interrompue :', String(err && err.message ? err.message : err).slice(0, 300)); process.exit(1); });
