// scripts/scan-eligible-dpc-values.mjs — read-only : distribution des valeurs
// eligible_dpc du module CŒUR sur un échantillon, + trouve un exemple "0" (non-DPC).
import { loadDendreoEnv } from '../src/config';
import { DendreoClient } from '../src/dendreo/client';
const c = new DendreoClient(loadDendreoEnv());
const A = (j) => (Array.isArray(j) ? j : j && Array.isArray(j.data) ? j.data : j == null ? [] : [j]);

const list = A(await c.get('actions_de_formation.php', {
  started_after: '2025-01-01', started_before: '2026-12-31', fields: 'id_action_de_formation,numero_complet',
}));
const step = Math.max(1, Math.floor(list.length / 70));
const sample = list.filter((_, i) => i % step === 0).slice(0, 70);

const dist = new Map(); // valeur cœur.eligible_dpc → count
const examples0 = [];
let scanned = 0;
for (const s of sample) {
  let lams;
  try { lams = A(await c.get('lams.php', { id_action_de_formation: s.id_action_de_formation, include: 'module' })); }
  catch { continue; }
  scanned += 1;
  const cores = [];
  for (const l of lams) {
    const m = l.module;
    if (!m) continue;
    const cat = String(m.id_categorie_module ?? '');
    if (cat !== '21' && cat !== '22') cores.push(m.eligible_dpc);
  }
  const v = cores.length ? String(cores[0]) : '(pas de cœur)';
  dist.set(v, (dist.get(v) ?? 0) + 1);
  if (v === '0' && examples0.length < 5) examples0.push(s.numero_complet);
}
console.log(`Sessions scannées=${scanned}\n`);
console.log('Distribution cœur.eligible_dpc :');
for (const [v, n] of [...dist.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${JSON.stringify(v)} → ${n}`);
console.log(`\nExemples eligible_dpc="0" : ${examples0.join(', ') || '(aucun dans l\'échantillon)'}`);
