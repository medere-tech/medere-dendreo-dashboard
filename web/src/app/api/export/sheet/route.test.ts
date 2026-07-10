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

const req = (auth?: string): Request =>
  new Request('https://app/api/export/sheet', { headers: auth ? { authorization: auth } : {} });

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
