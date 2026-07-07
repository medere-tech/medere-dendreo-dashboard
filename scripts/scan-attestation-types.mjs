// scripts/scan-attestation-types.mjs — VÉRIF S7 (Dendreo, lecture seule).
// Énumère les TYPES d'attestation réels (nom commence par "Attestation", cible
// Participant) sur un ÉCHANTILLON de sessions 2025-2026, regroupés par bucket
// sémantique (EPP amont / EPP aval / autre) + doctype_id. Aucune écriture, pas de PII.
import { loadDendreoEnv, DENDREO } from '../src/config';
import { DendreoClient } from '../src/dendreo/client';
const c = new DendreoClient(loadDendreoEnv());
const A = (j) => (Array.isArray(j) ? j : j && Array.isArray(j.data) ? j.data : j == null ? [] : [j]);
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// bucket sémantique à partir du nom du document
function bucket(name) {
  const n = norm(name);
  if (/epp.*amont/.test(n)) return 'EPP amont';
  if (/epp.*aval/.test(n)) return 'EPP aval';
  if (/audit.*clinique.*amont/.test(n)) return 'EPP amont'; // libellé alternatif
  if (/audit.*clinique.*aval/.test(n)) return 'EPP aval';
  return 'Autre (PI / formation continue…)';
}

const list = A(await c.get('actions_de_formation.php', {
  started_after: '2025-01-01', started_before: '2026-12-31',
  fields: 'id_action_de_formation',
}));
// échantillon régulier ~90 sessions
const step = Math.max(1, Math.floor(list.length / 90));
const sample = list.filter((_, i) => i % step === 0).slice(0, 90);
console.log(`Sessions listées=${list.length} → échantillon=${sample.length}\n`);

const buckets = new Map(); // bucket → { count, doctypes:Map(doctypeId→count), names:Map(name→count) }
let scanned = 0, attest = 0;
for (const s of sample) {
  let fichiers;
  try {
    fichiers = A(await c.get('fichiers.php', {
      cible: DENDREO.CIBLE_ADF, id_cible: s.id_action_de_formation, collection_name: DENDREO.COLLECTION_SIGNATURE,
    }));
  } catch { continue; }
  scanned += 1;
  for (const f of fichiers) {
    if (!norm(f.name).startsWith('attestation')) continue;
    if (!f.entite_liee?.Participant) continue; // cible Participant seulement
    attest += 1;
    const b = bucket(f.name);
    const e = buckets.get(b) ?? { count: 0, doctypes: new Map(), names: new Map() };
    e.count += 1;
    const dt = String(f.doctype_id ?? '(vide)');
    e.doctypes.set(dt, (e.doctypes.get(dt) ?? 0) + 1);
    e.names.set(String(f.name), (e.names.get(String(f.name)) ?? 0) + 1);
    buckets.set(b, e);
  }
}

console.log(`Sessions scannées=${scanned} — attestations Participant=${attest}\n`);
console.log('=== BUCKETS DE TYPE (proposition filtre "Type") ===');
for (const [b, e] of [...buckets.entries()].sort((a, z) => z[1].count - a[1].count)) {
  console.log(`\n● ${b}  — ${e.count} attestations`);
  console.log(`   doctype_id : ${[...e.doctypes.entries()].map(([d, n]) => `${d}(${n})`).join(', ')}`);
  console.log('   exemples de noms :');
  for (const [name, n] of [...e.names.entries()].sort((a, z) => z[1] - a[1]).slice(0, 6)) {
    console.log(`     ${String(n).padStart(4)}  "${name}"`);
  }
}
