// scripts/inspect-viewerurl.mjs — DIAGNOSTIC read-only du lien de visualisation.
// Compare viewerUrl (miroir) entre attestations PENDING vs SIGNED d'une même session,
// et au public_url live de fichiers.php. Aucune écriture. Tokens masqués.
import { getDb } from '../src/firebase/admin';
import { loadDendreoEnv, DENDREO } from '../src/config';
import { DendreoClient } from '../src/dendreo/client';

const c = new DendreoClient(loadDendreoEnv());
const A = (j) => (Array.isArray(j) ? j : j && Array.isArray(j.data) ? j.data : j == null ? [] : [j]);
// Masque les segments "tokens" (longues suites alphanum) pour ne rien logger de sensible,
// tout en gardant la STRUCTURE du chemin (c'est elle qui révèle une 404).
const mask = (u) =>
  String(u ?? '')
    .replace(/\?[^#]*/, '?…')
    .replace(/([\/=])([A-Za-z0-9_-]{12,})/g, (_, p) => `${p}<token>`);

async function main() {
  // Session ciblée directement (évite un scan de toute la collection → quota).
  const idAdf = process.argv[2] || '2277';
  console.log(`Session témoin idAdf=${idAdf}\n`);

  // 2) Dump viewerUrl du miroir par statut (structure masquée).
  const sigs = await getDb().collection('signatures').where('idAdf', '==', idAdf).get();
  const rows = [];
  sigs.forEach((d) => {
    const s = d.data();
    rows.push({ status: s.status, doctypeId: s.doctypeId, hasViewer: !!s.viewerUrl, viewer: mask(s.viewerUrl) });
  });
  rows.sort((a, b) => a.status.localeCompare(b.status));
  console.log('=== MIROIR signatures.viewerUrl (par statut) ===');
  for (const r of rows) {
    console.log(`  [${r.status.padEnd(7)}] doctype=${r.doctypeId} hasViewer=${r.hasViewer}`);
    console.log(`      ${r.viewer || '(vide)'}`);
  }

  // 3) Live fichiers.php : public_url par fichier (signé ou pas), structure masquée.
  console.log('\n=== LIVE fichiers.php public_url (collection signature) ===');
  const fichiers = A(await c.get('fichiers.php', {
    cible: DENDREO.CIBLE_ADF, id_cible: idAdf, collection_name: DENDREO.COLLECTION_SIGNATURE,
  }));
  for (const f of fichiers.slice(0, 12)) {
    const signe = !!(f.signature_date && String(f.signature_date).trim());
    const keys = Object.keys(f).filter((k) => /url|view|lien|link/i.test(k));
    console.log(`  doctype=${f.doctype_id} signe=${signe} champsURL=[${keys.join(', ')}]`);
    console.log(`      public_url = ${mask(f.public_url)}`);
  }

  // 4) Quels CHAMPS d'URL fichiers.php expose-t-il vraiment ? (union des clés url)
  const urlKeys = new Set();
  for (const f of fichiers) for (const k of Object.keys(f)) if (/url|view|lien|link/i.test(k)) urlKeys.add(k);
  console.log(`\nChamps ressemblant à une URL dans fichiers.php : ${[...urlKeys].join(', ')}`);
}
main().catch((e) => { console.error(String(e?.message ?? e).slice(0, 300)); process.exit(1); });
