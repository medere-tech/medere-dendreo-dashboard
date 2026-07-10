import { getDb } from '@shared/firebase/admin';
import { toSessionDoc } from '@/lib/firestore/sessions';
import { SESSIONS_SHEET_HEADERS, sessionToSheetRow } from '@/lib/sessions/export';
import { isSheetExportAuthorized } from '@/lib/server/sheet-auth';

/**
 * Route de lecture `GET /api/export/sheet` (S10.1, Option C — cf.
 * docs/sprint-10-faisabilite-sheets.md). Expose les MÊMES lignes que l'export CSV
 * cockpit, en JSON, préfixées de `idAdf` (clé de correspondance), pour que l'Apps
 * Script (S10.2) mette à jour un Google Sheet EN PLACE sans écraser les colonnes
 * manuelles. Source unique de présentation = `export.ts` (zéro duplication).
 *
 * Filtre optionnel (S10.1b) : `?finFrom=AAAA-MM-JJ` → ne renvoie que les sessions
 * dont `dateFin >= finFrom`. Absent → toutes les sessions (rétrocompatible).
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

// Cache mémoire (module-level) ~60s, PAR VALEUR de `finFrom` (clé = finFrom ?? 'all').
// Voie la PLUS SIMPLE (pas de coopération du client, pas de header à respecter) :
// chaque refresh du Sheet ne déclenche au plus qu'UNE passe de lecture Firestore par
// minute, par instance chaude et PAR FILTRE → plafonne le quota (angle mort du doc §6).
// La clé par filtre évite qu'un appel filtré serve un cache non filtré (ou l'inverse).
// Limite assumée : un cold start repart d'un cache vide (relit une fois).
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; payload: SheetPayload }>();

/**
 * Lit TOUTES les sessions (lecture Firestore INCHANGÉE — aucun `where`, donc aucun
 * index requis), puis filtre EN MÉMOIRE sur `dateFin` si `finFrom` est fourni.
 * Filtrer en mémoire est le plus simple et le plus sûr : un `where('dateFin','>=')`
 * côté Firestore exigerait un index sur `dateFin` (à déclarer/maintenir) sans gain
 * réel — la lecture reste facturée au document et le volume (2025–2026) tient en
 * mémoire. La comparaison se fait sur `dateFin.slice(0,10)` (Paris naïf, pas d'UTC).
 */
async function buildPayload(finFrom: string | null): Promise<SheetPayload> {
  const snap = await getDb().collection('sessions').get();
  let sessions = snap.docs.map((d) => toSessionDoc(d.data()));
  if (finFrom) {
    sessions = sessions.filter((s) => s.dateFin.slice(0, 10) >= finFrom); // borne incluse (>=)
  }
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
    const key = finFrom ?? 'all';
    const now = Date.now();
    const hit = cache.get(key);
    if (!hit || now - hit.at > CACHE_TTL_MS) {
      cache.set(key, { at: now, payload: await buildPayload(finFrom) });
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
