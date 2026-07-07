// scripts/verify-coverage.mjs — PREUVE de couverture (lecture seule Firestore).
// À lancer AVANT et APRÈS le re-backfill. Aucune écriture.
//   npx tsx scripts/verify-coverage.mjs
import { getDb } from '../src/firebase/admin';
const db = getDb();

const norm = (v) => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// 1) sessions/2408 présent ?
const d2408 = await db.collection('sessions').doc('2408').get();
console.log(`sessions/2408 présent         : ${d2408.exists ? 'OUI ✅' : 'NON ❌'}`);
if (d2408.exists) {
  const s = d2408.data();
  console.log(`   ${s.numeroComplet} | ${s.intitule} | ${s.dateDebut} → ${s.dateFin} | etape=${s.etape}`);
}

// 2) volumes miroir
const nSessions = (await db.collection('sessions').count().get()).data().count;
const nSign = (await db.collection('signatures').count().get()).data().count;
console.log(`docs 'sessions'               : ${nSessions}`);
console.log(`docs 'signatures'             : ${nSign}`);

// 3) "À relancer" = signatures status=pending, HORS sessions en Echec (etape 9)
const echec = new Set();
(await db.collection('sessions').select('etape', 'idEtapeProcess').get()).forEach((doc) => {
  const s = doc.data();
  if (String(s.idEtapeProcess) === '9' || norm(s.etape).includes('echec')) echec.add(doc.id);
});
let pendingBrut = 0, pendingARelancer = 0;
const partsARelancer = new Set();
(await db.collection('signatures').where('status', '==', 'pending').select('idAdf', 'idParticipant').get())
  .forEach((doc) => {
    const s = doc.data();
    pendingBrut += 1;
    if (!echec.has(String(s.idAdf))) { pendingARelancer += 1; partsARelancer.add(s.idParticipant); }
  });
console.log(`signatures pending (brut)     : ${pendingBrut}`);
console.log(`À RELANCER (hors Echec)       : ${pendingARelancer}  (participants distincts: ${partsARelancer.size})`);
