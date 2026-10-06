// scripts/recon-modules-facturables.mjs — RECON (LECTURE SEULE)
// -----------------------------------------------------------------------------
// But : pour UNE session (idAdf), exposer les FAITS BRUTS de chaque module (LAM) :
// catégories (module ET produit — on n'affirme pas laquelle porte amont/cœur/aval),
// intitulé, mode d'organisation, et TOUTES les dates (planifiées + effectives).
//
// Ce script ne DÉCIDE rien : pas de filtre, pas de règle figée, aucune conclusion.
// Le seul champ calculé est `date_fin_passee` (comparaison au jour, heure de Paris),
// et la date du jour utilisée est affichée en tête pour être vérifiable.
//
// GET UNIQUEMENT. Aucune écriture Dendreo, aucune écriture Firestore, aucun commit.
// La clé API n'apparaît JAMAIS en sortie (rédaction sur TOUTE sortie).
// Coût : 2 requêtes Dendreo (lams.php + actions_de_formation.php).
//
// Usage (PowerShell) :
//   node scripts/recon-modules-facturables.mjs            # défaut idAdf=3818
//   node scripts/recon-modules-facturables.mjs 3129       # autre session
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// --- .env.local (sans dépendance) -------------------------------------------
function loadEnvLocal() {
  const path = join(REPO_ROOT, '.env.local');
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch { fail(`Impossible de lire .env.local à ${path}.`); }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = val;
  }
}
loadEnvLocal();

const API_KEY = process.env.DENDREO_API_KEY;
const BASE_URL = (process.env.DENDREO_BASE_URL || '').replace(/\/+$/, '');
if (!API_KEY) fail('DENDREO_API_KEY manquante dans .env.local.');
if (!BASE_URL) fail('DENDREO_BASE_URL manquante dans .env.local.');

// --- rédaction clé (appliquée sur TOUTE sortie) -----------------------------
function redact(input) {
  if (input == null) return input;
  let s = typeof input === 'string' ? input : String(input);
  if (API_KEY) s = s.split(API_KEY).join('***');
  s = s.replace(/token="[^"]*"/gi, 'token="***"');
  s = s.replace(/([?&]key=)[^&\s]+/gi, '$1***');
  return s;
}
function rlog(...a) { console.log(...a.map((x) => (typeof x === 'string' ? redact(x) : redact(JSON.stringify(x, null, 2))))); }
function fail(msg) { console.error('ERREUR:', redact(msg)); process.exit(1); }

let REQ = 0;
async function get(resource, params = {}) {
  const url = new URL(`${BASE_URL}/${resource}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const safeUrl = redact(url.toString());
  REQ += 1;
  rlog(`  → GET ${safeUrl}`);
  let res;
  try {
    res = await fetch(url, { method: 'GET', headers: { Authorization: `Token token="${API_KEY}"`, Accept: 'application/json' } });
  } catch (err) {
    throw new Error(redact(`fetch KO ${safeUrl} : ${err && err.message ? err.message : err}`));
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* garde le texte */ }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} sur ${safeUrl}\n${redact(text).slice(0, 500)}`);
  return { status: res.status, json, text };
}

function asArray(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.data)) return json.data;
  return json == null ? [] : [json];
}
function head(t) { rlog(`\n${'='.repeat(96)}\n${t}\n${'='.repeat(96)}`); }
function sub(t) { rlog(`\n--- ${t} ---`); }

// --- rendu tableau (largeurs auto, valeurs brutes) --------------------------
const show = (v) => (v === undefined ? '(absent)' : v === null ? 'null' : v === '' ? '(vide)' : String(v));
function printTable(rows, cols) {
  if (!rows.length) { rlog('(aucune ligne)'); return; }
  const w = {};
  for (const c of cols) w[c] = Math.max(c.length, ...rows.map((r) => show(r[c]).length));
  const sep = cols.map((c) => '-'.repeat(w[c])).join('-+-');
  rlog(cols.map((c) => c.padEnd(w[c])).join(' | '));
  rlog(sep);
  for (const r of rows) rlog(cols.map((c) => show(r[c]).padEnd(w[c])).join(' | '));
}

// --- date du jour, heure de Paris (comparaison au JOUR) ---------------------
const TODAY_PARIS = new Intl.DateTimeFormat('fr-CA', {
  timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date()); // → "YYYY-MM-DD"

const jour = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

/**
 * Lit une valeur sans supposer où elle vit : au niveau du LAM ou du module inclus.
 * Renvoie la valeur trouvée + sa provenance (pour que rien ne soit implicite).
 */
function champ(lam, mod, cle) {
  const auLam = lam ? lam[cle] : undefined;
  const auModule = mod ? mod[cle] : undefined;
  const presentLam = auLam !== undefined && auLam !== null;
  const presentMod = auModule !== undefined && auModule !== null;
  let provenance = 'absent';
  if (presentLam && presentMod) provenance = String(auLam) === String(auModule) ? 'lam=module' : 'lam≠module';
  else if (presentLam) provenance = 'lam';
  else if (presentMod) provenance = 'module';
  return { lam: auLam, module: auModule, valeur: presentLam ? auLam : auModule, provenance };
}

async function main() {
  const ID_ADF = String(process.argv[2] || '3818').trim();

  head(`RECON MODULES — session idAdf=${ID_ADF} — LECTURE SEULE (GET only, aucune écriture)`);
  rlog(`# base : ${BASE_URL}`);
  rlog(`# auth : Token token="***" (clé chargée, ${API_KEY.length} car., jamais affichée)`);
  rlog(`# DATE DU JOUR (Europe/Paris) utilisée pour "date_fin_passee" : ${TODAY_PARIS}`);
  rlog('# Ce script n\'applique AUCUN filtre et ne tranche RIEN : il expose les faits bruts.');

  // ===== 1) LAMs de la session ==============================================
  sub('1) Lecture des modules (LAM)');
  const lams = asArray((await get('lams.php', { id_action_de_formation: ID_ADF, include: 'module,creneaux' })).json);
  rlog(`→ ${lams.length} LAM(s) renvoyé(s).`);
  if (!lams.length) {
    rlog('Aucun LAM : rien à afficher pour cette session.');
    head('COÛT');
    rlog(`Requêtes Dendreo consommées : ${REQ}`);
    return;
  }

  // Clés brutes disponibles — pour ne rien supposer sur l'emplacement des champs.
  sub('Clés BRUTES du 1er LAM');
  rlog(Object.keys(lams[0]));
  const mod0 = lams[0].module && typeof lams[0].module === 'object' ? lams[0].module : null;
  sub('Clés BRUTES du module inclus du 1er LAM');
  rlog(mod0 ? Object.keys(mod0) : '(pas d\'objet `module` inclus)');

  // ===== 2) Tableau par module ==============================================
  const rows = lams.map((l) => {
    const m = l.module && typeof l.module === 'object' ? l.module : null;
    const catMod = champ(l, m, 'id_categorie_module');
    const catProd = champ(l, m, 'id_categorie_produit');
    const intit = champ(l, m, 'intitule');
    const modeOrg = champ(l, m, 'mode_organisation');
    const dFin = jour(l.date_fin);
    return {
      id_lam: l.id_lam,
      id_module: l.id_module ?? (m ? m.id_module : undefined),
      id_categorie_module: catMod.valeur,
      id_categorie_produit: catProd.valeur,
      provenance_cat: `${catMod.provenance}/${catProd.provenance}`,
      intitule: String(intit.valeur ?? '').slice(0, 45),
      mode_organisation: modeOrg.valeur,
      date_debut: l.date_debut,
      date_fin: l.date_fin,
      date_effective_debut: l.date_effective_debut,
      date_effective_fin: l.date_effective_fin,
      date_fin_passee: dFin === null ? '(date_fin illisible)' : dFin < TODAY_PARIS,
      // champs internes (non affichés dans le tableau principal)
      _catMod: catMod, _catProd: catProd, _intitule: String(intit.valeur ?? ''), _dFinJour: dFin,
    };
  });

  head(`2) MODULES (LAM) DE LA SESSION ${ID_ADF} — valeurs BRUTES (aujourd'hui Paris = ${TODAY_PARIS})`);
  printTable(rows, [
    'id_lam', 'id_module', 'id_categorie_module', 'id_categorie_produit', 'provenance_cat',
    'intitule', 'mode_organisation', 'date_debut', 'date_fin',
    'date_effective_debut', 'date_effective_fin', 'date_fin_passee',
  ]);
  rlog('provenance_cat = où la valeur a été trouvée (categorie_module/categorie_produit) : lam, module,');
  rlog('  lam=module (les deux, identiques), lam≠module (les deux, DIFFÉRENTES — voir détail ci-dessous) ou absent.');

  const divergents = rows.filter((r) => r.provenance_cat.includes('≠'));
  if (divergents.length) {
    sub('⚠ Divergences LAM vs module inclus (valeurs des DEUX niveaux)');
    printTable(divergents.map((r) => ({
      id_lam: r.id_lam,
      cat_module_AU_LAM: r._catMod.lam, cat_module_AU_MODULE: r._catMod.module,
      cat_produit_AU_LAM: r._catProd.lam, cat_produit_AU_MODULE: r._catProd.module,
    })), ['id_lam', 'cat_module_AU_LAM', 'cat_module_AU_MODULE', 'cat_produit_AU_LAM', 'cat_produit_AU_MODULE']);
  }

  // ===== 3) RÉCAP ===========================================================
  head('3) RÉCAP');

  // 3a) catégories module distinctes + intitulés associés
  const parCatMod = new Map();
  for (const r of rows) {
    const k = show(r.id_categorie_module);
    if (!parCatMod.has(k)) parCatMod.set(k, []);
    parCatMod.get(k).push(r);
  }
  sub('3a) id_categorie_module DISTINCTS présents, avec les intitulés de modules associés');
  rlog('(à toi de reconnaître visuellement amont / cœur / aval — le script ne le déduit PAS)');
  for (const [cat, list] of [...parCatMod.entries()].sort()) {
    rlog(`\n  id_categorie_module = ${cat}  (${list.length} module(s))`);
    for (const r of list) {
      rlog(`    • [lam ${show(r.id_lam)} / module ${show(r.id_module)}] ${r._intitule || '(intitulé absent)'}`);
      rlog(`        id_categorie_produit = ${show(r.id_categorie_produit)} | mode_organisation = ${show(r.mode_organisation)}`);
    }
  }

  // 3b) date_fin MAX par catégorie
  sub('3b) Regroupement par id_categorie_module → date_fin MAX (comparaison sur le jour)');
  const recapCat = [...parCatMod.entries()].sort().map(([cat, list]) => {
    const jours = list.map((r) => r._dFinJour).filter(Boolean).sort();
    const maxJour = jours.length ? jours[jours.length - 1] : null;
    const minJour = jours.length ? jours[0] : null;
    const effFins = list.map((r) => jour(r.date_effective_fin)).filter(Boolean).sort();
    return {
      id_categorie_module: cat,
      nb_modules: list.length,
      date_fin_MIN: minJour ?? '(aucune date_fin lisible)',
      date_fin_MAX: maxJour ?? '(aucune date_fin lisible)',
      date_fin_MAX_passee: maxJour === null ? '(n/a)' : maxJour < TODAY_PARIS,
      date_effective_fin_MAX: effFins.length ? effFins[effFins.length - 1] : '(aucune)',
      intitules: list.map((r) => r._intitule.slice(0, 28) || '(?)').join(' | '),
    };
  });
  printTable(recapCat, [
    'id_categorie_module', 'nb_modules', 'date_fin_MIN', 'date_fin_MAX',
    'date_fin_MAX_passee', 'date_effective_fin_MAX', 'intitules',
  ]);

  // 3c) dates de la session (ADF)
  sub('3c) Dates de la SESSION (actions_de_formation.php) — pour situer le à-cheval 26/27');
  try {
    const adf = asArray((await get('actions_de_formation.php', {
      id: ID_ADF,
      fields: 'id_action_de_formation,numero_complet,intitule,date_debut,date_fin,mode_organisation',
    })).json)[0];
    if (!adf) {
      rlog(`⚠ actions_de_formation.php?id=${ID_ADF} ne renvoie rien.`);
    } else {
      printTable([{
        id_action_de_formation: adf.id_action_de_formation,
        numero_complet: adf.numero_complet,
        date_debut: adf.date_debut,
        date_fin: adf.date_fin,
        mode_organisation: adf.mode_organisation,
        annee_debut: jour(adf.date_debut) ? jour(adf.date_debut).slice(0, 4) : '(?)',
        annee_fin: jour(adf.date_fin) ? jour(adf.date_fin).slice(0, 4) : '(?)',
        intitule: String(adf.intitule ?? '').slice(0, 45),
      }], ['id_action_de_formation', 'numero_complet', 'date_debut', 'date_fin', 'mode_organisation', 'annee_debut', 'annee_fin', 'intitule']);
      const a1 = jour(adf.date_debut) && jour(adf.date_debut).slice(0, 4);
      const a2 = jour(adf.date_fin) && jour(adf.date_fin).slice(0, 4);
      rlog(`Fait brut : annee(date_debut)=${a1 ?? '?'} , annee(date_fin)=${a2 ?? '?'} → ${a1 && a2 && a1 !== a2 ? 'les deux années DIFFÈRENT' : 'même année'} (constat, pas une décision).`);
    }
  } catch (err) { rlog('Lecture ADF KO :', err.message); }

  // ===== COÛT ===============================================================
  head('COÛT');
  rlog(`Requêtes Dendreo consommées par CETTE recon : ${REQ}`);
  rlog('Aucune écriture Dendreo, aucune écriture Firestore, aucun commit.');
}

main().catch((err) => { rlog(`!! RECON interrompue : ${err && err.message ? err.message : err}`); process.exit(1); });
