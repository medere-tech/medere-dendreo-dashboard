// scripts/clear-mirror.mjs — Vide le MIROIR Firestore (S3.3b), Admin SDK.
// ÉCRIT UNIQUEMENT sur NOTRE Firestore (jamais Dendreo). AUCUN appel Dendreo.
//
// But : repartir d'un miroir propre avant le re-backfill "attestation" (l'ancien
// backfill a laissé des docs signature Convention _111 que le nouveau n'écrase pas).
//
// SÉCURITÉ :
//  - DRY-RUN par défaut : compte seulement, n'efface rien.
//  - --confirm : efface réellement (batch 500) puis réinitialise _meta/backfill.
//
// Lancement (via tsx, car importe du TypeScript) :
//   npm run clear-mirror                 # dry-run (compte)
//   npm run clear-mirror -- --confirm    # efface + reset _meta

import { getDb } from '../src/firebase/admin';

const CONFIRM = process.argv.includes('--confirm');
const COLLECTIONS = ['sessions', 'signatures'];
const META_PATH = '_meta/backfill';
const BATCH = 500; // limite Firestore par batch d'écritures

async function countCol(name) {
  const agg = await getDb().collection(name).count().get();
  return agg.data().count;
}

async function deleteCol(name) {
  const col = getDb().collection(name);
  let removed = 0;
  for (;;) {
    const snap = await col.limit(BATCH).get();
    if (snap.empty) break;
    const batch = getDb().batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    removed += snap.size;
    console.log(`  ${name}: ${removed} supprimé(s)…`);
  }
  return removed;
}

async function resetMeta() {
  // set SANS merge → écrase proprement l'état du backfill.
  await getDb().doc(META_PATH).set({
    firstYearDiscovered: null,
    yearsProcessed: [],
    sessionsProcessed: 0,
    status: 'reset',
    lastRunAt: new Date().toISOString(),
  });
}

async function main() {
  const target = process.env.FIREBASE_PROJECT_ID ?? '(défini par les creds Admin)';
  const onEmu = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
  console.log(`# CLEAR-MIRROR — cible Firestore : ${target}${onEmu ? '  [ÉMULATEUR]' : ''}`);
  console.log(`# mode : ${CONFIRM ? 'CONFIRM (EFFACE réellement)' : 'DRY-RUN (compte seulement)'}\n`);

  const counts = {};
  for (const c of COLLECTIONS) counts[c] = await countCol(c);
  const total = COLLECTIONS.reduce((s, c) => s + counts[c], 0);

  console.log('Plan :');
  for (const c of COLLECTIONS) console.log(`  - ${c} : ${counts[c]} doc(s) à supprimer`);
  console.log('  - _meta/backfill : réinitialisation (yearsProcessed=[], sessionsProcessed=0)');
  console.log(`  => TOTAL à supprimer : ${total} doc(s)\n`);

  if (!CONFIRM) {
    console.log('DRY-RUN : rien effacé. Relance avec --confirm pour exécuter.');
    return;
  }

  console.log('CONFIRM : suppression en cours (batch 500)…');
  let removed = 0;
  for (const c of COLLECTIONS) removed += await deleteCol(c);
  await resetMeta();
  console.log(`\n✅ ${removed} doc(s) supprimé(s). _meta/backfill réinitialisé. Miroir propre.`);
}

main().catch((err) => {
  console.error(`!! clear-mirror interrompu : ${String(err && err.message ? err.message : err).slice(0, 300)}`);
  process.exit(1);
});
