// scripts/capture-laps-3686.mjs — Capture READ-ONLY de laps.php pour la session 3686,
// SANITISE la PII (noms → initiales), écrit test/fixtures/laps-3686.json, et imprime
// un résumé NON-PII (ids uniquement) pour finaliser le test notSent réel.
//
// GET UNIQUEMENT. Clé jamais affichée. Aucune écriture vers Dendreo.
//   node scripts/capture-laps-3686.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ID_ADF = '3686';

// --- env (.env.local) sans dépendance --------------------------------------
(() => {
  try {
    const raw = readFileSync(join(ROOT, '.env.local'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(m[1] in process.env)) process.env[m[1]] = v;
    }
  } catch { /* on s'appuiera sur l'env présent */ }
})();

const API_KEY = process.env.DENDREO_API_KEY;
const BASE_URL = (process.env.DENDREO_BASE_URL || '').replace(/\/+$/, '');
if (!API_KEY || !BASE_URL) { console.error('DENDREO_API_KEY / DENDREO_BASE_URL manquantes.'); process.exit(1); }

const redact = (s) => String(s).split(API_KEY).join('***').replace(/token="[^"]*"/gi, 'token="***"');
const initial = (s) => ((s ?? '').trim()[0] ?? '?').toUpperCase() + '.';

async function main() {
  const url = new URL(`${BASE_URL}/laps.php`);
  url.searchParams.set('id_action_de_formation', ID_ADF);
  url.searchParams.set('include', 'participant');
  console.log(`→ GET ${redact(url.toString())}`);

  let res;
  try {
    res = await fetch(url, { method: 'GET', headers: { Authorization: `Token token="${API_KEY}"`, Accept: 'application/json' } });
  } catch (err) { console.error(redact(`fetch a échoué : ${err?.message ?? err}`)); process.exit(1); }

  const text = await res.text();
  if (!res.ok) { console.error(redact(`HTTP ${res.status} ${res.statusText}\n${text}`.slice(0, 600))); process.exit(1); }
  const laps = JSON.parse(text);
  if (!Array.isArray(laps)) { console.error('Réponse inattendue (pas un tableau).'); process.exit(1); }

  // --- SANITISATION : on ne garde que les champs utiles, noms → initiales ----
  const sanitized = laps.map((l) => {
    const p = l.participant ?? {};
    return {
      id_lap: l.id_lap ?? null,
      id_participant: l.id_participant ?? p.id_participant ?? null,
      status: l.status ?? null,
      lap_status_id: l.lap_status_id ?? null,
      participant: { id_participant: p.id_participant ?? null, nom: initial(p.nom), prenom: initial(p.prenom) },
    };
  });

  const outPath = join(ROOT, 'test', 'fixtures', 'laps-3686.json');
  writeFileSync(outPath, JSON.stringify(sanitized, null, 2) + '\n', 'utf8');
  console.log(`✔ Fixture sanitisée écrite : ${outPath} (${sanitized.length} inscriptions)`);

  // --- RÉSUMÉ NON-PII (ids uniquement) pour finaliser le test ----------------
  const fichiers = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'fichiers-3686.signature.json'), 'utf8'));
  const withFile = new Set(
    fichiers.filter((f) => f.collection_name === 'signature' && f.doctype_id === '111')
      .map((f) => f.entite_liee?.Participant?.id_participant).filter(Boolean),
  );

  const isIdentified = (l) => { const id = String(l.id_participant ?? l.participant?.id_participant ?? '').trim(); return id !== '' && id !== '0'; };
  const isActive = (l) => l.status === '1';

  const statusDist = {};
  for (const l of sanitized) statusDist[String(l.status)] = (statusDist[String(l.status)] || 0) + 1;

  const expected = sanitized.filter((l) => isIdentified(l) && isActive(l));
  const expectedIds = [...new Set(expected.map((l) => String(l.id_participant)))];
  const notSentIds = expectedIds.filter((id) => !withFile.has(id));
  const unidentified = sanitized.filter((l) => !isIdentified(l)).length;
  const inactive = sanitized.filter((l) => !isActive(l)).length;

  console.log('\n===== RÉSUMÉ NON-PII (à me coller) =====');
  console.log('total inscriptions     :', sanitized.length);
  console.log('distribution status    :', JSON.stringify(statusDist));
  console.log('non identifiés (exclus):', unidentified);
  console.log('non actifs (exclus)    :', inactive);
  console.log('attendus (ident.+actif):', expectedIds.length);
  console.log('participants avec doc  :', withFile.size);
  console.log('=> notSent (ids)       :', JSON.stringify(notSentIds));
  console.log('=> notSent (count)     :', notSentIds.length);
}

main();
