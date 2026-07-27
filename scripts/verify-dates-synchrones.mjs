// scripts/verify-dates-synchrones.mjs — VÉRIF LECTURE SEULE (S12.1).
// Pour un idAdf : lit lams.php?include=module,creneaux et affiche
//   (1) extractDatesSynchrones(lams) = EXACTEMENT ce qui serait écrit dans
//       sessions/{idAdf}.datesSynchrones (même fonction pure que backfill/sync),
//   (2) le détail brut par LAM (mode_organisation + jours des créneaux) pour recouper.
//
// GET UNIQUEMENT vers Dendreo. AUCUNE écriture (ni Dendreo, ni Firestore). Ne commite rien.
// Usage (PowerShell) :  npm run verify-dates -- <idAdf>
//                 ou :  npx tsx scripts/verify-dates-synchrones.mjs <idAdf>

import { loadDendreoEnv } from '../src/config';
import { DendreoClient } from '../src/dendreo/client';
import { extractDatesSynchrones, formatLabel } from '../src/dendreo/enrich';

const SYNC_SESSION_MODES = new Set(['mixte', 'elearning_sync']); // formats de SESSION porteurs de séances datées

function asArray(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.data)) return json.data;
  return json == null ? [] : [json];
}

// Mêmes règles de collecte que enrich.creneauxOf (creneaux array/objet + creneau singulier).
function creneauxOf(lam) {
  const out = [];
  for (const key of ['creneaux', 'creneau']) {
    const v = lam[key];
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c === 'object') out.push(c); }
    else if (v && typeof v === 'object') out.push(v);
  }
  return out;
}

async function main() {
  const idAdf = process.argv.slice(2).find((a) => /^\d+$/.test(a));
  if (!idAdf) {
    console.error('Usage : npm run verify-dates -- <idAdf>   (idAdf numérique requis)');
    process.exit(1);
  }

  const client = new DendreoClient(loadDendreoEnv());
  // Le FORMAT est au niveau SESSION (mode_organisation de l'ADF), pas du module.
  const adf = asArray(await client.get('actions_de_formation.php', {
    id: idAdf, fields: 'id_action_de_formation,numero_complet,mode_organisation',
  }))[0] || {};
  const sessionMode = String(adf.mode_organisation ?? '');
  const eligible = SYNC_SESSION_MODES.has(sessionMode);
  const lams = asArray(await client.get('lams.php', { id_action_de_formation: idAdf, include: 'module,creneaux' }));

  console.log(`\n# VÉRIF datesSynchrones — idAdf=${idAdf} (${adf.numero_complet ?? '?'}) — LECTURE SEULE (rien n'est écrit)`);
  console.log(`# Format SESSION : mode_organisation=${sessionMode || '(vide)'} → ${formatLabel(sessionMode) || '(vide)'} `
    + `→ ${eligible ? 'ÉLIGIBLE (mixte/CV) : on prend TOUS les jours datés' : 'HORS CV/Mixte → datesSynchrones sera []'}`);
  console.log(`# ${lams.length} LAM(s) lus via lams.php?include=module,creneaux\n`);

  // (2) DÉTAIL BRUT par LAM — pour recoupement manuel (le mode du LAM n'entre PLUS dans le calcul)
  console.log('--- DÉTAIL BRUT par LAM (mode_organisation module + jours des créneaux) ---');
  for (const l of lams) {
    const mode = String(l.mode_organisation ?? '');
    const jours = creneauxOf(l).map((c) => String(c.day ?? '').trim()).filter(Boolean);
    const tag = jours.length ? (eligible ? '  ← jours COMPTÉS (session éligible)' : '  (session hors CV/Mixte → ignoré)') : '';
    const intitule = String(l.intitule ?? (l.module && l.module.intitule) ?? '').slice(0, 50);
    console.log(`  id_lam=${l.id_lam ?? '?'} | mode_module=${mode || '(vide)'} | créneaux=[${jours.join(', ')}]${tag}`);
    if (intitule) console.log(`     └ ${intitule}`);
  }

  // (1) CE QUI SERAIT ÉCRIT — via la fonction pure réelle (filtre format DANS la fonction)
  const dates = extractDatesSynchrones(lams, sessionMode);
  console.log('\n--- RÉSULTAT extractDatesSynchrones(lams, sessionMode) = datesSynchrones qui SERAIT écrit ---');
  console.log(`  ${dates.length ? JSON.stringify(dates) : '[]  (aucune séance synchrone)'}`);
  console.log(`  → ${dates.length} jour(s) synchrone(s) distinct(s), triés croissant.\n`);
}

main().catch((err) => {
  // Le client redige déjà la clé ; on ne logge que le message.
  console.error(`!! VÉRIF interrompue : ${err && err.message ? err.message : err}`);
  process.exit(1);
});
