// scripts/inspect-etapes.mjs — INSPECTION read-only du miroir Firestore.
// Liste les valeurs DISTINCTES d'étape (libellé `etape` + `idEtapeProcess`) et
// le nombre de sessions par étape. But : identifier le libellé EXACT de l'étape
// "échec" à exclure du tableau Sessions (terminées).
//
// 100% LECTURE : uniquement des .get() sur NOTRE Firestore. AUCUNE écriture,
// AUCUN appel Dendreo. Ne logge aucune credential.
//
// Lancement : npm run inspect-etapes

import { getDb } from '../src/firebase/admin';

/** Normalise (minuscule + sans accents) — même règle que la couche web. */
function normalize(v) {
  return String(v ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

async function main() {
  const target = process.env.FIREBASE_PROJECT_ID ?? '(défini par les creds Admin)';
  const onEmu = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
  console.log(`# INSPECT-ETAPES — cible Firestore : ${target}${onEmu ? '  [ÉMULATEUR]' : ''}\n`);

  const snap = await getDb().collection('sessions').select('etape', 'idEtapeProcess').get();

  const byKey = new Map(); // key = `${idEtapeProcess}¦${etape}` → { idEtapeProcess, etape, count }
  snap.forEach((d) => {
    const s = d.data();
    const etape = s.etape ?? '(vide)';
    const id = s.idEtapeProcess ?? '(vide)';
    const key = `${id}¦${etape}`;
    const cur = byKey.get(key) ?? { idEtapeProcess: id, etape, count: 0 };
    cur.count += 1;
    byKey.set(key, cur);
  });

  const rows = [...byKey.values()].sort((a, b) => b.count - a.count);
  const total = rows.reduce((n, r) => n + r.count, 0);

  console.log(`Sessions lues : ${total}`);
  console.log(`Étapes distinctes : ${rows.length}\n`);
  console.log('  nb  | idEtapeProcess | libellé etape                        | contient "echec" ?');
  console.log('  ----+----------------+--------------------------------------+-------------------');
  for (const r of rows) {
    const flag = normalize(r.etape).includes('echec') ? '⚠️  OUI → exclue' : '';
    console.log(
      `  ${String(r.count).padStart(3)} | ${String(r.idEtapeProcess).padEnd(14)} | ${String(r.etape).padEnd(36)} | ${flag}`,
    );
  }

  const excluded = rows.filter((r) => normalize(r.etape).includes('echec'));
  console.log(`\nÉtapes qui seraient EXCLUES (libellé normalisé contient "echec") : ${excluded.length}`);
  for (const r of excluded) console.log(`  - "${r.etape}" (idEtapeProcess=${r.idEtapeProcess}, ${r.count} session(s))`);
}

main().catch((err) => {
  console.error(`!! inspect-etapes interrompu : ${String(err && err.message ? err.message : err).slice(0, 300)}`);
  process.exit(1);
});
