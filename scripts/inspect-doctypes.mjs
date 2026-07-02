// scripts/inspect-doctypes.mjs — Diagnostic S3.3, LECTURE SEULE (aucune écriture
// Dendreo ni Firestore). Inventorie TOUS les documents de signature réellement
// utilisés (pas seulement doctype 111), sur un échantillon de sessions.
//
// Échantillon : 10 sessions 2026 "variées" (réparties sur l'année) + 10 sessions
// 2025 "dentaires" (intitulé matchant /dent/i, heuristique). Par ADF :
//   fichiers.php?collection_name=signature  +  laps.php?include=participant
//
// Sortie SANS PII : compteurs, n° de session, intitulés (titres de formation),
// noms de documents (masqués si potentiellement per-fichier = PII).
//
// Usage :  npx tsx scripts/inspect-doctypes.mjs [--n 10] [--keyword dent]

import { loadDendreoEnv, DENDREO } from '../src/config';
import { DendreoClient } from '../src/dendreo/client';
import { defaultExpectedRule } from '../src/dendreo/signatures';

// --- args -------------------------------------------------------------------
function parseArgs(argv) {
  const a = { n: 10, keyword: 'dent' };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--n') a.n = Number(argv[++i]);
    else if (t === '--keyword') a.keyword = String(argv[++i]);
  }
  return a;
}
const args = parseArgs(process.argv.slice(2));
const client = new DendreoClient(loadDendreoEnv());

const CONCURRENCY = 5;

// --- helpers ----------------------------------------------------------------
function asArray(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.data)) return json.data;
  return json == null ? [] : [json];
}
const isSigned = (f) => typeof f.signature_date === 'string' && f.signature_date.trim() !== '';
const pad = (v, len) => String(v).padEnd(len).slice(0, len);
const padL = (v, len) => String(v).padStart(len);

/** échantillon réparti (pas de biais début de liste). */
function pickSpread(arr, n) {
  if (arr.length <= n) return arr.slice();
  const step = arr.length / n;
  const out = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * step)]);
  return out;
}

async function pool(items, size, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}

async function listYear(year) {
  const json = await client.get('actions_de_formation.php', {
    started_after: `${year}-01-01`,
    started_before: `${year}-12-31`,
    fields: 'id_action_de_formation,numero_complet,intitule,date_debut',
  });
  return asArray(json);
}

/** représentant de nom SANS PII : le plus fréquent ; masqué si tous uniques. */
function reprName(nameFreq) {
  const entries = [...nameFreq.entries()].sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return '(sans nom)';
  const [topName, topCount] = entries[0];
  if (topCount === 1) return `(${entries.length} noms uniques — masqué PII)`;
  const variantes = entries.length > 1 ? ` (+${entries.length - 1} variantes)` : '';
  return `${topName}${variantes}`;
}

// --- diagnostic d'une session ----------------------------------------------
async function inspect(session, year, doctypeStats) {
  const idAdf = String(session.id_action_de_formation);
  const numero = session.numero_complet ?? `ADF_${idAdf}`;
  try {
    const [fichiersRaw, lapsRaw] = await Promise.all([
      client.get('fichiers.php', { cible: DENDREO.CIBLE_ADF, id_cible: idAdf, collection_name: DENDREO.COLLECTION_SIGNATURE }),
      client.get('laps.php', { id_action_de_formation: idAdf, include: 'participant' }),
    ]);
    const fichiers = asArray(fichiersRaw).filter((f) => f.collection_name === DENDREO.COLLECTION_SIGNATURE);
    const laps = asArray(lapsRaw);

    // participants attendus (identifiés + actifs), distincts
    const participants = new Set();
    for (const lap of laps) {
      if (!defaultExpectedRule(lap)) continue;
      const id = lap.id_participant ?? lap.participant?.id_participant;
      if (id) participants.add(String(id));
    }

    // documents de signature ciblant un Participant
    const participantsAvecDoc = new Set();
    const participantsSignes = new Set();
    const doctypesDansSession = new Set();
    let docsTotal = 0;

    for (const f of fichiers) {
      const targetType = f.entite_liee ? Object.keys(f.entite_liee)[0] : 'none';
      const doctypeId = String(f.doctype_id ?? '?');

      // inventaire GLOBAL des doctypes (toutes cibles, pour ne rien manquer)
      if (!doctypeStats.has(doctypeId)) doctypeStats.set(doctypeId, { occ: 0, signed: 0, pending: 0, names: new Map(), targets: new Map() });
      const st = doctypeStats.get(doctypeId);
      st.occ += 1;
      if (isSigned(f)) st.signed += 1;
      else st.pending += 1;
      st.names.set(f.name ?? '(sans nom)', (st.names.get(f.name ?? '(sans nom)') ?? 0) + 1);
      st.targets.set(targetType, (st.targets.get(targetType) ?? 0) + 1);

      // métriques par session : uniquement les docs ciblant un Participant
      const pid = f.entite_liee?.Participant?.id_participant;
      if (pid) {
        docsTotal += 1;
        participantsAvecDoc.add(String(pid));
        if (isSigned(f)) participantsSignes.add(String(pid));
        doctypesDansSession.add(doctypeId);
      }
    }

    return {
      numero,
      year,
      intitule: (session.intitule ?? '').slice(0, 34),
      participants: participants.size,
      docsTotal,
      participantsAvecDoc: participantsAvecDoc.size,
      signes: participantsSignes.size,
      doctypes: doctypesDansSession.size,
      envoyesInfParticipants: docsTotal < participants.size,
    };
  } catch (err) {
    return { numero, year, error: String(err && err.message ? err.message : err).replace(/\s+/g, ' ').slice(0, 120) };
  }
}

// --- main -------------------------------------------------------------------
async function main() {
  console.log(`# DIAGNOSTIC DOCTYPES — lecture seule. Échantillon : ${args.n} sessions 2026 variées + ${args.n} sessions 2025 "${args.keyword}".\n`);

  const list2026 = await listYear(2026);
  const sample2026 = pickSpread(list2026, args.n);

  const list2025 = await listYear(2025);
  const dent2025 = list2025.filter((s) => new RegExp(args.keyword, 'i').test(String(s.intitule ?? '')));
  const sample2025 = pickSpread(dent2025, args.n);

  console.log(`2026 : ${list2026.length} sessions au total → ${sample2026.length} échantillonnées.`);
  console.log(`2025 : ${list2025.length} sessions, dont ${dent2025.length} "${args.keyword}" → ${sample2025.length} échantillonnées.\n`);

  const doctypeStats = new Map();
  const jobs = [
    ...sample2026.map((s) => ({ s, year: 2026 })),
    ...sample2025.map((s) => ({ s, year: 2025 })),
  ];
  const rows = await pool(jobs, CONCURRENCY, ({ s, year }) => inspect(s, year, doctypeStats));

  // ---- Table 1 : inventaire des doctypes -----------------------------------
  console.log('════════ INVENTAIRE DES DOCUMENTS DE SIGNATURE (distincts) ════════');
  console.log(`${pad('doctype_id', 12)}${pad('nom du document (repr.)', 44)}${padL('occ', 5)}${padL('signés', 8)}${padL('attente', 9)}  cibles`);
  console.log('─'.repeat(96));
  const sorted = [...doctypeStats.entries()].sort((a, b) => b[1].occ - a[1].occ);
  for (const [id, st] of sorted) {
    const targets = [...st.targets.entries()].map(([t, n]) => `${t}:${n}`).join(' ');
    console.log(`${pad(id, 12)}${pad(reprName(st.names), 44)}${padL(st.occ, 5)}${padL(st.signed, 8)}${padL(st.pending, 9)}  ${targets}`);
  }
  console.log(`\n→ ${sorted.length} doctype(s) DISTINCT(s) rencontré(s) : ${sorted.map(([id]) => id).join(', ')}\n`);

  // ---- Table 2 : par session ------------------------------------------------
  console.log('════════ PAR SESSION (participants vs documents envoyés vs signés) ════════');
  console.log(`${pad('numero', 16)}${pad('an', 5)}${padL('particip.', 10)}${padL('docsEnv.', 9)}${padL('p.avecDoc', 10)}${padL('signés', 8)}${padL('doctypes', 9)}  intitulé`);
  console.log('─'.repeat(110));
  let okEnvInf = 0;
  let counted = 0;
  const errors = [];
  for (const r of rows) {
    if (!r) continue;
    if (r.error) { errors.push(r); continue; }
    counted += 1;
    if (r.envoyesInfParticipants) okEnvInf += 1;
    const flag = r.envoyesInfParticipants ? '' : '  ⚠ docsEnv≥particip.';
    console.log(
      `${pad(r.numero, 16)}${pad(r.year, 5)}${padL(r.participants, 10)}${padL(r.docsTotal, 9)}${padL(r.participantsAvecDoc, 10)}${padL(r.signes, 8)}${padL(r.doctypes, 9)}  ${r.intitule}${flag}`,
    );
  }

  console.log('\n════════ SYNTHÈSE ════════');
  console.log(`Sessions analysées : ${counted}${errors.length ? ` (+${errors.length} en erreur)` : ''}`);
  console.log(`« documents envoyés < participants » : ${okEnvInf}/${counted} sessions ${okEnvInf === counted ? '✅ (norme confirmée)' : '⚠ à examiner'}`);
  console.log(`Doctypes distincts : ${sorted.length} → ${sorted.map(([id]) => `${id} (${doctypeStats.get(id).occ}x)`).join(', ')}`);
  if (errors.length) {
    console.log('\nErreurs (non bloquantes) :');
    for (const e of errors) console.log(`  ${e.numero} [${e.year}] : ${e.error}`);
  }
}

main().catch((err) => {
  console.error(`!! diagnostic interrompu : ${String(err && err.message ? err.message : err).slice(0, 300)}`);
  process.exit(1);
});
