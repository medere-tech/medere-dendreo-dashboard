// scripts/capture-attestation-fixture.mjs — Capture + SANITISATION d'une session
// pour fixture de test (S3.3a). LECTURE SEULE Dendreo, aucune écriture Dendreo.
// Écrit UNIQUEMENT un fichier de fixture local anonymisé (PII -> initiales/pseudos).
//
// Usage :
//   npx tsx scripts/capture-attestation-fixture.mjs --numero ADF_2026XXXX
//   npx tsx scripts/capture-attestation-fixture.mjs --id 1234
//
// Sortie : test/fixtures/attestations-<idAdf>.signature.json  + un résumé SANS PII.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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
const normalizeDocName = (name) =>
  String(name ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const isSigned = (f) => typeof f.signature_date === 'string' && f.signature_date.trim() !== '';

async function resolveId() {
  if (args.id) return args.id;
  if (!args.numero) throw new Error('Passer --id <idAdf> ou --numero <ADF_...>.');
  const json = await client.get('actions_de_formation.php', {
    numero_complet: args.numero,
    fields: 'id_action_de_formation,numero_complet',
  });
  const first = asArray(json)[0];
  if (!first) throw new Error(`Aucune session pour numero_complet=${args.numero}`);
  return String(first.id_action_de_formation);
}

/** anonymise un fichier signature en préservant ce que la logique utilise. */
function sanitize(f, idx, pseudoOf) {
  const type = f.entite_liee ? Object.keys(f.entite_liee)[0] : null;
  const raw = type ? f.entite_liee[type] : null;
  let entite = null;
  if (type && raw) {
    const realId = String(raw.id_participant ?? `x${idx}`);
    const pseudo = pseudoOf(realId);
    const i1 = (raw.prenom ?? 'X').trim().charAt(0).toUpperCase() || 'X';
    const i2 = (raw.nom ?? 'X').trim().charAt(0).toUpperCase() || 'X';
    entite = { [type]: { id_participant: pseudo, prenom: `${i1}.`, nom: `${i2}.` } };
  }
  return {
    id: `f${idx + 1}`,
    collection_name: f.collection_name,
    name: f.name, // nom de modèle (non PII) — conservé pour tester le filtre
    doctype_id: String(f.doctype_id ?? ''),
    signature_date: f.signature_date ?? '',
    created_at: f.created_at ?? '',
    cible: f.cible ?? DENDREO.CIBLE_ADF,
    id_cible: String(f.id_cible ?? ''),
    public_url: entite ? `https://extranet.example/viewer/${entite[type].id_participant}/${f.doctype_id}` : 'https://extranet.example/viewer/x',
    entite_liee: entite,
  };
}

async function main() {
  const idAdf = await resolveId();
  const fichiers = asArray(
    await client.get('fichiers.php', { cible: DENDREO.CIBLE_ADF, id_cible: idAdf, collection_name: DENDREO.COLLECTION_SIGNATURE }),
  ).filter((f) => f.collection_name === DENDREO.COLLECTION_SIGNATURE);

  // pseudonymisation stable des participants
  const map = new Map();
  const pseudoOf = (realId) => {
    if (!map.has(realId)) map.set(realId, `p${map.size + 1}`);
    return map.get(realId);
  };
  const sanitized = fichiers.map((f, i) => sanitize(f, i, pseudoOf));

  // --- résumé SANS PII (réconciliation) ---
  const attest = sanitized.filter((f) => normalizeDocName(f.name).startsWith('attestation') && f.entite_liee?.Participant);
  const envoyes = attest.length;
  const signes = attest.filter(isSigned).length;
  const nonSignes = envoyes - signes;
  const participantsConcernes = new Set(attest.map((f) => f.entite_liee.Participant.id_participant)).size;
  const participantsARelancer = new Set(attest.filter((f) => !isSigned(f)).map((f) => f.entite_liee.Participant.id_participant)).size;

  const byDoctype = new Map();
  for (const f of attest) {
    const k = `${f.doctype_id} | ${f.name}`;
    if (!byDoctype.has(k)) byDoctype.set(k, { env: 0, sig: 0 });
    const s = byDoctype.get(k);
    s.env += 1;
    if (isSigned(f)) s.sig += 1;
  }

  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const out = join(root, 'test', 'fixtures', `attestations-${idAdf}.signature.json`);
  writeFileSync(out, JSON.stringify(sanitized, null, 2) + '\n', 'utf8');

  console.log(`# CAPTURE session idAdf=${idAdf} → ${sanitized.length} docs signature (anonymisés).`);
  console.log(`# Fixture écrite : test/fixtures/attestations-${idAdf}.signature.json\n`);
  console.log('════ RÉSUMÉ ATTESTATIONS (SANS PII) ════');
  console.log(`envoyes=${envoyes}  signes=${signes}  nonSignes=${nonSignes}  participantsConcernes=${participantsConcernes}  participantsARelancer=${participantsARelancer}`);
  console.log(`invariant signes+nonSignes==envoyes : ${signes + nonSignes === envoyes ? 'OK' : 'KO'}`);
  console.log('\nPar doctype (attestations) :');
  for (const [k, s] of byDoctype) console.log(`  ${s.env} env / ${s.sig} sig   ${k}`);
  console.log('\nRappel oracle §6 attendu : envoyes=6 signes=5 nonSignes=1');
}

main().catch((err) => {
  console.error(`!! capture interrompue : ${String(err && err.message ? err.message : err).slice(0, 300)}`);
  process.exit(1);
});
