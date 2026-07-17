import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SESSIONS_CSV_HEADERS } from '@/lib/sessions/export';
import { sessionToCsvRow } from '@/lib/sessions/export';
import { toSessionDoc } from '@/lib/firestore/sessions';
import { EMPTY_DISPLAY } from '@/lib/format';
import { todayInParis } from '@/lib/time';

// Mock de l'Admin SDK → aucun I/O Firestore. Les mocks sont hoistés et STABLES entre
// resetModules : on peut compter les lectures réelles (test des caches).
// UN mock par collection : `sessions` (.get) et `signatures` (.where().select().get()),
// pour compter séparément les deux lectures et prouver le cache pending dédié.
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

/** Docs signature pending BRUTS (forme miroir, champs `select`és). */
const asPending = (raws: object[]) => ({ docs: raws.map((r) => ({ data: () => r })) });
const pending = (idAdf: string, idParticipant: string, nom: string) => ({ idAdf, idParticipant, nom });

// « Aujourd'hui Paris » INJECTABLE (déterministe) : on ne mocke QUE todayInParis,
// le reste de @/lib/time (parisDayOfInstant…) garde son implémentation réelle.
vi.mock('@/lib/time', async (orig) => ({
  ...(await orig<typeof import('@/lib/time')>()),
  todayInParis: vi.fn(),
}));
const setToday = (day: string) => vi.mocked(todayInParis).mockReturnValue(day);

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

// Par défaut « aujourd'hui » très loin dans le futur → la borne haute n'exclut RIEN
// dans les tests qui ne s'y intéressent pas (auth, réutilisation CSV, finFrom…).
// Par défaut AUCUN pending : les tests qui ne parlent pas des noms voient "-".
beforeEach(() => {
  setToday('2999-12-31');
  pendingGetMock.mockReset();
  pendingGetMock.mockResolvedValue(asPending([]));
  whereSpy.mockReset();
  selectSpy.mockReset();
});

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
    expect(pendingGetMock).not.toHaveBeenCalled(); // ni sessions, ni signatures
  });

  it('token invalide → 401, aucune lecture Firestore', async () => {
    const GET = await freshRoute();
    const res = await GET(req('Bearer mauvais-token'));
    expect(res.status).toBe(401);
    expect(getMock).not.toHaveBeenCalled();
    expect(pendingGetMock).not.toHaveBeenCalled();
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

  it('idAdf en 1re colonne ; colonnes du milieu == EXACTEMENT l\'export CSV (réutilisation prouvée)', async () => {
    const GET = await freshRoute();
    const body = await (await GET(req(`Bearer ${TOKEN}`))).json();
    // entêtes = 'idAdf' + les entêtes CSV + la colonne noms EN DERNIER
    expect(body.headers).toEqual(['idAdf', ...SESSIONS_CSV_HEADERS, 'À relancer (noms)']);
    const row = body.rows[0];
    expect(row[0]).toBe('2691'); // clé de correspondance
    // entre idAdf et les noms == la ligne CSV normalisée telle quelle
    expect(row.slice(1, -1)).toEqual(sessionToCsvRow(toSessionDoc(RAW_SESSION)));
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
    expect(pendingGetMock).not.toHaveBeenCalled();
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

describe('GET /api/export/sheet — borne haute (aujourd\'hui Paris) + tri', () => {
  const TODAY = '2026-07-10'; // « aujourd'hui » injecté (déterministe)
  const PASSEE = rawWith('passee', '2026-02-20T23:59:59'); // < aujourd'hui → inclus
  const AUJH = rawWith('aujh', '2026-07-10T09:00:00'); // == aujourd'hui → inclus (<=)
  const FUTURE = rawWith('future', '2026-09-01T00:00:00'); // > aujourd'hui → EXCLU

  beforeEach(() => {
    getMock.mockReset();
    getMock.mockResolvedValue(asDocs([FUTURE, PASSEE, AUJH])); // ordre volontairement mélangé
    process.env.SHEET_EXPORT_TOKEN = TOKEN;
    setToday(TODAY);
  });

  const ids = (body: { rows: string[][] }) => body.rows.map((r) => r[0]);

  it('exclut le futur, inclut aujourd\'hui et le passé, et TRIE par dateFin croissante', async () => {
    const GET = await freshRoute();
    const body = await (await GET(req(`Bearer ${TOKEN}`))).json();
    // 'future' exclue (borne haute) ; 'passee' puis 'aujh' (dateFin croissante)
    expect(ids(body)).toEqual(['passee', 'aujh']);
  });

  it('égalité de dateFin → ordre secondaire déterministe par numeroComplet', async () => {
    const A = { ...rawWith('a', '2026-05-10T00:00:00'), numeroComplet: 'ADF_200' };
    const B = { ...rawWith('b', '2026-05-10T00:00:00'), numeroComplet: 'ADF_100' };
    getMock.mockResolvedValue(asDocs([A, B])); // même dateFin, numeroComplet dans le désordre
    const GET = await freshRoute();
    const body = await (await GET(req(`Bearer ${TOKEN}`))).json();
    expect(ids(body)).toEqual(['b', 'a']); // ADF_100 avant ADF_200
  });

  it('finFrom + borne haute : finFrom <= dateFin <= aujourd\'hui', async () => {
    getMock.mockResolvedValue(asDocs([PASSEE, AUJH, FUTURE]));
    const GET = await freshRoute();
    // finFrom=2026-05-01 → 'passee' (fév) exclue par le bas, 'future' exclue par le haut
    const body = await (await GET(req(`Bearer ${TOKEN}`, '?finFrom=2026-05-01'))).json();
    expect(ids(body)).toEqual(['aujh']);
  });

  it('la clé de cache inclut le jour : au changement de jour → nouvelle lecture', async () => {
    const GET = await freshRoute();
    await GET(req(`Bearer ${TOKEN}`)); // jour 2026-07-10
    await GET(req(`Bearer ${TOKEN}`)); // même jour → cache
    expect(getMock).toHaveBeenCalledTimes(1);
    setToday('2026-07-11'); // le lendemain
    await GET(req(`Bearer ${TOKEN}`)); // clé neuve (jour ≠) → relit
    expect(getMock).toHaveBeenCalledTimes(2);
  });
});

describe('GET /api/export/sheet — exclusion "Échec" (règle cockpit)', () => {
  const TODAY = '2026-07-10';
  // Deux sessions IDENTIQUES (même dateFin dans la fenêtre) sauf l'étape.
  const ECHEC = { ...rawWith('echec', '2026-05-10T00:00:00'), etape: 'Échec' };
  const REALISATION = { ...rawWith('real', '2026-05-10T00:00:00'), etape: 'Réalisation' };

  beforeEach(() => {
    getMock.mockReset();
    getMock.mockResolvedValue(asDocs([ECHEC, REALISATION]));
    process.env.SHEET_EXPORT_TOKEN = TOKEN;
    setToday(TODAY);
  });

  const ids = (body: { rows: string[][] }) => body.rows.map((r) => r[0]);

  it('session Échec dans la fenêtre → EXCLUE ; session Réalisation identique → incluse', async () => {
    const GET = await freshRoute();
    const body = await (await GET(req(`Bearer ${TOKEN}`))).json();
    expect(ids(body)).toEqual(['real']); // 'echec' retirée, seule 'real' reste
  });

  it('libellé Échec insensible casse/accents (réutilise isEchecEtape) → EXCLUE', async () => {
    getMock.mockResolvedValue(asDocs([{ ...rawWith('e2', '2026-05-10T00:00:00'), etape: 'ECHEC' }, REALISATION]));
    const GET = await freshRoute();
    const body = await (await GET(req(`Bearer ${TOKEN}`))).json();
    expect(ids(body)).toEqual(['real']);
  });
});

// --- S10.2b : colonne "À relancer (noms)" -----------------------------------
describe('GET /api/export/sheet — colonne "À relancer (noms)"', () => {
  const TODAY = '2026-07-10';
  /** Dernière cellule (la colonne noms) de la ligne d'idAdf donné. */
  const nomsDe = (body: { rows: string[][] }, idAdf: string) => body.rows.find((r) => r[0] === idAdf)?.at(-1);
  const ids = (body: { rows: string[][] }) => body.rows.map((r) => r[0]);

  beforeEach(() => {
    getMock.mockReset();
    process.env.SHEET_EXPORT_TOKEN = TOKEN;
    setToday(TODAY);
  });

  it('requête pending : where(status,==,pending) + select(3 champs), SANS orderBy (aucun index composite)', async () => {
    getMock.mockResolvedValue(asDocs([rawWith('s1', '2026-05-10T00:00:00')]));
    const GET = await freshRoute();
    await GET(req(`Bearer ${TOKEN}`));
    expect(whereSpy).toHaveBeenCalledWith('status', '==', 'pending');
    expect(selectSpy).toHaveBeenCalledWith('idAdf', 'idParticipant', 'nom');
    expect(whereSpy).toHaveBeenCalledTimes(1); // UNE seule requête, jamais une par session
  });

  it('DÉDUP par participant : 7 attestations / 5 personnes → 5 noms, et nb noms == counts.participantsARelancer', async () => {
    // Cas réel ADF_20250278 (idAdf=3094) : envoyes 37, signes 30, nonSignes 7, participantsARelancer 5.
    const S3094 = {
      ...rawWith('3094', '2026-05-10T00:00:00'),
      counts: { envoyes: 37, signes: 30, nonSignes: 7, participantsConcernes: 22, participantsARelancer: 5 },
    };
    getMock.mockResolvedValue(asDocs([S3094]));
    // 7 attestations pending pour 5 personnes distinctes (2 en ont chacune 2 : EPP amont + aval).
    pendingGetMock.mockResolvedValue(
      asPending([
        pending('3094', '452006', 'Prescillia N Dalla IKOUEBE'),
        pending('3094', '452766', 'Hugo CASTAN'),
        pending('3094', '452766', 'Hugo CASTAN'), // même personne, autre doctype
        pending('3094', '452858', 'Helene GROS-LAFAIGE'),
        pending('3094', '452878', 'Mireille Pierrette REA'),
        pending('3094', '452878', 'Mireille Pierrette REA'), // idem
        pending('3094', '453125', 'Sami TIGRE'),
      ]),
    );
    const GET = await freshRoute();
    const body = await (await GET(req(`Bearer ${TOKEN}`))).json();
    const cell = nomsDe(body, '3094')!;
    // Tri alpha, chaque personne UNE seule fois malgré 7 attestations.
    expect(cell).toBe('Helene GROS-LAFAIGE, Hugo CASTAN, Mireille Pierrette REA, Prescillia N Dalla IKOUEBE, Sami TIGRE');
    // Cohérence avec le compteur déjà stocké : 5 noms == participantsARelancer.
    expect(cell.split(', ')).toHaveLength(S3094.counts.participantsARelancer);
  });

  it('session RETENUE sans aucun pending → "-" (EMPTY_DISPLAY), jamais ""', async () => {
    getMock.mockResolvedValue(asDocs([rawWith('sansPending', '2026-05-10T00:00:00')]));
    pendingGetMock.mockResolvedValue(asPending([pending('autre', '1', 'Jean AUTRE')]));
    const GET = await freshRoute();
    const body = await (await GET(req(`Bearer ${TOKEN}`))).json();
    expect(nomsDe(body, 'sansPending')).toBe(EMPTY_DISPLAY);
  });

  it('ANGLE MORT : les noms d\'une session Échec ou FUTURE ne remontent JAMAIS', async () => {
    const ECHEC = { ...rawWith('echec', '2026-05-10T00:00:00'), etape: 'Échec' };
    const FUTURE = rawWith('future', '2026-09-01T00:00:00'); // > TODAY
    const RETENUE = rawWith('real', '2026-05-10T00:00:00');
    getMock.mockResolvedValue(asDocs([ECHEC, FUTURE, RETENUE]));
    // La map pending est GLOBALE : elle contient aussi les pending des sessions filtrées.
    pendingGetMock.mockResolvedValue(
      asPending([
        pending('echec', '900', 'Fantome ECHEC'),
        pending('future', '901', 'Fantome FUTURE'),
        pending('real', '902', 'Hugo CASTAN'),
      ]),
    );
    const GET = await freshRoute();
    const body = await (await GET(req(`Bearer ${TOKEN}`))).json();
    expect(ids(body)).toEqual(['real']); // seules les sessions retenues ont une ligne
    expect(nomsDe(body, 'real')).toBe('Hugo CASTAN');
    // Aucun nom de session filtrée nulle part dans la réponse.
    const dump = JSON.stringify(body);
    expect(dump).not.toContain('Fantome ECHEC');
    expect(dump).not.toContain('Fantome FUTURE');
  });

  it('CACHE pending SÉPARÉ : 2 finFrom distincts → 2 lectures sessions mais UNE seule lecture signatures', async () => {
    getMock.mockResolvedValue(asDocs([rawWith('s1', '2026-05-10T00:00:00')]));
    const GET = await freshRoute();
    await GET(req(`Bearer ${TOKEN}`)); // clé payload 'all'
    await GET(req(`Bearer ${TOKEN}`, '?finFrom=2026-01-01')); // clé payload '2026-01-01'
    expect(getMock).toHaveBeenCalledTimes(2); // 2 entrées de cache payload → 2 lectures sessions
    expect(pendingGetMock).toHaveBeenCalledTimes(1); // …mais la map pending est PARTAGÉE
  });

  it('CACHE pending : clé `pending|{jour}` → au changement de jour, relit les signatures', async () => {
    getMock.mockResolvedValue(asDocs([rawWith('s1', '2026-05-10T00:00:00')]));
    const GET = await freshRoute();
    await GET(req(`Bearer ${TOKEN}`));
    expect(pendingGetMock).toHaveBeenCalledTimes(1);
    setToday('2026-07-11'); // le lendemain → clé pending neuve
    await GET(req(`Bearer ${TOKEN}`));
    expect(pendingGetMock).toHaveBeenCalledTimes(2);
  });

  it('signatures KO → 500 clair (aucune donnée sensible propagée)', async () => {
    getMock.mockResolvedValue(asDocs([rawWith('s1', '2026-05-10T00:00:00')]));
    pendingGetMock.mockRejectedValueOnce(new Error('firestore down'));
    const GET = await freshRoute();
    const res = await GET(req(`Bearer ${TOKEN}`));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'export failed' });
  });
});
