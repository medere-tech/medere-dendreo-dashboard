// scripts/recon.mjs — Sprint S0, RECONNAISSANCE (lecture seule)
// -----------------------------------------------------------------------------
// Script JETABLE. GET UNIQUEMENT vers Dendreo. Aucune écriture, jamais.
// La clé API n'apparaît JAMAIS en sortie : redact() la remplace par *** partout
// (y compris URLs loggées et messages d'erreur).
//
// Usage (PowerShell) :
//   node scripts/recon.mjs            # exécute toutes les sondes 1..8 dans l'ordre
//   node scripts/recon.mjs 1          # exécute la sonde 1 seulement (smoke test auth)
//   node scripts/recon.mjs 1 2 3      # exécute un sous-ensemble, dans l'ordre donné
//
// Les sondes partagent un petit état (sessions échantillonnées, ids participants,
// id_media trouvés) pour chaîner sans re-requêter. Si une sonde dépendante est
// lancée seule, elle refait le minimum d'appels nécessaires.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// --- Chargement .env.local (sans dépendance) --------------------------------
function loadEnvLocal() {
  const path = join(REPO_ROOT, '.env.local');
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    fail(`Impossible de lire .env.local à ${path}. Crée-le avec DENDREO_API_KEY et DENDREO_BASE_URL.`);
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let val = m[2];
    // retire d'éventuels guillemets entourants
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = val;
  }
}
loadEnvLocal();

const API_KEY = process.env.DENDREO_API_KEY;
const BASE_URL = (process.env.DENDREO_BASE_URL || '').replace(/\/+$/, '');

if (!API_KEY) fail('DENDREO_API_KEY manquante dans .env.local.');
if (!BASE_URL) fail('DENDREO_BASE_URL manquante dans .env.local.');

// --- Rédaction de la clé : à appliquer sur TOUTE chaîne avant affichage ------
function redact(input) {
  if (input == null) return input;
  let s = typeof input === 'string' ? input : String(input);
  if (API_KEY) s = s.split(API_KEY).join('***');
  // ceintures + bretelles : masque aussi les formes d'auth même si la clé diffère
  s = s.replace(/token="[^"]*"/gi, 'token="***"');
  s = s.replace(/([?&]key=)[^&\s]+/gi, '$1***');
  return s;
}
function rlog(...args) {
  console.log(...args.map((a) => (typeof a === 'string' ? redact(a) : redact(JSON.stringify(a, null, 2)))));
}
function fail(msg) {
  console.error('ERREUR S0:', redact(msg));
  process.exit(1);
}

// --- Compteur de requêtes (pour estimer le coût quota) ----------------------
let REQUEST_COUNT = 0;
const RATE_HEADERS_SEEN = {};

// --- GET sécurisé : header Authorization, jamais la clé dans l'URL -----------
async function get(resource, params = {}) {
  const url = new URL(`${BASE_URL}/${resource}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const safeUrl = redact(url.toString());
  REQUEST_COUNT += 1;
  rlog(`  → GET ${safeUrl}`);

  let res;
  try {
    res = await fetch(url, {
      method: 'GET', // GET UNIQUEMENT — ne jamais changer
      headers: {
        Authorization: `Token token="${API_KEY}"`,
        Accept: 'application/json',
      },
    });
  } catch (err) {
    // une erreur réseau/SDK peut transporter la clé via message/cause → on rédige
    throw new Error(redact(`fetch a échoué pour ${safeUrl} : ${err && err.message ? err.message : err}`));
  }

  // capture des en-têtes de quota éventuels (X-RateLimit-*, Retry-After…)
  for (const [hk, hv] of res.headers.entries()) {
    if (/ratelimit|retry-after|quota|x-rate/i.test(hk)) RATE_HEADERS_SEEN[hk] = hv;
  }

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* réponse non-JSON : on garde le texte (rédigé) pour diagnostic */
  }

  if (!res.ok) {
    const snippet = redact(text).slice(0, 600);
    throw new Error(`HTTP ${res.status} ${res.statusText} sur ${safeUrl}\n${snippet}`);
  }
  return { status: res.status, json, text };
}

// --- Helpers d'affichage -----------------------------------------------------
function head(n, title) {
  rlog(`\n${'='.repeat(78)}\nSONDE ${n} — ${title}\n${'='.repeat(78)}`);
}
function sub(title) {
  rlog(`\n--- ${title} ---`);
}
function sample(arr, n = 3) {
  return Array.isArray(arr) ? arr.slice(0, n) : arr;
}
function asArray(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.data)) return json.data; // au cas où l'API enveloppe
  return json == null ? [] : [json];
}
// Slim d'un objet fichier/média : champs utiles + entite_liee anonymisée (pas de PII brute)
function slimFichier(f) {
  if (!f || typeof f !== 'object') return f;
  let lien = null;
  const el = f.entite_liee;
  if (el && typeof el === 'object') {
    const type = Object.keys(el)[0];
    const o = el[type] || {};
    const init = `${(o.prenom || '?').trim()[0] || '?'}.${(o.nom || '?').trim()[0] || '?'}.`;
    lien = { type, id_participant: o.id_participant ?? null, initiales: init };
  }
  return {
    id: f.id, collection_name: f.collection_name, name: f.name, doctype_id: f.doctype_id,
    mime_type: f.mime_type, signature_date: f.signature_date, signe: !!(f.signature_date && f.signature_date.trim()),
    cible: f.cible, id_cible: f.id_cible, related_media_id: f.related_media_id,
    created_at: f.created_at, entite_liee: lien,
  };
}

// --- État partagé entre sondes ----------------------------------------------
const state = {
  sessions: null, // sondes 2 -> 3/4
  etapes: null,
  chosenAdf: null, // { id, numero_complet } sonde 3 -> 4/5/6
  participantIds: [], // sonde 4 -> 5
  esignDocs: [], // sonde 5 -> 7 : { id_media, intitule, count, adfs }
  sigAdfIds: [], // sonde 5 -> 6 : ADF qui ont une signature en attente
  pendingSample: null, // sonde 5 -> 6 : une tâche esignature-doc (pour cible Participant)
};

// =============================================================================
// SONDE 1 — Connexion + auth + centre(s)
// =============================================================================
async function probe1() {
  head(1, 'Connexion + auth + centre(s)  [centres_de_formation.php]');
  const { status, json } = await get('centres_de_formation.php');
  const centres = asArray(json);
  rlog(`HTTP ${status} — ${centres.length} centre(s) trouvé(s).`);
  rlog('Centres (id + nom si dispo) :', centres.map((c) => ({
    id: c.id_centre_de_formation ?? c.id ?? null,
    nom: c.nom ?? c.raison_sociale ?? c.intitule ?? null,
  })));
  sub('Exemple brut (1er centre, tous champs)');
  rlog(sample(centres, 1));
}

// =============================================================================
// SONDE 2 — Volume & étapes des sessions 2026
// =============================================================================
async function probe2() {
  head(2, 'Volume & étapes des sessions 2026  [actions_de_formation.php]');

  // référentiel des étapes (pour traduire id_etape_process)
  try {
    const e = await get('etapes.php');
    state.etapes = asArray(e.json);
    sub('Étapes du process (etapes.php)');
    rlog(state.etapes.map((x) => ({
      id: x.id_etape_process ?? x.id ?? null,
      intitule: x.intitule ?? x.nom ?? null,
    })));
  } catch (err) {
    rlog('etapes.php indisponible (non bloquant) :', err.message);
  }

  const fields = [
    'id_action_de_formation', 'numero_complet', 'intitule',
    'date_debut', 'date_fin', 'id_etape_process', 'total_participants',
    'id_centre_de_formation', 'type',
  ].join(',');

  // (A) Filtre "entièrement contenu dans 2026"
  const { json } = await get('actions_de_formation.php', {
    started_after: '2026-01-01',
    ended_before: '2026-12-31',
    fields,
  });
  const sessions = asArray(json);
  state.sessions = sessions;
  rlog(`\n(A) Sessions ENTIÈREMENT dans 2026 (started_after & ended_before) : ${sessions.length}`);

  // (B) Filtre de CHEVAUCHEMENT (toute session active à un moment en 2026)
  try {
    const overlap = await get('actions_de_formation.php', {
      started_before: '2026-12-31',
      ended_after: '2026-01-01',
      fields: 'id_action_de_formation,id_etape_process,type',
    });
    const ov = asArray(overlap.json);
    rlog(`(B) Sessions qui CHEVAUCHENT 2026 (started_before & ended_after) : ${ov.length}  ← à comparer au ~659 du brief`);
  } catch (err) {
    rlog('(B) comptage chevauchement indisponible :', err.message);
  }

  const stepLabel = (id) => {
    const e = (state.etapes || []).find((x) => String(x.id_etape_process ?? x.id) === String(id));
    return e ? (e.intitule ?? e.nom ?? '?') : '?';
  };
  const tally = (arr, keyFn) => {
    const m = {};
    for (const s of arr) { const k = String(keyFn(s) ?? 'null'); m[k] = (m[k] || 0) + 1; }
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  };

  sub('Distribution par id_etape_process (filtre A)');
  rlog(tally(sessions, (s) => s.id_etape_process).map(([id, n]) => ({ id_etape_process: id, libelle: stepLabel(id), nb: n })));
  sub('Ventilation par centre (filtre A)');
  rlog(tally(sessions, (s) => s.id_centre_de_formation).map(([id, n]) => ({ id_centre_de_formation: id, nb: n })));
  sub('Ventilation par type inter/intra (filtre A)');
  rlog(tally(sessions, (s) => s.type).map(([t, n]) => ({ type: t, nb: n })));

  sub('Échantillon de 5 sessions (filtre A)');
  rlog(sample(sessions, 5));
}

// =============================================================================
// SONDE 3 — Anatomie d'une session "3 sous-modules"  (INCONNUE n°1)
//   Cible le NIVEAU LAM (les 3 sous-modules) + modules.php catalogue, champs
//   restreints : on cherche où vit "connecté / non connecté".
// =============================================================================
async function probe3() {
  head(3, 'Anatomie session "3 sous-modules"  [lams.php + modules.php, champs ciblés]  (INCONNUE 1)');

  // Résolution de la session cible : hint spec → sinon 1re session de la sonde 2
  let adfId = null, numero = null, intitule = null;
  try {
    const r = await get('actions_de_formation.php', {
      numero_complet: 'ADF_20260316',
      fields: 'id_action_de_formation,numero_complet,intitule',
    });
    const a = asArray(r.json);
    if (a.length) { adfId = a[0].id_action_de_formation; numero = a[0].numero_complet; intitule = a[0].intitule; }
  } catch (err) {
    rlog('Hint ADF_20260316 non résolu (non bloquant) :', err.message);
  }
  if (!adfId) {
    if (!state.sessions) await probe2();
    const s = (state.sessions || [])[0];
    if (s) { adfId = s.id_action_de_formation; numero = s.numero_complet; intitule = s.intitule; }
  }
  if (!adfId) { rlog('Aucune session cible pour la sonde 3.'); return; }

  state.chosenAdf = { id: adfId, numero_complet: numero };
  rlog(`>>> Session cible : ${numero} (id=${adfId}) — "${intitule ?? ''}"`);

  // 3a — LAMs (les "sous-modules") de la session, NIVEAU LAM, champs ciblés
  const lamFields = 'id_lam,id_module,intitule,mode_organisation,master_lam_id,id_categorie_module,duree';
  let lams = [];
  try {
    const lr = await get('lams.php', { id_action_de_formation: adfId, fields: lamFields });
    lams = asArray(lr.json);
    sub(`LAMs / sous-modules de la session — ${lams.length} ligne(s) (champs ciblés)`);
    rlog(lams);
  } catch (err) {
    rlog('lams.php indisponible :', err.message);
  }

  // 3b — Modules catalogue liés : la notion connecté/non connecté vit ICI
  const modIds = [...new Set(lams.map((l) => l.id_module).filter(Boolean))].join(',');
  if (modIds) {
    const modFields = [
      'id_module', 'intitule', 'intitule_court', 'mode_organisation',
      'id_categorie_module', 'eligible_dpc', 'duree_heures', 'is_master_module',
      'c_nombre_dheures_connectees', 'c_nombre_dheures_non_connectees',
    ].join(',');
    try {
      const mr = await get('modules.php', { id: modIds, fields: modFields });
      const mods = asArray(mr.json);
      sub('Modules catalogue liés (CHAMPS CIBLÉS connecté/non connecté)');
      rlog(mods);
      sub('Lecture "connecté/non connecté" par module');
      rlog(mods.map((m) => ({
        id_module: m.id_module,
        intitule_court: m.intitule_court,
        mode_organisation: m.mode_organisation,
        h_connectees: m.c_nombre_dheures_connectees,
        h_non_connectees: m.c_nombre_dheures_non_connectees,
        is_master_module: m.is_master_module,
      })));
    } catch (err) {
      rlog('modules.php indisponible :', err.message);
    }
  } else {
    rlog('Aucun id_module collecté depuis les LAMs (à investiguer).');
  }
}

// =============================================================================
// SONDE 4 — Participants de la session  [laps.php?include=participant]
//   Slim + anonymisation EN SORTIE (initiales seulement, pas de PII brute).
// =============================================================================
async function probe4() {
  head(4, 'Participants de la session  [laps.php?include=participant]  (slim, anonymisé)');
  if (!state.chosenAdf) await probe3();
  if (!state.chosenAdf) { rlog('Pas de session choisie — sonde 4 sautée.'); return; }

  const { json } = await get('laps.php', {
    id_action_de_formation: state.chosenAdf.id,
    include: 'participant',
  });
  const laps = asArray(json);
  rlog(`${laps.length} participant(s) pour ${state.chosenAdf.numero_complet}.`);

  state.participantIds = laps
    .map((l) => l.id_participant ?? (l.participant && l.participant.id_participant))
    .filter(Boolean);
  rlog(`id_participant collectés : ${state.participantIds.length}`);

  const initials = (p) => `${(p.prenom || '?').trim()[0] || '?'}.${(p.nom || '?').trim()[0] || '?'}.`;
  sub('Échantillon participants (INITIALES seulement — pas de PII)');
  rlog(laps.slice(0, 3).map((l) => {
    const p = l.participant || {};
    return {
      id_lap: l.id_lap, id_participant: l.id_participant,
      initiales: initials(p), a_email: !!p.email, status: l.status, lap_status_id: l.lap_status_id,
    };
  }));
  sub('Clés disponibles sur un objet participant');
  rlog(laps[0]?.participant ? Object.keys(laps[0].participant) : '(pas de participant inclus)');
}

// =============================================================================
// SONDE 5 — Signatures EN ATTENTE  [taches.php?types=esignature-doc]  (cœur)
//   Structure réelle : [{ id_participant, counts, taches:[{...}] }] → on aplatit.
//   ⚠ taches.php est PARTICIPANT-scoped : couvre toutes les ADF du participant.
// =============================================================================
async function probe5() {
  head(5, 'Signatures en attente  [taches.php?types=esignature-doc]');
  if (!state.participantIds.length) await probe4();
  if (!state.participantIds.length) { rlog('Aucun id_participant — sonde 5 sautée.'); return; }

  const batch = state.participantIds.slice(0, 80).join(',');
  const { json } = await get('taches.php', { id: batch, types: 'esignature-doc' });
  const rows = asArray(json);

  // aplatissement de la structure imbriquée
  const flat = [];
  for (const r of rows) {
    for (const t of (r.taches || [])) {
      if (t && t.type === 'esignature-doc') flat.push({ id_participant: r.id_participant, ...t });
    }
  }
  rlog(`${flat.length} signature(s) EN ATTENTE sur ${rows.length} participants interrogés.`);
  state.pendingSample = flat[0] || null;

  sub('Échantillon (URL tronquée, sans PII directe)');
  rlog(flat.slice(0, 5).map((t) => ({
    id_participant: t.id_participant, id_media: t.id_media, intitule: t.intitule, date: t.date, id_adf: t.id_adf,
  })));

  const adfs = [...new Set(flat.map((t) => t.id_adf).filter(Boolean))];
  state.sigAdfIds = adfs;
  rlog(`\n⚠ Ces tâches couvrent ${adfs.length} ADF distinctes (taches.php est participant-scoped, pas session) : ${adfs.join(', ')}`);

  const docs = {};
  for (const t of flat) {
    const k = String(t.id_media ?? 'null');
    (docs[k] ||= { id_media: t.id_media ?? null, intitule: t.intitule ?? null, count: 0, adfs: new Set() });
    docs[k].count += 1; docs[k].adfs.add(t.id_adf);
  }
  state.esignDocs = Object.values(docs).map((d) => ({ ...d, adfs: [...d.adfs] }));
  sub('Documents de signature distincts (id_media → intitulé → nb → adfs)');
  rlog(state.esignDocs);
}

// =============================================================================
// SONDE 6 — Espace de stockage  [fichiers.php]  (INCONNUE n°2)
//   Cible en priorité les ADF qui ONT une signature en attente (sonde 5),
//   teste plusieurs valeurs de `cible` + la cible Participant, capture JSON brut.
// =============================================================================
async function probe6() {
  head(6, 'Espace de stockage  [fichiers.php]  (INCONNUE 2)');
  if (!state.sigAdfIds?.length && !state.chosenAdf) await probe5();

  const adfTargets = [...new Set([...(state.sigAdfIds || []), state.chosenAdf?.id].filter(Boolean))];
  if (!adfTargets.length) { rlog('Pas d\'ADF cible — lance la sonde 5 d\'abord.'); return; }
  rlog(`ADF ciblées (priorité aux sessions avec signature) : ${adfTargets.join(', ')}`);

  // 6.0 — SHOW direct sur l'id_media renvoyé par taches.php (donnée réelle, pas une supposition)
  // La doc confirme fichiers.php?id=NNN (SHOW). On teste aussi ?id_media=NNN.
  // 6.0 — SHOW direct sur l'id_media renvoyé par taches.php (param confirmé : ?id=NNN)
  const mediaIds = (state.esignDocs || []).map((d) => d.id_media).filter(Boolean);
  for (const mid of mediaIds) {
    sub(`SHOW fichiers.php?id=${mid} (média pointé par taches.php)`);
    try {
      const { status, json } = await get('fichiers.php', { id: mid });
      const arr = asArray(json);
      rlog(`HTTP ${status} — ${arr.length} objet(s).`);
      if (arr.length) {
        rlog('Clés brutes du média :', Object.keys(arr[0]));
        rlog('Média (slim, PII anonymisée) :', arr.map(slimFichier));
      }
    } catch (err) { rlog('échec :', err.message); }
  }

  // 6.1 — LIST de la collection "signature" par session (PARAMÈTRES CONFIRMÉS)
  //   cible="action-de-formation" (tirets) + collection_name="signature".
  const CIBLE = 'action-de-formation';
  const COLLECTION = 'signature';
  for (const adfId of adfTargets) {
    sub(`LIST fichiers.php?cible=${CIBLE}&id_cible=${adfId}&collection_name=${COLLECTION}`);
    try {
      const { status, json } = await get('fichiers.php', { cible: CIBLE, id_cible: adfId, collection_name: COLLECTION });
      const arr = asArray(json);
      rlog(`HTTP ${status} — ${arr.length} doc(s) de signature.`);
      if (arr.length) {
        const slim = arr.map(slimFichier);
        rlog('Docs signature (slim) :', slim);
        const signes = slim.filter((f) => f.signe).length;
        rlog(`→ ${signes} signé(s) / ${arr.length - signes} en attente (signature_date vide).`);
        rlog('→ doctypes présents (name | doctype_id) :',
          [...new Map(slim.map((f) => [f.doctype_id, `${f.name} | ${f.doctype_id}`])).values()]);
      }
    } catch (err) { rlog('échec :', err.message); }
  }

  // 6.2 — sans collection_name → recenser TOUTES les collections d'une session
  const adf0 = adfTargets[0];
  sub(`LIST fichiers.php?cible=${CIBLE}&id_cible=${adf0} (sans collection_name → quelles collections ?)`);
  try {
    const { status, json } = await get('fichiers.php', { cible: CIBLE, id_cible: adf0 });
    const arr = asArray(json);
    rlog(`HTTP ${status} — ${arr.length} fichier(s) toutes collections.`);
    if (arr.length) {
      rlog('collection_name présents :', [...new Set(arr.map((f) => f.collection_name).filter(Boolean))]);
      rlog('Aperçu (slim) :', arr.slice(0, 6).map(slimFichier));
    }
  } catch (err) { rlog('échec :', err.message); }
}

// =============================================================================
// SONDE 7 — Mapping du document "même nom"  (INCONNUE n°3) — synthèse
// =============================================================================
async function probe7() {
  head(7, 'Mapping document "même nom"  (INCONNUE 3) — recoupement taches.php × fichiers.php');
  if (!state.esignDocs.length) {
    rlog('Pas d\'id_media collecté en sonde 5. Lance d\'abord 5 (et 6) pour recouper.');
    return;
  }
  rlog('id_media EN ATTENTE vus via taches.php :', state.esignDocs);
  rlog('\nRègle d\'identification confirmée en sonde 6 :');
  rlog(' - Doc de signature = collection_name="signature" sur cible="action-de-formation".');
  rlog(' - "Même nom" = champ `name` + `doctype_id` (modèle stable). Ex. réel : "Convention_Participant_Formation_Médéré" (doctype_id=111).');
  rlog(' - SIGNÉ = `signature_date` non vide ; EN ATTENTE = `signature_date` vide (recoupe taches.php esignature-doc).');
  rlog('\n⚠ À trancher avec Justine : QUEL doctype_id/name = l\'ATTESTATION sur l\'honneur des modules NON CONNECTÉS (vs Convention).');
}

// =============================================================================
// SONDE 8 — Marge de quota API
// =============================================================================
async function probe8() {
  head(8, 'Marge de quota API (abonnement Or)');
  rlog('En-têtes liés au quota observés sur les réponses de cette exécution :');
  rlog(Object.keys(RATE_HEADERS_SEEN).length ? RATE_HEADERS_SEEN : '(aucun en-tête de quota exposé par l\'API sur les réponses)');
  rlog('\nNB : la marge MENSUELLE (Or) n\'est en général visible que dans l\'UI Dendreo (page config API).');
  rlog('À relever côté UI par Déthié : quota mensuel total + consommation courante.');
  rlog(`\nRequêtes consommées par CETTE exécution recon : ${REQUEST_COUNT}`);
}

// =============================================================================
// Orchestration
// =============================================================================
const PROBES = { 1: probe1, 2: probe2, 3: probe3, 4: probe4, 5: probe5, 6: probe6, 7: probe7, 8: probe8 };

async function main() {
  const args = process.argv.slice(2).filter((a) => /^[1-8]$/.test(a));
  const toRun = args.length ? args.map(Number) : [1, 2, 3, 4, 5, 6, 7, 8];

  rlog(`# RECON S0 — base: ${BASE_URL}`);
  rlog(`# Auth: header Authorization: Token token="***" (clé chargée, ${API_KEY.length} caractères — jamais affichée)`);
  rlog(`# Sondes à exécuter : ${toRun.join(', ')}`);

  for (const n of toRun) {
    try {
      await PROBES[n]();
    } catch (err) {
      rlog(`\n!! SONDE ${n} a échoué : ${err && err.message ? err.message : err}`);
    }
  }

  rlog(`\n${'#'.repeat(78)}`);
  rlog(`# FIN RECON — total requêtes Dendreo cette exécution : ${REQUEST_COUNT}`);
  rlog(`# Rappel coût sync complète : ~659 sessions × (appels/session) — à estimer dans findings.`);
  rlog(`${'#'.repeat(78)}`);
}

main();
