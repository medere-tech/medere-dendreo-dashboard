import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CHEVAL_SHEET_HEADERS } from '@/lib/sessions/export';
import { EMPTY_DISPLAY } from '@/lib/format';

// Mock Admin SDK → aucun I/O Firestore. `sessions` (.get) et `signatures`
// (.where().select().get()) mockés séparément ; whereSpy prouve le filtre pending.
const { getMock, pendingGetMock, whereSpy, selectSpy } = vi.hoisted(() => ({
  getMock: vi.fn(),
  pendingGetMock: vi.fn(),
  whereSpy: vi.fn(),
  selectSpy: vi.fn(),
}));
vi.mock('@shared/firebase/admin', () => ({
  getDb: () => ({
    collection: (name: string) =>
      name === 'signatures'
        ? {
            where: (...args: unknown[]) => {
              whereSpy(...args);
              return {
                select: (...fields: unknown[]) => {
                  selectSpy(...fields);
                  return { get: pendingGetMock };
                },
              };
            },
          }
        : { get: getMock },
  }),
}));

const TOKEN = 'sheet-token-xyz';

/** Doc session BRUT (forme miroir) : toSessionDoc le normalise. */
const rawSession = (idAdf: string, over: Record<string, unknown> = {}) => ({
  idAdf, numeroComplet: `ADF_${idAdf}`, numeroSessionDpc: '26.001', numeroCompteProduit: '92622525478',
  intitule: 'Prévention des risques', dateDebut: '2025-11-10T00:00:00', dateFin: '2026-02-20T23:59:59',
  format: 'Mixte', aEpp: true, eppAmontConnecte: true, eppAvalConnecte: false,
  idEtapeProcess: '6', etape: 'Réalisation', source: 'dendreo',
  ...over,
});
const asDocs = (raws: object[]) => ({ docs: raws.map((r) => ({ data: () => r })) });
const pending = (idAdf: string, idParticipant: string, nom: string, commercial?: string | null) => ({
  idAdf, idParticipant, nom, ...(commercial === undefined ? {} : { commercial }),
});

const req = (auth?: string, query = ''): Request =>
  new Request(`https://app/api/export/sheet-cheval${query}`, { headers: auth ? { authorization: auth } : {} });

async function freshRoute() {
  vi.resetModules();
  return (await import('./route')).GET;
}

beforeEach(() => {
  getMock.mockReset();
  pendingGetMock.mockReset();
  whereSpy.mockReset();
  selectSpy.mockReset();
  process.env.SHEET_EXPORT_TOKEN = TOKEN;
});

describe('GET /api/export/sheet-cheval — auth & paramètre', () => {
  it('sans header Authorization → 401, aucune lecture Firestore', async () => {
    const GET = await freshRoute();
    const res = await GET(req(undefined, '?idAdfs=3196'));
    expect(res.status).toBe(401);
    expect(getMock).not.toHaveBeenCalled();
    expect(pendingGetMock).not.toHaveBeenCalled();
  });

  it('token invalide → 401', async () => {
    const GET = await freshRoute();
    expect((await GET(req('Bearer mauvais', '?idAdfs=3196'))).status).toBe(401);
  });

  it('idAdfs absent → 400, aucune lecture Firestore', async () => {
    const GET = await freshRoute();
    const res = await GET(req(`Bearer ${TOKEN}`)); // pas de query
    expect(res.status).toBe(400);
    expect(getMock).not.toHaveBeenCalled();
    expect(pendingGetMock).not.toHaveBeenCalled();
  });

  it('idAdfs vide / non numérique → 400', async () => {
    const GET = await freshRoute();
    expect((await GET(req(`Bearer ${TOKEN}`, '?idAdfs='))).status).toBe(400);
    expect((await GET(req(`Bearer ${TOKEN}`, '?idAdfs=abc,,'))).status).toBe(400);
  });
});

describe('GET /api/export/sheet-cheval — contenu', () => {
  it('en-têtes = ordre EXACT des colonnes cheval, sans doublon', async () => {
    getMock.mockResolvedValue(asDocs([rawSession('3196')]));
    pendingGetMock.mockResolvedValue(asDocs([pending('3196', 'p1', 'Alice DUPONT', 'Guercif Kaoufer')]));
    const GET = await freshRoute();
    const body = await (await GET(req(`Bearer ${TOKEN}`, '?idAdfs=3196'))).json();
    expect(body.headers).toEqual([
      'idAdf', 'Intitulé', 'N° CP', 'N° session', 'Format', 'Début', 'Fin', 'EPP', 'Nom', 'Commercial', 'Commentaires',
    ]);
    expect(body.headers).toEqual([...CHEVAL_SHEET_HEADERS]);
    expect(new Set(body.headers).size).toBe(body.headers.length); // aucun en-tête dupliqué
  });

  it('lit UNIQUEMENT les attestations pending (where status==pending)', async () => {
    getMock.mockResolvedValue(asDocs([rawSession('3196')]));
    pendingGetMock.mockResolvedValue(asDocs([]));
    const GET = await freshRoute();
    await GET(req(`Bearer ${TOKEN}`, '?idAdfs=3196'));
    expect(whereSpy).toHaveBeenCalledWith('status', '==', 'pending');
    expect(selectSpy).toHaveBeenCalledWith('idAdf', 'idParticipant', 'nom', 'commercial');
  });

  it('2 sessions → 1 ligne PAR PERSONNE pending, triées par idAdf puis Nom', async () => {
    getMock.mockResolvedValue(asDocs([rawSession('3196', { intitule: 'AFGSU' }), rawSession('3117', { intitule: 'PRAP' })]));
    pendingGetMock.mockResolvedValue(asDocs([
      pending('3117', 'p3', 'Bruno CARON', 'Sophie L'),
      pending('3196', 'p2', 'Zoé MARTIN', null),
      pending('3196', 'p1', 'Alice DUPONT', 'Guercif Kaoufer'),
      pending('3117', 'p4', 'Ana BER', 'Jordan M'),
    ]));
    const GET = await freshRoute();
    const body = await (await GET(req(`Bearer ${TOKEN}`, '?idAdfs=3117,3196'))).json();
    // idAdf trié numériquement (3117 avant 3196), puis Nom fr
    expect(body.rows.map((r: string[]) => [r[0], r[8]])).toEqual([
      ['3117', 'Ana BER'], ['3117', 'Bruno CARON'], // 3117 d'abord
      ['3196', 'Alice DUPONT'], ['3196', 'Zoé MARTIN'],
    ]);
    // colonnes d'une ligne : Intitulé, N° CP, Format, EPP (CO/NC), Nom, Commercial, Commentaires
    const alice = body.rows.find((r: string[]) => r[8] === 'Alice DUPONT');
    expect(alice).toEqual(['3196', 'AFGSU', '92622525478', '26.001', 'Mixte', '10/11/25', '20/02/26', 'CO/NC', 'Alice DUPONT', 'Guercif Kaoufer', '']);
  });

  it('personne pending sans commercial → "Commercial" = "-"', async () => {
    getMock.mockResolvedValue(asDocs([rawSession('3196')]));
    pendingGetMock.mockResolvedValue(asDocs([
      pending('3196', 'p2', 'Zoé MARTIN', null),
      pending('3196', 'p5', 'Yves NUL'), // champ commercial absent → "-"
    ]));
    const GET = await freshRoute();
    const body = await (await GET(req(`Bearer ${TOKEN}`, '?idAdfs=3196'))).json();
    for (const r of body.rows) expect(r[9]).toBe(EMPTY_DISPLAY); // "-"
  });

  it('"Commentaires" TOUJOURS vide (colonne manuelle, jamais écrasée)', async () => {
    getMock.mockResolvedValue(asDocs([rawSession('3196')]));
    pendingGetMock.mockResolvedValue(asDocs([pending('3196', 'p1', 'Alice DUPONT', 'X Y')]));
    const GET = await freshRoute();
    const body = await (await GET(req(`Bearer ${TOKEN}`, '?idAdfs=3196'))).json();
    for (const r of body.rows) expect(r.at(-1)).toBe(''); // dernière colonne = Commentaires
  });

  it('1 personne = 1 ligne même avec plusieurs attestations pending (dédup par participant)', async () => {
    getMock.mockResolvedValue(asDocs([rawSession('3196')]));
    pendingGetMock.mockResolvedValue(asDocs([
      pending('3196', 'p1', 'Alice DUPONT', 'X Y'), // EPP amont
      pending('3196', 'p1', 'Alice DUPONT', 'X Y'), // EPP aval (même personne)
    ]));
    const GET = await freshRoute();
    const body = await (await GET(req(`Bearer ${TOKEN}`, '?idAdfs=3196'))).json();
    expect(body.rows).toHaveLength(1);
  });

  it('idAdfs dupliqués → dédupliqués ; session absente du miroir → pas de ligne', async () => {
    getMock.mockResolvedValue(asDocs([rawSession('3196')])); // 9999 absent du miroir
    pendingGetMock.mockResolvedValue(asDocs([pending('3196', 'p1', 'Alice DUPONT', 'X Y')]));
    const GET = await freshRoute();
    const body = await (await GET(req(`Bearer ${TOKEN}`, '?idAdfs=3196,3196,9999'))).json();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0][0]).toBe('3196');
  });

  it('cache 60s par clé : 2e appel même idAdfs ne relit pas Firestore', async () => {
    getMock.mockResolvedValue(asDocs([rawSession('3196')]));
    pendingGetMock.mockResolvedValue(asDocs([pending('3196', 'p1', 'Alice DUPONT', 'X Y')]));
    const GET = await freshRoute();
    await GET(req(`Bearer ${TOKEN}`, '?idAdfs=3196'));
    await GET(req(`Bearer ${TOKEN}`, '?idAdfs=3196'));
    expect(getMock).toHaveBeenCalledTimes(1); // 2e servi par le cache
    expect(pendingGetMock).toHaveBeenCalledTimes(1);
  });
});
