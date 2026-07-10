// scripts/inspect-echec-window.mjs — INSPECTION read-only du miroir Firestore.
// Répond à : parmi les sessions que la route GET /api/export/sheet renverrait
// (finFrom <= dateFin <= aujourd'hui Paris), combien sont en étape "Échec" ?
// La route N'EXCLUT PAS l'échec (contrairement à isCockpitVisible côté front) :
// ce script mesure donc combien de sessions Échec fuient dans la sortie.
//
// 100% LECTURE : uniquement des .get() sur NOTRE Firestore. AUCUNE écriture,
// AUCUN appel Dendreo. Ne logge aucune credential.
//
// Lancement : npx tsx scripts/inspect-echec-window.mjs [finFrom=AAAA-MM-JJ]
//   ex. npx tsx scripts/inspect-echec-window.mjs            (borne actuelle : dateFin<=aujourd'hui)
//       npx tsx scripts/inspect-echec-window.mjs 2026-01-01 (ajoute la borne basse)

import { getDb } from '../src/firebase/admin';

/** Normalise (minuscule + sans accents) — même règle que la couche web (isEchecEtape). */
function normalize(v) {
  return String(v ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}
const isEchec = (etape) => normalize(etape).includes('echec');

/** Aujourd'hui à Paris "YYYY-MM-DD" (même helper que todayInParis, sans UTC). */
function todayInParis() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

async function main() {
  const finFromArg = process.argv[2] ?? null;
  if (finFromArg !== null && !/^\d{4}-\d{2}-\d{2}$/.test(finFromArg)) {
    throw new Error(`finFrom invalide (attendu AAAA-MM-JJ) : ${finFromArg}`);
  }
  const today = todayInParis();
  const onEmu = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
  console.log(`# INSPECT-ECHEC-WINDOW — cible ${process.env.FIREBASE_PROJECT_ID ?? '(creds Admin)'}${onEmu ? '  [ÉMULATEUR]' : ''}`);
  console.log(`# Fenêtre route : ${finFromArg ? `${finFromArg} <= ` : ''}dateFin <= ${today} (aujourd'hui Paris)\n`);

  const snap = await getDb().collection('sessions').select('idAdf', 'numeroComplet', 'etape', 'idEtapeProcess', 'dateFin').get();

  // Même filtre de fenêtre que buildPayload (dateFin.slice(0,10), bornes incluses).
  const inWindow = [];
  snap.forEach((d) => {
    const s = d.data();
    const fin = String(s.dateFin ?? '').slice(0, 10);
    if (fin > today) return;
    if (finFromArg && fin < finFromArg) return;
    inWindow.push({
      idAdf: s.idAdf ?? '(vide)',
      numeroComplet: s.numeroComplet ?? '(vide)',
      etape: s.etape ?? '(vide)',
      idEtapeProcess: s.idEtapeProcess ?? '(vide)',
      dateFin: fin,
    });
  });

  const echec = inWindow.filter((r) => isEchec(r.etape)).sort((a, b) => a.dateFin.localeCompare(b.dateFin));

  console.log(`Sessions dans la fenêtre (renvoyées par la route)      : ${inWindow.length}`);
  console.log(`  dont en étape "Échec" (NON exclues → présentes)      : ${echec.length}\n`);

  if (echec.length) {
    console.log('Exemples (échec dans la fenêtre) :');
    console.log('  idAdf      | numeroComplet        | dateFin    | etape');
    console.log('  -----------+----------------------+------------+-------------------------');
    for (const r of echec.slice(0, 5)) {
      console.log(
        `  ${String(r.idAdf).padEnd(10)} | ${String(r.numeroComplet).padEnd(20)} | ${r.dateFin.padEnd(10)} | ${r.etape}`,
      );
    }
    if (echec.length > 5) console.log(`  … et ${echec.length - 5} autre(s).`);
  } else {
    console.log('Aucune session Échec dans la fenêtre.');
  }
}

main().catch((err) => {
  console.error(`!! inspect-echec-window interrompu : ${String(err && err.message ? err.message : err).slice(0, 300)}`);
  process.exit(1);
});
