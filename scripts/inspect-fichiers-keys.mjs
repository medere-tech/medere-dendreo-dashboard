// scripts/inspect-fichiers-keys.mjs — Inspecte les CLÉS RÉELLES de fichiers.php
// (collection signature) d'une session. LECTURE SEULE. SANS PII :
//   - noms de clés (non-PII) ;
//   - valeurs scalaires courtes sûres (dates, ids, doctype, collection, cible, nom de modèle) ;
//   - URLs masquées ([url]) ; sous-objets = liste de clés uniquement (jamais les valeurs).
//
// Usage : npx tsx scripts/inspect-fichiers-keys.mjs --numero ADF_2025XXXX   (ou --id 1234)

import { loadDendreoEnv, DENDREO } from '../src/config';
import { DendreoClient } from '../src/dendreo/client';

function parseArgs(argv) {
  const a = { id: null, numero: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--id') a.id = String(argv[++i]);
    else if (argv[i] === '--numero') a.numero = String(argv[++i]);
  }
  return a;
}
const args = parseArgs(process.argv.slice(2));
const client = new DendreoClient(loadDendreoEnv());

function asArray(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.data)) return json.data;
  return json == null ? [] : [json];
}

async function resolveId() {
  if (args.id) return args.id;
  if (!args.numero) throw new Error('Passer --id ou --numero.');
  const json = await client.get('actions_de_formation.php', { numero_complet: args.numero, fields: 'id_action_de_formation,numero_complet' });
  const first = asArray(json)[0];
  if (!first) throw new Error(`Aucune session pour ${args.numero}`);
  return String(first.id_action_de_formation);
}

/** Rendu SANS PII d'une valeur : dates/ids/doctype OK ; url masquée ; objet = clés. */
function safe(key, v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `[array len=${v.length}${v.length && typeof v[0] === 'object' ? ' of {' + Object.keys(v[0]).join(',') + '}' : ''}]`;
  if (typeof v === 'object') return `{obj clés: ${Object.keys(v).join(', ')}}`;
  const s = String(v);
  if (/url|href|link/i.test(key) || /^https?:\/\//i.test(s)) return '[url masquée]';
  if (s.includes('@')) return '[valeur masquée @]';
  // nom de modèle de document : on l'affiche (template, non PII) pour caler le préfixe "Attestation".
  return s.length > 70 ? s.slice(0, 70) + '…' : s;
}

async function main() {
  const idAdf = await resolveId();
  const fichiers = asArray(await client.get('fichiers.php', { cible: DENDREO.CIBLE_ADF, id_cible: idAdf, collection_name: DENDREO.COLLECTION_SIGNATURE }));
  console.log(`# fichiers.php collection=signature  idAdf=${idAdf}  → ${fichiers.length} docs\n`);
  if (!fichiers.length) return;

  // Union des clés de haut niveau
  const keys = new Set();
  for (const f of fichiers) for (const k of Object.keys(f)) keys.add(k);
  console.log(`--- Clés de haut niveau (${keys.size}) ---`);
  console.log([...keys].sort().join(', '));

  // Détail du 1er doc (valeurs sûres) — pour voir QUEL champ porte quoi
  console.log(`\n--- 1er doc : clé -> valeur (sûre) ---`);
  const first = fichiers[0];
  for (const [k, v] of Object.entries(first)) console.log(`  ${k}: ${safe(k, v)}`);

  // Focus entite_liee sur quelques docs : forme réelle (objet clé par type ? champ .type ?)
  console.log(`\n--- entite_liee : forme réelle (3 premiers docs, clés seulement) ---`);
  for (const f of fichiers.slice(0, 3)) {
    const e = f.entite_liee;
    if (e == null) console.log('  entite_liee: null');
    else if (typeof e === 'object') console.log(`  entite_liee: {clés: ${Object.keys(e).join(', ')}}  .type=${'type' in e ? JSON.stringify(e.type) : '(absent)'}`);
    else console.log(`  entite_liee: ${typeof e}`);
  }

  // Champs candidats "nom du document" présents ? (name, nom, titre, filename, label…)
  console.log(`\n--- Candidats "nom du document" (valeurs sûres, 5 docs) ---`);
  const nameCandidates = ['name', 'nom', 'titre', 'title', 'filename', 'file_name', 'label', 'libelle'].filter((k) => keys.has(k));
  console.log(`  clés présentes : ${nameCandidates.join(', ') || '(aucune évidente)'}`);
  for (const f of fichiers.slice(0, 5)) {
    console.log('  ' + nameCandidates.map((k) => `${k}=${safe(k, f[k])}`).join('  |  '));
  }

  // Candidats date d'envoi
  console.log(`\n--- Candidats "date d'envoi" ---`);
  console.log('  clés présentes : ' + ['created_at', 'date_add', 'date_created', 'createdAt', 'date'].filter((k) => keys.has(k)).join(', '));
}

main().catch((err) => {
  console.error(`!! inspection interrompue : ${String(err && err.message ? err.message : err).slice(0, 300)}`);
  process.exit(1);
});
