import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SESSIONS_CSV_HEADERS } from '@/lib/sessions/export';
import { sessionToCsvRow } from '@/lib/sessions/export';
import { toSessionDoc } from '@/lib/firestore/sessions';

// Mock de l'Admin SDK → aucun I/O Firestore. `getMock` est hoisté et STABLE entre
// resetModules : on peut compter les lectures réelles (test du cache).
const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));
vi.mock('@shared/firebase/admin', () => ({
  getDb: () => ({ collection: () => ({ get: getMock }) }),
}));

const TOKEN = 'sheet-token-xyz';

// Un doc Firestore BRUT (forme miroir) : toSessionDoc le normalise.
const RAW_SESSION = {
  idAdf: '2691', numeroComplet: 'ADF_2691', numeroSessionDpc: '26.042', numeroCompteProduit: '92622525478',
  intitule: 'Prévention des risques', dateDebut: '2026-01-09T00:00:00', dateFin: '2026-02-20T23:59:59',
  idEtapeProcess: '6', etape: 'Réalisation', idCentre: '1', type: 'inter', totalParticipants: 4,
  format: 'Mixte', aCheval: false, eppAmontConnecte: true, eppAvalConnecte: false, eligibleDpc: true, aEpp: true,
  counts: { envoyes: 3, signes: 1, nonSignes: 2, participantsConcernes: 3, participantsARelancer: 2 },
  oldestPendingSentDate: null, lastSyncedAt: '2026-07-09T10:00:00.000Z', source: 'dendreo',
};

const req = (auth?: string, query = ''): Request =>
  new Request(`https://app/api/export/sheet${query}`, { headers: auth ? { authorization: auth } : {} });

/** Doc brut dérivé de RAW_SESSION avec un `idAdf` + `dateFin` donnés (tests filtre). */
const rawWith = (idAdf: string, dateFin: string) => ({ ...RAW_SESSION, idAdf, dateFin });
const asDocs = (raws: object[]) => ({ docs: raws.map((r) => ({ data: () => r })) });

/** Ré-importe la route AVEC un cache module-level vierge (resetModules). */
async function freshRoute() {
  vi.resetModules();
  return (await import('./route')).GET;
}

describe('GET /api/export/sheet', () => {
  beforeEach(() => {
    getMock.mockReset();
    getMock.mockResolvedValue({ docs: [{ data: () => RAW_SESSION }] });
    process.env.SHEET_EXPORT_TOKEN = TOKEN;
  });

  it('sans header Authorization → 401, aucune lecture Firestore', async () => {
    const GET = await freshRoute();
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(getMock).not.toHaveBeenCalled();
  });

  it('token invalide → 401, aucune lecture Firestore', async () => {
    const GET = await freshRoute();
    const res = await GET(req('Bearer mauvais-token'));
    expect(res.status).toBe(401);
    expect(getMock).not.toHaveBeenCalled();
  });

  it('token valide → 200 + { headers, rows }', async () => {
    const GET = await freshRoute();
    const res = await GET(req(`Bearer ${TOKEN}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.headers[0]).toBe('idAdf');
    expect(Array.isArray(body.rows)).toBe(true);
    expect(body.rows).toHaveLength(1);
  });

  it('idAdf en 1re colonne ; colonnes suivantes == EXACTEMENT l\'export CSV (réutilisation prouvée)', async () => {
    const GET = await freshRoute();
    const body = await (await GET(req(`Bearer ${TOKEN}`))).json();
    // entêtes = 'idAdf' + les entêtes CSV
    expect(body.headers).toEqual(['idAdf', ...SESSIONS_CSV_HEADERS]);
    const row = body.rows[0];
    expect(row[0]).toBe('2691'); // clé de correspondance
    // tout après idAdf == la ligne CSV normalisée telle quelle
    expect(row.slice(1)).toEqual(sessionToCsvRow(toSessionDoc(RAW_SESSION)));
  });

  it('cache ~60s : 2 appels rapprochés → UNE seule lecture Firestore', async () => {
    const GET = await freshRoute();
    await GET(req(`Bearer ${TOKEN}`));
    await GET(req(`Bearer ${TOKEN}`));
    expect(getMock).toHaveBeenCalledTimes(1); // 2e appel servi par le cache
  });

  it('Firestore KO → 500 clair', async () => {
    getMock.mockRejectedValueOnce(new Error('firestore down'));
    const GET = await freshRoute();
    const res = await GET(req(`Bearer ${TOKEN}`));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'export failed' });
  });
});

describe('GET /api/export/sheet — filtre ?finFrom', () => {
  // 3 sessions : avant / pile sur la borne / après le 2026-06-01.
  const AVANT = rawWith('avant', '2026-02-20T23:59:59');
  const BORNE = rawWith('borne', '2026-06-01T00:00:00'); // == finFrom → INCLUS
  const APRES = rawWith('apres', '2026-08-15T10:00:00');

  beforeEach(() => {
    getMock.mockReset();
    getMock.mockResolvedValue(asDocs([AVANT, BORNE, APRES]));
    process.env.SHEET_EXPORT_TOKEN = TOKEN;
  });

  const ids = (body: { rows: string[][] }) => body.rows.map((r) => r[0]);

  it('sans finFrom → toutes les sessions (rétrocompatible)', async () => {
    const GET = await freshRoute();
    const body = await (await GET(req(`Bearer ${TOKEN}`))).json();
    expect(ids(body)).toEqual(['avant', 'borne', 'apres']);
  });

  it('finFrom=2026-06-01 → seulement dateFin >= borne (borne INCLUSE)', async () => {
    const GET = await freshRoute();
    const body = await (await GET(req(`Bearer ${TOKEN}`, '?finFrom=2026-06-01'))).json();
    expect(ids(body)).toEqual(['borne', 'apres']); // 'avant' exclu, 'borne' inclus (>=)
  });

  it('format finFrom invalide → 400, ne lit PAS Firestore', async () => {
    const GET = await freshRoute();
    for (const bad of ['2026-6-1', '01/06/2026', '2026-06', 'hier', '']) {
      const res = await GET(req(`Bearer ${TOKEN}`, `?finFrom=${encodeURIComponent(bad)}`));
      expect(res.status).toBe(400);
    }
    expect(getMock).not.toHaveBeenCalled();
  });

  it('cache PAR VALEUR de finFrom : 2 valeurs distinctes → 2 lectures ; répétition → cache', async () => {
    const GET = await freshRoute();
    await GET(req(`Bearer ${TOKEN}`)); // clé 'all'
    await GET(req(`Bearer ${TOKEN}`, '?finFrom=2026-06-01')); // clé '2026-06-01'
    expect(getMock).toHaveBeenCalledTimes(2); // 2 entrées de cache distinctes
    await GET(req(`Bearer ${TOKEN}`)); // 'all' re-servi par le cache
    await GET(req(`Bearer ${TOKEN}`, '?finFrom=2026-06-01')); // idem
    expect(getMock).toHaveBeenCalledTimes(2); // toujours 2 : aucune relecture
  });
});
