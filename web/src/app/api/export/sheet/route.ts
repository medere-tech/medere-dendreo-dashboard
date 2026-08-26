import { getDb } from '@shared/firebase/admin';
import { toSessionDoc, type SessionDoc } from '@/lib/firestore/sessions';
import {
  SESSIONS_SHEET_HEADERS,
  SESSIONS_SHEET_HEADERS_CHEVAL2026,
  sessionToSheetRow,
  sessionToSheetRowCheval2026,
} from '@/lib/sessions/export';
import { isEchecEtape } from '@/lib/sessions/derive';
import { isSheetExportAuthorized } from '@/lib/server/sheet-auth';
import { todayInParis } from '@/lib/time';

/**
 * Route de lecture `GET /api/export/sheet` (S10.1, Option C — cf.
 * docs/sprint-10-faisabilite-sheets.md). Expose les MÊMES lignes que l'export CSV
 * cockpit, en JSON, préfixées de `idAdf` (clé de correspondance), pour que l'Apps
 * Script (S10.2) mette à jour un Google Sheet EN PLACE sans écraser les colonnes
 * manuelles. Source unique de présentation = `export.ts` (zéro duplication).
 *
 * Visibilité = STRICTEMENT la règle du cockpit (`isCockpitVisible`) + borne basse
 * optionnelle. Une session est renvoyée si :
 *  - elle n'est PAS en étape "Échec" (`isEchecEtape` réutilisée — S10.1d) ; ET
 *  - BORNE HAUTE : `dateFin <= aujourd'hui Paris`, TOUJOURS appliquée → aucune
 *    session future. Recalculée à chaque requête (jamais codée en dur) : change
 *    seule chaque jour ; ET
 *  - `?finFrom=AAAA-MM-JJ` (S10.1b, optionnel) → borne basse. Combiné :
 *    `finFrom <= dateFin <= aujourd'hui`.
 * Filtres V2 (S11.2, optionnels, défaut = inactif → rétrocompatible) :
 *  - `?debutFrom=AAAA-MM-JJ` → ne garde que `dateDebut >= debutFrom` (symétrique de finFrom) ;
 *  - `?andpcOnly=1`          → ne garde que les sessions `financeurAndpc === true` ;
 *  - `?avecCompteProduit=1`  → ne garde que celles dont `numeroCompteProduit` est non vide
 *    (retire les formations sans audit type AFGSU).
 * Filtre « à cheval » (S16.1, optionnel, défaut = inactif → rétrocompatible) :
 *  - `?debutYear=AAAA`       → critère PRÉCIS et AUTO-SUFFISANT : `dateDebut` dans l'année
 *    `debutYear` ET `dateFin` dans `debutYear + 1`. `debutYear=2025` ne renvoie donc QUE
 *    les sessions 2025→2026 (exclut 2024→2025 et les sessions entièrement en 2025).
 *    C'est le SEUL activateur du mode cheval : il implique « à cheval » à lui seul.
 *  Ce mode NEUTRALISE `debutFrom` (une session à cheval commence l'année d'avant : une
 *  borne basse sur `dateDebut` calée sur l'année de fin les éliminerait toutes). Tous les
 *  AUTRES filtres passés continuent de s'appliquer normalement.
 * Colonnes de bloc (S18, optionnel, défaut = inactif → rétrocompatible) :
 *  - `?blocsCheval=1` → ajoute 3 colonnes EN FIN ("Amont+cœur signés", "Aval signés",
 *    "Facturable année N") pour l'onglet "Sessions à cheval 2026 - Auto". Ce flag ne
 *    FILTRE rien : il ne change que la PRÉSENTATION (en-têtes + lignes). Il est
 *    INDÉPENDANT de `debutYear` → l'onglet 25/26 figé (`debutYear=2025` sans le flag)
 *    reçoit exactement les mêmes 28 colonnes qu'avant S18.
 * Dates sur `dateFin`, jour Paris naïf `slice(0,10)`, jamais d'UTC.
 * Lignes triées par `dateFin` CROISSANTE (plus anciennes d'abord ; égalité →
 * `numeroComplet` pour un ordre déterministe).
 *
 * S10.2b — colonne "À relancer (noms)" EN DERNIÈRE position (après "Lien stockage",
 * donc sans décaler les colonnes du Sheet Ops). Elle vaut les noms des participants
 * ayant ≥1 attestation non signée sur CETTE session, dédupliqués par participant.
 * Coût quota : +1 requête `signatures` (~600 docs) par miss, mise en cache à part.
 *
 * SERVEUR uniquement (Admin SDK, même service account que le webhook). LECTURE
 * seule. Renvoie { headers, rows } — aucune donnée sensible, aucun secret loggé.
 *
 * Variables d'env (Vercel, jamais commitées / loggées) :
 *  - SHEET_EXPORT_TOKEN                                   (auth Bearer, bas-privilège)
 *  - FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY (Admin SDK)
 */
export const runtime = 'nodejs'; // firebase-admin + node:crypto → jamais Edge
export const dynamic = 'force-dynamic';

interface SheetPayload {
  headers: string[];
  rows: string[][];
}

/** Jour Paris naïf AAAA-MM-JJ (mêmes dates que `dateDebut/dateFin`, sans conversion UTC). */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Année AAAA (S16.1) — validée AVANT toute lecture Firestore, comme les dates. */
const YEAR_RE = /^\d{4}$/;

// Cache mémoire (module-level) ~60s, PAR CLÉ `${finFrom ?? 'all'}|${aujourdhuiParis}`.
// Voie la PLUS SIMPLE (pas de coopération du client, pas de header à respecter) :
// chaque refresh du Sheet ne déclenche au plus qu'UNE passe de lecture Firestore par
// minute, par instance chaude et PAR CLÉ → plafonne le quota (angle mort du doc §6).
// La clé inclut le filtre (un appel filtré ne sert jamais un cache non filtré) ET le
// jour Paris (au changement de jour, la borne haute bouge → clé neuve, jamais périmé).
// Limite assumée : un cold start repart d'un cache vide (relit une fois).
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; payload: SheetPayload }>();

// S10.2b — cache SÉPARÉ de la map des noms pending, sous sa PROPRE clé `pending|{jour}`.
// La liste pending est GLOBALE : elle ne dépend pas de `finFrom`. Deux appels avec des
// `finFrom` différents (2 entrées dans `cache`) partagent donc UNE seule lecture des
// signatures au lieu de la payer chacun. Même TTL 60s ; le jour dans la clé suit la
// même règle que le cache payload (jamais périmé au changement de jour).
const pendingCache = new Map<string, { at: number; byAdf: PendingByAdf }>();

/** Info pending d'un participant : son nom d'affichage + son financeur (S11.2). */
interface PendingInfo {
  nom: string;
  financeurAndpc: boolean | null; // true=ANDPC | false=autre (hors-DPC) | null=aucun financement
}
/** Pending par session, dédupliqué par participant : idAdf → (idParticipant → PendingInfo). */
type PendingByAdf = ReadonlyMap<string, ReadonlyMap<string, PendingInfo>>;

/** Filtres de visibilité (tous optionnels ; défauts rétrocompatibles). */
interface Filters {
  finFrom: string | null; // dateFin >= finFrom
  debutFrom: string | null; // dateDebut >= debutFrom (S11.2)
  andpcOnly: boolean; // financeurAndpc === true (S11.2)
  avecCompteProduit: boolean; // numeroCompteProduit non vide (S11.2)
  debutYear: string | null; // année(dateDebut) === debutYear ET année(dateFin) === +1 (S16.1)
  /**
   * S18 — `?blocsCheval=1` : ajoute 3 colonnes EN FIN (Amont+cœur signés / Aval signés /
   * Facturable année N) pour l'onglet "Sessions à cheval 2026 - Auto".
   * INDÉPENDANT de `debutYear` : l'onglet 25/26 FIGÉ (`debutYear=2025` SANS ce flag)
   * continue de recevoir EXACTEMENT les mêmes en-têtes et les mêmes lignes qu'avant.
   */
  blocsCheval: boolean;
}

/** Le mode « à cheval » est actif → `debutFrom` ne s'applique pas (S16.1). */
function isModeCheval(f: Filters): boolean {
  return f.debutYear !== null;
}

/**
 * S16.1 — Chevauchement STRICT d'une année vers la SUIVANTE : `dateDebut` dans l'année
 * `debutYear` ET `dateFin` dans `debutYear + 1`. À lui seul, ce critère IMPLIQUE « à
 * cheval », et il est strictement plus précis qu'un simple `aCheval === true` (qui
 * accepterait n'importe quel chevauchement — 2024→2025 comme 2025→2026).
 * Années lues sur le jour Paris naïf (`slice(0,4)`), JAMAIS en UTC, comme le reste.
 * debutYear=2025 → garde 2025→2026 ; exclut 2024→2025 ET 2025→2025 (même année).
 */
function estChevalVersAnneeSuivante(s: SessionDoc, debutYear: string): boolean {
  const finYear = String(Number(debutYear) + 1);
  return s.dateDebut.slice(0, 4) === debutYear && s.dateFin.slice(0, 4) === finYear;
}

function isFresh(entry: { at: number } | undefined, now: number): boolean {
  return entry !== undefined && now - entry.at <= CACHE_TTL_MS;
}

/**
 * UNE seule requête pour TOUS les noms à relancer : `where('status','==','pending')`.
 * - `select(...)` → 3 champs seulement (moins de bande passante ; Firestore facture de
 *   toute façon au document, pas au champ).
 * - PAS de `orderBy` : un `where` sur un champ unique se sert de l'index simple
 *   automatique. Ajouter `orderBy('sentDate')` exigerait l'index COMPOSITE de la vue
 *   « À relancer » — inutile ici, le tri des noms se fait en mémoire (`relanceNomsCell`).
 * - La `Map` interne est clé par `idParticipant` → elle DÉDUPLIQUE gratuitement : une
 *   personne avec 3 attestations pending (EPP amont/aval, PI) ne compte qu'UNE fois.
 */
async function readPendingByAdf(): Promise<PendingByAdf> {
  const snap = await getDb()
    .collection('signatures')
    .where('status', '==', 'pending')
    .select('idAdf', 'idParticipant', 'nom', 'financeurAndpc') // S11.2 : +financeurAndpc
    .get();
  const byAdf = new Map<string, Map<string, PendingInfo>>();
  for (const d of snap.docs) {
    const s = d.data();
    const idAdf = String(s.idAdf ?? '');
    const idParticipant = String(s.idParticipant ?? '');
    if (!idAdf || !idParticipant) continue; // non rattachable → ignoré (jamais de ligne fantôme)
    let parSession = byAdf.get(idAdf);
    if (!parSession) {
      parSession = new Map<string, PendingInfo>();
      byAdf.set(idAdf, parSession);
    }
    // tri-état préservé : true (ANDPC) | false (autre financeur) | null (aucun financement).
    const f = s.financeurAndpc;
    const financeurAndpc = f === true ? true : f === false ? false : null;
    parSession.set(idParticipant, { nom: String(s.nom ?? ''), financeurAndpc });
  }
  return byAdf;
}

async function getPendingByAdf(today: string, now: number): Promise<PendingByAdf> {
  const key = `pending|${today}`;
  const hit = pendingCache.get(key);
  if (isFresh(hit, now)) return hit!.byAdf;
  const byAdf = await readPendingByAdf();
  pendingCache.set(key, { at: now, byAdf });
  return byAdf;
}

/** Tri par `dateFin` CROISSANTE (jour Paris) ; égalité → `numeroComplet` (déterministe).
 *  `Array.prototype.sort` est stable (ES2019+). */
function byDateFinThenNumero(a: SessionDoc, b: SessionDoc): number {
  const fa = a.dateFin.slice(0, 10);
  const fb = b.dateFin.slice(0, 10);
  if (fa !== fb) return fa < fb ? -1 : 1;
  return a.numeroComplet < b.numeroComplet ? -1 : a.numeroComplet > b.numeroComplet ? 1 : 0;
}

/**
 * Lit TOUTES les sessions (lecture Firestore INCHANGÉE — aucun `where`, donc aucun
 * index requis), puis filtre + trie EN MÉMOIRE. Filtrer en mémoire est le plus simple
 * et le plus sûr : un `where('dateFin', …)` côté Firestore exigerait un index sur
 * `dateFin` (à déclarer/maintenir) sans gain réel — la lecture reste facturée au
 * document et le volume (2025–2026) tient en mémoire. Toutes les comparaisons se font
 * sur `dateFin.slice(0,10)` (Paris naïf, pas d'UTC). Bornes INCLUSES.
 */
async function buildPayload(filters: Filters, today: string, now: number): Promise<SheetPayload> {
  const snap = await getDb().collection('sessions').get();
  const sessions = snap.docs
    .map((d) => toSessionDoc(d.data()))
    .filter((s) => {
      if (isEchecEtape(s.etape)) return false; // hors "Échec" — même règle que isCockpitVisible
      const fin = s.dateFin.slice(0, 10);
      if (fin > today) return false; // borne haute = aujourd'hui Paris (TOUJOURS)
      if (filters.finFrom && fin < filters.finFrom) return false; // borne basse dateFin
      if (filters.debutYear && !estChevalVersAnneeSuivante(s, filters.debutYear)) return false; // année X → X+1 (S16.1)
      // S16.1 : `debutFrom` est NEUTRALISÉ en mode cheval — une session à cheval commence
      // l'année d'AVANT, donc une borne basse sur `dateDebut` (calée sur l'année de fin)
      // les éliminerait toutes.
      if (!isModeCheval(filters) && filters.debutFrom && s.dateDebut.slice(0, 10) < filters.debutFrom) return false; // borne basse dateDebut (S11.2)
      if (filters.andpcOnly && s.financeurAndpc !== true) return false; // ANDPC uniquement (S11.2)
      if (filters.avecCompteProduit && !(s.numeroCompteProduit && s.numeroCompteProduit.trim() !== '')) return false; // compte produit requis (S11.2)
      return true;
    })
    .sort(byDateFinThenNumero);

  // La map pending est GLOBALE (elle couvre aussi les sessions "Échec" et futures).
  // On la consulte donc UNIQUEMENT par l'`idAdf` des sessions RETENUES ci-dessus : une
  // session filtrée n'a pas de ligne, donc ses noms ne peuvent pas remonter (S10.2b §3).
  const pendingByAdf = await getPendingByAdf(today, now);
  const rows = sessions.map((s) => {
    // S11.2 : parmi les pending de la session, on RELANCE financeurAndpc true|null ;
    // les false (hors-DPC) sortent des noms et alimentent "Hors DPC (nb)".
    const parSession = pendingByAdf.get(s.idAdf);
    const noms: string[] = [];
    let horsDpc = 0;
    if (parSession) {
      for (const info of parSession.values()) {
        if (info.financeurAndpc === false) horsDpc += 1;
        else noms.push(info.nom); // true (ANDPC) ou null (aucun financement) → à relancer
      }
    }
    // S18 : le flag choisit le CONSTRUCTEUR DE LIGNE. Sans lui, c'est la fonction
    // d'origine, mot pour mot — aucun risque de dérive sur les onglets figés.
    return filters.blocsCheval
      ? sessionToSheetRowCheval2026(s, noms, horsDpc)
      : sessionToSheetRow(s, noms, horsDpc);
  });
  const headers = filters.blocsCheval ? SESSIONS_SHEET_HEADERS_CHEVAL2026 : SESSIONS_SHEET_HEADERS;
  return { headers: [...headers], rows };
}

export async function GET(req: Request): Promise<Response> {
  if (!isSheetExportAuthorized(req.headers.get('authorization'), process.env.SHEET_EXPORT_TOKEN)) {
    return json({ error: 'unauthorized' }, 401);
  }

  const params = new URL(req.url).searchParams;
  const finFrom = params.get('finFrom');
  const debutFrom = params.get('debutFrom');
  if (finFrom !== null && !DATE_RE.test(finFrom)) {
    return json({ error: 'invalid finFrom (attendu AAAA-MM-JJ)' }, 400); // ne lit pas Firestore
  }
  if (debutFrom !== null && !DATE_RE.test(debutFrom)) {
    return json({ error: 'invalid debutFrom (attendu AAAA-MM-JJ)' }, 400); // ne lit pas Firestore
  }
  const andpcOnly = params.get('andpcOnly') === '1';
  const avecCompteProduit = params.get('avecCompteProduit') === '1';
  const debutYear = params.get('debutYear'); // S16.1
  if (debutYear !== null && !YEAR_RE.test(debutYear)) {
    return json({ error: 'invalid debutYear (attendu AAAA)' }, 400); // ne lit pas Firestore
  }
  const blocsCheval = params.get('blocsCheval') === '1'; // S18 (même convention que andpcOnly)
  const filters: Filters = { finFrom, debutFrom, andpcOnly, avecCompteProduit, debutYear, blocsCheval };

  try {
    const today = todayInParis(); // recalculé chaque requête → jamais codé en dur
    // Clé de cache = TOUS les filtres + le jour : un appel filtré ne sert jamais un cache
    // d'un autre filtre, et le changement de jour (borne haute) invalide naturellement.
    // S18 : `blocsCheval` DOIT entrer dans la clé — il change la FORME de la payload
    // (28 vs 31 colonnes). Sans lui, un appel flaggé pourrait recevoir le payload caché
    // d'un appel non flaggé (et inversement) → colonnes manquantes dans le Sheet.
    const key = `${finFrom ?? 'all'}|${debutFrom ?? 'all'}|${andpcOnly ? '1' : '0'}|${avecCompteProduit ? '1' : '0'}|${debutYear ?? 'all'}|${blocsCheval ? '1' : '0'}|${today}`;
    const now = Date.now();
    const hit = cache.get(key);
    if (!isFresh(hit, now)) {
      cache.set(key, { at: now, payload: await buildPayload(filters, today, now) });
    }
    return json(cache.get(key)!.payload, 200);
  } catch {
    // Firestore KO → 500 clair, aucune donnée sensible propagée.
    return json({ error: 'export failed' }, 500);
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
