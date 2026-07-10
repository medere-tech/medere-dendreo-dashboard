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

// Cache mémoire (module-level) ~60s. Voie la PLUS SIMPLE (pas de coopération du
// client, pas de header à respecter) : chaque refresh du Sheet ne déclenche au plus
// qu'UNE passe de lecture Firestore par minute et par instance chaude → plafonne le
// quota (angle mort du doc §6). Limite assumée : un cold start repart d'un cache
// vide (relit une fois) ; acceptable pour un usage manuel/horaire.
const CACHE_TTL_MS = 60_000;
let cache: { at: number; payload: SheetPayload } | null = null;

/** Lit TOUTES les sessions (aucun filtre : le Sheet gère l'affichage) et mappe via
 *  la variante "sheet" de export.ts. */
async function buildPayload(): Promise<SheetPayload> {
  const snap = await getDb().collection('sessions').get();
  const rows = snap.docs.map((d) => sessionToSheetRow(toSessionDoc(d.data())));
  return { headers: [...SESSIONS_SHEET_HEADERS], rows };
}

export async function GET(req: Request): Promise<Response> {
  if (!isSheetExportAuthorized(req.headers.get('authorization'), process.env.SHEET_EXPORT_TOKEN)) {
    return json({ error: 'unauthorized' }, 401);
  }
  try {
    const now = Date.now();
    if (!cache || now - cache.at > CACHE_TTL_MS) {
      cache = { at: now, payload: await buildPayload() };
    }
    return json(cache.payload, 200);
  } catch {
    // Firestore KO → 500 clair, aucune donnée sensible propagée.
    return json({ error: 'export failed' }, 500);
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
