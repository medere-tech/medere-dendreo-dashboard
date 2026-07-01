// scripts/inspect-notsent.mjs — DIAGNOSTIC read-only (aucune écriture Dendreo ni Firestore).
// Pour une année (défaut 2025), classe les sessions par notSent décroissant, et pour le
// top N imprime SANS PII : numeroComplet, intitule, type, le mode_organisation de chaque
// module (via include=modules), + le détail signed/pending/notSent.
// But : voir si un fort notSent corrèle avec un type de session / un mode_organisation.
//
//   npx tsx scripts/inspect-notsent.mjs [--year 2025] [--top 5]

import { loadDendreoEnv } from '../src/config';
import { DendreoClient } from '../src/dendreo/client';
import { getSessionSignatureStatus } from '../src/dendreo/signatures';

function parseArgs(argv) {
  const a = { year: 2025, top: 5 };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--year') a.year = Number(argv[++i]);
    else if (t.startsWith('--year=')) a.year = Number(t.slice(7));
    else if (t === '--top') a.top = Number(argv[++i]);
    else if (t.startsWith('--top=')) a.top = Number(t.slice(6));
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
const client = new DendreoClient(loadDendreoEnv());
const log = (...m) => console.log(...m);
const asArray = (j) => (Array.isArray(j) ? j : j && Array.isArray(j.data) ? j.data : j == null ? [] : [j]);

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

async function main() {
  log(`# DIAGNOSTIC notSent — année ${args.year}, top ${args.top} (read-only)`);

  // 1) Sessions de l'année (fields ciblés, pas de PII)
  const sessions = asArray(await client.get('actions_de_formation.php', {
    started_after: `${args.year}-01-01`,
    started_before: `${args.year}-12-31`,
    fields: 'id_action_de_formation,numero_complet,intitule,type,total_participants',
  }));
  log(`# ${sessions.length} session(s) en ${args.year} — calcul du statut (≈2 lectures/session, débit borné)…`);

  // 2) Statut signature de chaque session
  const rows = await pool(sessions, 5, async (s) => {
    const idAdf = String(s.id_action_de_formation);
    try {
      const st = await getSessionSignatureStatus(idAdf, client);
      return {
        idAdf,
        numeroComplet: s.numero_complet ?? `ADF_${idAdf}`,
        intitule: s.intitule ?? '',
        type: s.type ?? '',
        totalParticipants: Number(s.total_participants ?? 0) || 0,
        signed: st.signed.length,
        pending: st.pending.length,
        notSent: st.notSent.length,
      };
    } catch (err) {
      return { idAdf, numeroComplet: s.numero_complet ?? `ADF_${idAdf}`, error: String(err && err.message ? err.message : err).slice(0, 160) };
    }
  });

  const ok = rows.filter((r) => !r.error);
  const errs = rows.filter((r) => r.error);

  // 3) Agrégat par type (corrélation type ↔ notSent), SANS PII
  const byType = {};
  for (const r of ok) {
    const k = r.type || '(vide)';
    byType[k] ??= { sessions: 0, signed: 0, pending: 0, notSent: 0 };
    byType[k].sessions += 1; byType[k].signed += r.signed; byType[k].pending += r.pending; byType[k].notSent += r.notSent;
  }
  log(`\n=== notSent par type de session (${args.year}) ===`);
  for (const [type, a] of Object.entries(byType).sort((x, y) => y[1].notSent - x[1].notSent)) {
    log(`  type=${type} : sessions=${a.sessions} signed=${a.signed} pending=${a.pending} notSent=${a.notSent}`);
  }

  // 4) Top N notSent + détail modules (include=modules)
  const top = [...ok].sort((x, y) => y.notSent - x.notSent).slice(0, args.top);
  log(`\n=== TOP ${args.top} sessions par notSent ===`);
  for (const r of top) {
    log(`\n• ${r.numeroComplet} | type=${r.type} | participants=${r.totalParticipants}`);
    log(`  intitulé : ${r.intitule}`);
    log(`  statut   : signed=${r.signed} pending=${r.pending} notSent=${r.notSent}`);
    try {
      const det = asArray(await client.get('actions_de_formation.php', { id: r.idAdf, include: 'modules' }));
      const modules = (det[0] && Array.isArray(det[0].modules)) ? det[0].modules : [];
      log(`  modules (${modules.length}) :`);
      for (const m of modules) {
        const parent = m.module_parent && (m.module_parent.intitule_court ?? m.module_parent.intitule);
        log(`    - "${m.intitule_court ?? m.intitule ?? '?'}" | mode_organisation=${m.mode_organisation ?? '(absent)'} | id_categorie_module=${m.id_categorie_module ?? '?'}${parent ? ` | parent="${parent}"` : ''}`);
      }
    } catch (err) {
      log(`  modules : erreur de lecture (${String(err && err.message ? err.message : err).slice(0, 120)})`);
    }
  }

  if (errs.length) {
    log(`\n=== ${errs.length} session(s) en erreur (ids only) ===`);
    for (const e of errs.slice(0, 30)) log(`  idAdf=${e.idAdf} : ${e.error}`);
  }
  log(`\n# fin diagnostic.`);
}

main().catch((err) => { log(`!! diagnostic interrompu : ${String(err && err.message ? err.message : err).slice(0, 200)}`); process.exit(1); });
