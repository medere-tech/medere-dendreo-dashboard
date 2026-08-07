import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DendreoClient } from '../src/dendreo/client';

// Écritures Firestore mockées → tests hermétiques (aucun I/O, aucun émulateur requis).
const { upsertSessionMock, upsertSignatureMock, recalcMock, listMirrorMock } = vi.hoisted(() => ({
  upsertSessionMock: vi.fn(async () => {}),
  upsertSignatureMock: vi.fn(async () => {}),
  recalcMock: vi.fn(async () => {}),
  // S17.4 : la purge ne tourne pas ici (purge=false par défaut) — le mock existe
  // pour que le module se charge, et sert d'assertion : il ne doit JAMAIS être appelé.
  listMirrorMock: vi.fn(async () => []),
}));
vi.mock('../src/firebase/firestore', () => ({
  upsertSession: upsertSessionMock,
  upsertSignature: upsertSignatureMock,
  recalcSessionCounts: recalcMock,
  listSessionSignatureMirror: listMirrorMock,
}));

const ADF = [{
  id_action_de_formation: '3117', numero_complet: 'ADF_3117', intitule: 'AFGSU',
  date_debut: '2025-09-24 00:00:00', date_fin: '2026-01-15 23:59:59',
  id_etape_process: '6', total_participants: '15', id_centre_de_formation: '1',
  type: 'inter', num_session_dpc: '26.001', numero_comptable: '92622525478', mode_organisation: 'mixte',
}];
const ETAPES = [
  { id_etape_process: '6', intitule: 'Réalisation' },
  { id_etape_process: '9', intitule: 'Échec' },
];

/** Compte les appels PAR endpoint. `failEtapes` = etapes.php renvoie 500 ; `adf` = ADF sur mesure. */
function makeClient(opts: { failEtapes?: boolean; adf?: unknown[] } = {}) {
  const calls = new Map<string, number>();
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
  const fetchImpl = vi.fn(async (url: string) => {
    const resource = new URL(url).pathname.split('/').pop() ?? '';
    calls.set(resource, (calls.get(resource) ?? 0) + 1);
    if (resource === 'actions_de_formation.php') return json(opts.adf ?? ADF);
    if (resource === 'etapes.php') return opts.failEtapes ? new Response('err', { status: 500 }) : json(ETAPES);
    if (resource === 'financeurs.php') return json([{ id_financeur: '360', raison_sociale: 'ANDPC' }]); // évite l'alerte ANDPC
    return json([]); // lams, financements, factures, laps, administrateurs, fichiers
  });
  const client = new DendreoClient({ baseUrl: 'https://x/api', apiKey: 'SECRET', fetchImpl, sleep: async () => {} });
  return { client, calls, nb: (r: string) => calls.get(r) ?? 0 };
}

/** Module FRAIS à chaque test → tous les caches module (étapes, ANDPC, commerciaux) repartent à zéro. */
async function freshSync() {
  vi.resetModules();
  return (await import('../src/dendreo/sync')).syncSession;
}

/** Le champ `etape` de la DERNIÈRE session upsertée (= ce que syncSession a écrit). */
const etapeEcrite = (): string => {
  const dernier = upsertSessionMock.mock.calls.at(-1) as unknown as [{ etape: string }] | undefined;
  return String(dernier?.[0].etape);
};

beforeEach(() => {
  upsertSessionMock.mockClear();
  upsertSignatureMock.mockClear();
  recalcMock.mockClear();
  listMirrorMock.mockClear();
});

// S17.4 : filet de sécurité global — aucun de ces syncs "ordinaires" (sans option
// purge) ne doit toucher au miroir. Si un jour la purge devenait active par défaut,
// ce test tomberait AVANT que la prod ne supprime quoi que ce soit.
afterEach(() => {
  expect(listMirrorMock).not.toHaveBeenCalled();
});

// --- S14.2 : etapes.php mis en cache module (1 lecture par exécution) --------
describe('syncSession — référentiel étapes en cache (S14.2)', () => {
  it('2 syncSession successifs → etapes.php lu UNE SEULE fois (les autres endpoints, à chaque fois)', async () => {
    const syncSession = await freshSync();
    const { client, nb } = makeClient();

    await syncSession('3117', client);
    await syncSession('3117', client);

    expect(nb('etapes.php')).toBe(1); // ← le gain : 1 appel au lieu de 2
    expect(nb('actions_de_formation.php')).toBe(2); // par session, inchangé
    expect(nb('laps.php')).toBe(2); // par session, inchangé
    expect(nb('financeurs.php')).toBe(1); // déjà en cache avant S14.2 (référence)
    expect(nb('administrateurs.php')).toBe(1); // idem
  });

  it('libellé IDENTIQUE au comportement d\'avant : id connu → intitulé, aux 2 appels', async () => {
    const syncSession = await freshSync();
    const { client } = makeClient();

    await syncSession('3117', client);
    expect(etapeEcrite()).toBe('Réalisation');
    await syncSession('3117', client); // servi par le cache → même libellé
    expect(etapeEcrite()).toBe('Réalisation');
  });

  it('id_etape_process ABSENT du référentiel → "etape_{id}" (fallback conservé)', async () => {
    const syncSession = await freshSync();
    const { client } = makeClient({ adf: [{ ...ADF[0], id_etape_process: '42' }] });

    await syncSession('3117', client);
    expect(etapeEcrite()).toBe('etape_42');
  });

  it('etapes.php KO → "etape_{id}" ET AUCUNE mise en cache : la session suivante RETENTE', async () => {
    const syncSession = await freshSync();
    const { client, nb } = makeClient({ failEtapes: true });

    await syncSession('3117', client);
    expect(etapeEcrite()).toBe('etape_6'); // fallback, comme avant le cache
    await syncSession('3117', client);
    expect(nb('etapes.php')).toBe(2); // ← un échec ne fige PAS les libellés du process
  });

  it('après un échec puis un succès, le bon libellé revient (aucune régression durable)', async () => {
    const syncSession = await freshSync();
    let ko = true;
    const fetchImpl = vi.fn(async (url: string) => {
      const resource = new URL(url).pathname.split('/').pop() ?? '';
      if (resource === 'actions_de_formation.php') return new Response(JSON.stringify(ADF), { status: 200 });
      if (resource === 'financeurs.php') return new Response(JSON.stringify([{ id_financeur: '360', raison_sociale: 'ANDPC' }]), { status: 200 });
      if (resource === 'etapes.php') {
        if (ko) { ko = false; return new Response('err', { status: 500 }); }
        return new Response(JSON.stringify(ETAPES), { status: 200 });
      }
      return new Response('[]', { status: 200 });
    });
    const client = new DendreoClient({ baseUrl: 'https://x/api', apiKey: 'SECRET', fetchImpl, sleep: async () => {} });

    await syncSession('3117', client);
    expect(etapeEcrite()).toBe('etape_6'); // 1er appel : etapes.php KO
    await syncSession('3117', client);
    expect(etapeEcrite()).toBe('Réalisation'); // 2e : relu avec succès, puis mis en cache
  });
});
