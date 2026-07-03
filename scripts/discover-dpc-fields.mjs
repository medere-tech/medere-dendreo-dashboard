// scripts/discover-dpc-fields.mjs — Discovery S3.2 étape A.1, LECTURE SEULE.
// Objectif : identifier les NOMS EXACTS des champs Dendreo portant
//   - le "N° de session DPC"      (format NN.NNN, ex. 26.001)
//   - le "N° compte produit / n° d'action DPC" (11 chiffres, ex. 92622525478)
// SANS rien deviner : on récupère de vraies ADF 2026 et on détecte les champs
// dont les valeurs matchent ces formats. Aucune écriture. Aucune PII (niveau ADF).
//
// Usage :  node --import tsx scripts/discover-dpc-fields.mjs [ADF_20260111]
//   (ou)   npx tsx scripts/discover-dpc-fields.mjs ADF_20260111

import { loadDendreoEnv } from '../src/config';
import { DendreoClient } from '../src/dendreo/client';

const EXAMPLE = process.argv[2] || 'ADF_20260111';

const client = new DendreoClient(loadDendreoEnv());

const RE_SESSION_DPC = /^\d{2}\.\d{3}$/; // 26.001
const RE_DOTTED = /^\d{1,3}\.\d{1,4}$/; // filet plus large (au cas où)
const RE_COMPTE = /^\d{11}$/; // 92622525478
const RE_NUMERIC_WIDE = /^\d{9,13}$/; // candidats "long numéro" hors ids courts

function asArray(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.data)) return json.data;
  return json == null ? [] : [json];
}

function short(v) {
  const s = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
  return s.length > 80 ? s.slice(0, 80) + '…' : s;
}

/** Parcourt les champs scalaires de haut niveau d'un objet. */
function* scalarEntries(obj) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') continue; // on regarde le niveau ADF, pas les sous-objets
    yield [k, v];
  }
}

async function main() {
  console.log(`# DISCOVERY DPC — ADF 2026 (lecture seule). Exemple ciblé : ${EXAMPLE}\n`);

  // 1 requête : liste 2026 avec TOUS les champs par défaut (pas de ?fields → objet complet).
  const list = asArray(
    await client.get('actions_de_formation.php', {
      started_after: '2026-01-01',
      started_before: '2026-12-31',
    }),
  );
  console.log(`Sessions 2026 récupérées : ${list.length}\n`);
  if (list.length === 0) {
    console.log('Aucune session 2026 renvoyée — vérifier la période / les droits.');
    return;
  }

  // Union des clés de haut niveau observées.
  const allKeys = new Set();
  for (const s of list) for (const k of Object.keys(s)) allKeys.add(k);
  console.log(`--- Clés de haut niveau observées (${allKeys.size}) ---`);
  console.log([...allKeys].sort().join(', '));
  console.log('');

  // Détection empirique : quel(s) champ(s) portent chaque format ?
  const hitSessionDpc = new Map(); // key -> Set d'exemples
  const hitCompte = new Map();
  const hitDotted = new Map();
  const hitNumericWide = new Map();

  const record = (map, k, v) => {
    if (!map.has(k)) map.set(k, new Set());
    if (map.get(k).size < 5) map.get(k).add(String(v));
  };

  for (const s of list) {
    for (const [k, v] of scalarEntries(s)) {
      const str = String(v).trim();
      if (RE_SESSION_DPC.test(str)) record(hitSessionDpc, k, str);
      else if (RE_DOTTED.test(str)) record(hitDotted, k, str);
      if (RE_COMPTE.test(str)) record(hitCompte, k, str);
      else if (RE_NUMERIC_WIDE.test(str)) record(hitNumericWide, k, str);
    }
  }

  const dump = (title, map) => {
    console.log(`--- ${title} ---`);
    if (map.size === 0) {
      console.log('  (aucun champ ne matche ce format sur les sessions 2026)');
    } else {
      for (const [k, ex] of map) console.log(`  ${k}  →  ex: ${[...ex].join(', ')}`);
    }
    console.log('');
  };

  dump('Champs au format "N° session DPC" NN.NNN (ex. 26.001)', hitSessionDpc);
  dump('Champs au format 11 chiffres (ex. 92622525478 = compte produit)', hitCompte);
  dump('Candidats larges — valeurs pointées NN.NN…', hitDotted);
  dump('Candidats larges — numériques 9-13 chiffres (dont ids possibles)', hitNumericWide);

  // Dump complet de l'exemple ciblé pour eyeballing du mapping.
  const example = list.find((s) => String(s.numero_complet) === EXAMPLE) || list[0];
  console.log(`--- Dump complet (champs scalaires) de ${example.numero_complet} ---`);
  for (const [k, v] of scalarEntries(example)) console.log(`  ${k}: ${short(v)}`);
  const objKeys = Object.entries(example)
    .filter(([, v]) => v && typeof v === 'object')
    .map(([k]) => k);
  if (objKeys.length) console.log(`  (sous-objets non dépliés : ${objKeys.join(', ')})`);
}

main().catch((err) => {
  console.error(`!! discovery interrompue : ${String(err && err.message ? err.message : err).slice(0, 300)}`);
  process.exit(1);
});
