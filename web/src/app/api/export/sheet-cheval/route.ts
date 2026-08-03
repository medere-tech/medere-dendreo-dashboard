import { getDb } from '@shared/firebase/admin';
import { toSessionDoc, type SessionDoc } from '@/lib/firestore/sessions';
import { CHEVAL_SHEET_HEADERS, chevalPersonRow } from '@/lib/sessions/export';
import { isSheetExportAuthorized } from '@/lib/server/sheet-auth';

/**
 * Route `GET /api/export/sheet-cheval` (S13.2) — onglet "À cheval 25/26".
 * UNE LIGNE PAR PERSONNE non signée (attestation `status==pending`) des sessions
 * demandées, avec les colonnes du CSV de Loane. Même auth Bearer que
 * `/api/export/sheet` (SHEET_EXPORT_TOKEN). Source de présentation UNIQUE = `export.ts`.
 *
 * Paramètre REQUIS : `?idAdfs=3196,3117,...` (liste d'idAdf numériques, virgules).
 *  - absent/vide/aucun id numérique valide → 400 (ne lit pas Firestore) ;
 *  - doublons ignorés ; l'ordre de sortie est trié par idAdf (numérique) puis Nom (fr).
 *
 * Lecture Firestore SEULE (aucun appel Dendreo) : `signature.nom` et
 * `signature.commercial` sont déjà au miroir (S13.1). "Commentaires" est une colonne
 * MANUELLE (toujours "" ici, protégée côté Apps Script).
 *
 * SERVEUR uniquement (Admin SDK). Renvoie { headers, rows }. Cache mémoire 60s par clé
 * (les idAdf triés). Env : SHEET_EXPORT_TOKEN + Admin SDK (comme la route sœur).
 */
export const runtime = 'nodejs'; // firebase-admin → jamais Edge
export const dynamic = 'force-dynamic';

interface SheetPayload {
  headers: string[];
  rows: string[][];
}

/** Une personne PENDING (dédupliquée par participant) : nom + commercial (miroir). */
interface PendingPerson {
  nom: string;
  commercial: string | null;
}
/** Pending par session : idAdf → (idParticipant → PendingPerson). */
type PendingByAdf = ReadonlyMap<string, ReadonlyMap<string, PendingPerson>>;

// Cache mémoire (module-level) ~60s, PAR CLÉ = les idAdf triés joints. Chaque refresh
// du Sheet ne déclenche au plus qu'UNE passe de lecture Firestore par minute et par
// combinaison d'idAdf (par instance chaude). Cold start → cache vide (relit une fois).
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; payload: SheetPayload }>();

function isFresh(entry: { at: number } | undefined, now: number): boolean {
  return entry !== undefined && now - entry.at <= CACHE_TTL_MS;
}

/** true|false|null défensif (doc pré-S14 : champ absent → null, JAMAIS false). */
const asTriBool = (v: unknown): boolean | null => (v === true ? true : v === false ? false : null);

/**
 * S14 — une personne pending n'apparaît dans l'onglet que si elle est utile à relancer :
 *  - `assidu === true`  : a suivi la formation (laps.presence 'OUI'). Exclut 'INC.'
 *    (commencé, pas fini) et 'NON' (no-show) ;
 *  - `inscrit === true` : rattachée à ≥1 module. Exclut le DÉSINSCRIT (first_lam vide) ;
 *  - `financeurAndpc !== false` : exclut l'autofinancé / hors-DPC. `null` (aucun
 *    financement rattaché) est CONSERVÉ — on ne supprime pas une ligne sur une absence
 *    d'information (même règle qu'en S11.1).
 * `assidu`/`inscrit` sont STRICTS : `null` (inconnu, ou doc écrit avant S14) exclut.
 * ⚠ Conséquence opérationnelle : tant que le backfill S14 n'est pas repassé, aucun doc
 * ne porte ces champs → l'onglet sort VIDE. C'est voulu (mieux vide que faux).
 */
function estARelancer(s: Record<string, unknown>): boolean {
  return asTriBool(s.assidu) === true && asTriBool(s.inscrit) === true && asTriBool(s.financeurAndpc) !== false;
}

/**
 * Toutes les attestations PENDING → Map<idAdf, Map<idParticipant, PendingPerson>>.
 * `where('status','==','pending')` (index simple auto, pas d'orderBy). La Map interne
 * est clé par `idParticipant` → DÉDUPLIQUE : une personne avec plusieurs attestations
 * pending (EPP amont/aval, PI) ne donne qu'UNE ligne. `commercial` vide → null.
 * Filtre S14 appliqué AVANT l'insertion (cf. `estARelancer`).
 */
async function readPendingByAdf(): Promise<PendingByAdf> {
  const snap = await getDb()
    .collection('signatures')
    .where('status', '==', 'pending')
    .select('idAdf', 'idParticipant', 'nom', 'commercial', 'assidu', 'inscrit', 'financeurAndpc') // S13.1 +S14
    .get();
  const byAdf = new Map<string, Map<string, PendingPerson>>();
  for (const d of snap.docs) {
    const s = d.data();
    const idAdf = String(s.idAdf ?? '');
    const idParticipant = String(s.idParticipant ?? '');
    if (!idAdf || !idParticipant) continue; // non rattachable → ignoré (jamais de ligne fantôme)
    if (!estARelancer(s)) continue; // S14 : pas fini / no-show / désinscrit / hors-DPC
    let parSession = byAdf.get(idAdf);
    if (!parSession) {
      parSession = new Map<string, PendingPerson>();
      byAdf.set(idAdf, parSession);
    }
    const commercial = typeof s.commercial === 'string' && s.commercial.trim() !== '' ? s.commercial : null;
    parSession.set(idParticipant, { nom: String(s.nom ?? ''), commercial });
  }
  return byAdf;
}

/** Sessions demandées (parmi TOUTES les sessions du miroir) → Map<idAdf, SessionDoc>. */
async function readSessionsById(wanted: ReadonlySet<string>): Promise<Map<string, SessionDoc>> {
  const snap = await getDb().collection('sessions').get();
  const map = new Map<string, SessionDoc>();
  for (const d of snap.docs) {
    const s = toSessionDoc(d.data());
    if (wanted.has(s.idAdf)) map.set(s.idAdf, s);
  }
  return map;
}

async function buildPayload(idAdfs: readonly string[]): Promise<SheetPayload> {
  const wanted = new Set(idAdfs);
  const [sessions, pendingByAdf] = await Promise.all([readSessionsById(wanted), readPendingByAdf()]);

  const rows: string[][] = [];
  for (const idAdf of idAdfs) {
    // idAdfs est DÉJÀ trié (numérique) → tri des lignes par idAdf garanti.
    const session = sessions.get(idAdf);
    const parSession = pendingByAdf.get(idAdf);
    if (!session || !parSession) continue; // session absente du miroir ou aucun pending → aucune ligne
    const people = [...parSession.values()].sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
    for (const p of people) rows.push(chevalPersonRow(session, p.nom, p.commercial));
  }
  return { headers: [...CHEVAL_SHEET_HEADERS], rows };
}

/** Parse `?idAdfs=` : numériques uniquement, dédupliqués, triés numériquement. */
function parseIdAdfs(raw: string | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const t = part.trim();
    if (/^\d+$/.test(t)) seen.add(t);
  }
  return [...seen].sort((a, b) => Number(a) - Number(b));
}

export async function GET(req: Request): Promise<Response> {
  if (!isSheetExportAuthorized(req.headers.get('authorization'), process.env.SHEET_EXPORT_TOKEN)) {
    return json({ error: 'unauthorized' }, 401);
  }

  const idAdfs = parseIdAdfs(new URL(req.url).searchParams.get('idAdfs'));
  if (idAdfs.length === 0) {
    return json({ error: 'idAdfs requis (liste d\'idAdf numériques séparés par des virgules)' }, 400); // ne lit pas Firestore
  }

  try {
    const key = idAdfs.join(','); // clé de cache = les idAdf triés
    const now = Date.now();
    const hit = cache.get(key);
    if (!isFresh(hit, now)) {
      cache.set(key, { at: now, payload: await buildPayload(idAdfs) });
    }
    return json(cache.get(key)!.payload, 200);
  } catch {
    return json({ error: 'export failed' }, 500); // Firestore KO → 500, rien de sensible
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
