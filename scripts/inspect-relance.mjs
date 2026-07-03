// scripts/inspect-relance.mjs — INSPECTION read-only pour la vue "À relancer".
// But : (1) CONFIRMER que l'index signatures(status, sentDate) est ENABLED en
// exécutant réellement la query triée ; (2) mesurer les volumes (pending total,
// exclus car session en "Echec", liste finale, participants distincts).
//
// 100% LECTURE : .get() seulement. AUCUNE écriture, AUCUN appel Dendreo.
//
// Lancement : npm run inspect-relance

import { getDb } from '../src/firebase/admin';

function normalize(v) {
  return String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

async function main() {
  const target = process.env.FIREBASE_PROJECT_ID ?? '(défini par les creds Admin)';
  console.log(`# INSPECT-RELANCE — cible Firestore : ${target}\n`);

  // (1) Query réelle status==pending ORDER BY sentDate ASC → prouve l'index.
  let ordered;
  try {
    ordered = await getDb()
      .collection('signatures')
      .where('status', '==', 'pending')
      .orderBy('sentDate', 'asc')
      .get();
    console.log('✅ Index signatures(status ASC, sentDate ASC) : ENABLED (query triée OK).');
  } catch (err) {
    console.log('❌ Query triée refusée → index probablement NON déployé/Enabled :');
    console.log(`   ${String(err && err.message ? err.message : err).slice(0, 240)}`);
    return;
  }

  // (2) Carte des sessions en "Echec" (idEtapeProcess=9 / libellé "Echec").
  const sessSnap = await getDb().collection('sessions').select('etape', 'idEtapeProcess').get();
  const echecIdAdf = new Set();
  sessSnap.forEach((d) => {
    const s = d.data();
    if (String(s.idEtapeProcess) === '9' || normalize(s.etape).includes('echec')) echecIdAdf.add(d.id);
  });

  // (3) Comptages sur la liste pending, triée par ancienneté.
  let total = 0;
  let excluded = 0;
  const participantsFinal = new Set();
  let oldest = null;
  let newest = null;
  const sample = [];
  ordered.forEach((d) => {
    const s = d.data();
    total += 1;
    if (echecIdAdf.has(s.idAdf)) {
      excluded += 1;
      return;
    }
    participantsFinal.add(s.idParticipant);
    if (s.sentDate) {
      if (oldest === null || s.sentDate < oldest) oldest = s.sentDate;
      if (newest === null || s.sentDate > newest) newest = s.sentDate;
    }
    if (sample.length < 3) sample.push({ sentDate: s.sentDate, doc: s.documentName, idAdf: s.idAdf });
  });

  const finalCount = total - excluded;
  console.log(`\npending (status=='pending') total       : ${total}`);
  console.log(`  exclus (session en "Echec")           : ${excluded}`);
  console.log(`  → liste "À relancer" finale            : ${finalCount}`);
  console.log(`  participants distincts (finale)        : ${participantsFinal.size}`);
  console.log(`  sessions en "Echec" (miroir)           : ${echecIdAdf.size}`);
  console.log(`  ancienneté : du ${oldest ?? '—'} au ${newest ?? '—'} (sentDate)`);
  console.log('\n  échantillon (3 plus vieux, non exclus) :');
  for (const r of sample) console.log(`   - ${r.sentDate}  ${String(r.doc).slice(0, 32).padEnd(32)}  idAdf=${r.idAdf}`);
}

main().catch((err) => {
  console.error(`!! inspect-relance interrompu : ${String(err && err.message ? err.message : err).slice(0, 300)}`);
  process.exit(1);
});
