import { getDb } from '@shared/firebase/admin';
import { toSessionDoc, type SessionDoc } from '@/lib/firestore/sessions';
import { SESSIONS_SHEET_HEADERS, sessionToSheetRow } from '@/lib/sessions/export';
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
 * Dates sur `dateFin`, jour Paris naïf `slice(0,10)`, jamais d'UTC.
 * Lignes triées par `dateFin` CROISSANTE (plus anciennes d'abord ; égalité →
 * `numeroComplet` pour un ordre déterministe).
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

// Cache mémoire (module-level) ~60s, PAR CLÉ `${finFrom ?? 'all'}|${aujourdhuiParis}`.
// Voie la PLUS SIMPLE (pas de coopération du client, pas de header à respecter) :
// chaque refresh du Sheet ne déclenche au plus qu'UNE passe de lecture Firestore par
// minute, par instance chaude et PAR CLÉ → plafonne le quota (angle mort du doc §6).
// La clé inclut le filtre (un appel filtré ne sert jamais un cache non filtré) ET le
// jour Paris (au changement de jour, la borne haute bouge → clé neuve, jamais périmé).
// Limite assumée : un cold start repart d'un cache vide (relit une fois).
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; payload: SheetPayload }>();

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
async function buildPayload(finFrom: string | null, today: string): Promise<SheetPayload> {
  const snap = await getDb().collection('sessions').get();
  const sessions = snap.docs
    .map((d) => toSessionDoc(d.data()))
    .filter((s) => {
      if (isEchecEtape(s.etape)) return false; // hors "Échec" — même règle que isCockpitVisible
      const fin = s.dateFin.slice(0, 10);
      if (fin > today) return false; // borne haute = aujourd'hui Paris (TOUJOURS)
      if (finFrom && fin < finFrom) return false; // borne basse optionnelle
      return true;
    })
    .sort(byDateFinThenNumero);
  return { headers: [...SESSIONS_SHEET_HEADERS], rows: sessions.map(sessionToSheetRow) };
}

export async function GET(req: Request): Promise<Response> {
  if (!isSheetExportAuthorized(req.headers.get('authorization'), process.env.SHEET_EXPORT_TOKEN)) {
    return json({ error: 'unauthorized' }, 401);
  }

  const finFrom = new URL(req.url).searchParams.get('finFrom');
  if (finFrom !== null && !DATE_RE.test(finFrom)) {
    return json({ error: 'invalid finFrom (attendu AAAA-MM-JJ)' }, 400); // ne lit pas Firestore
  }

  try {
    const today = todayInParis(); // recalculé chaque requête → jamais codé en dur
    const key = `${finFrom ?? 'all'}|${today}`;
    const now = Date.now();
    const hit = cache.get(key);
    if (!hit || now - hit.at > CACHE_TTL_MS) {
      cache.set(key, { at: now, payload: await buildPayload(finFrom, today) });
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
