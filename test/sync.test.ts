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

/**
 * S18 — fichiers de signature RÉELS (noms observés sur 3117/3818), pour vérifier le
 * `bloc` écrit par le mapper. Un cas par branche de la règle : amont, aval, sans marqueur.
 */
const fichier = (id: string, name: string, idParticipant: string, signatureDate = '') => ({
  id, collection_name: 'signature', name, doctype_id: `doc${id}`,
  signature_date: signatureDate, created_at: '2026-03-01 10:00:00',
  cible: 'action-de-formation', id_cible: '3117', public_url: `https://extranet/x/${id}`,
  entite_liee: { Participant: { id_participant: idParticipant, prenom: 'A', nom: 'B' } },
});
const FICHIERS_BLOCS = [
  fichier('1', 'Attestation_honneur_EPP amont_2025', 'p1', '2026-03-05 09:00:00'),
  fichier('2', 'Attestation_honneur_EPP aval_2025', 'p2'),
  fichier('3', "Attestation sur l'honneur PI_2026", 'p3'),
];

/**
 * S18 — LAM à la forme RÉELLE : `id_categorie_module` sur le MODULE inclus,
 * `date_fin` sur le LAM (deux niveaux différents, cf. recon 3818).
 */
const lam = (idLam: string, categorie: string, dateFin: string) => ({
  id_lam: idLam, date_fin: dateFin,
  module: { id_module: `m${idLam}`, id_categorie_module: categorie, c_nombre_dheures_connectees: '0' },
});
/** Modules non-aval TERMINÉS (2020) + aval futur (2999) → facturableAnneeN attendu = true. */
const LAMS_ANNEE_N_FINIE = [lam('1', '22', '2020-07-08 23:59:59'), lam('2', '13', '2020-07-08 23:59:59'), lam('3', '21', '2999-01-15 23:59:59')];
/** Un module cœur encore à venir → false. */
const LAMS_ANNEE_N_EN_COURS = [lam('1', '22', '2020-07-08 23:59:59'), lam('2', '13', '2999-12-01 23:59:59')];

/** Compte les appels PAR endpoint. `failEtapes` = etapes.php renvoie 500 ; `adf` = ADF sur mesure. */
function makeClient(opts: { failEtapes?: boolean; adf?: unknown[]; fichiers?: unknown[]; lams?: unknown[] } = {}) {
  const calls = new Map<string, number>();
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
  const fetchImpl = vi.fn(async (url: string) => {
    const resource = new URL(url).pathname.split('/').pop() ?? '';
    calls.set(resource, (calls.get(resource) ?? 0) + 1);
    if (resource === 'actions_de_formation.php') return json(opts.adf ?? ADF);
    if (resource === 'etapes.php') return opts.failEtapes ? new Response('err', { status: 500 }) : json(ETAPES);
    if (resource === 'financeurs.php') return json([{ id_financeur: '360', raison_sociale: 'ANDPC' }]); // évite l'alerte ANDPC
    if (resource === 'fichiers.php') return json(opts.fichiers ?? []); // S18 : [] par défaut = comportement d'avant
    if (resource === 'lams.php') return json(opts.lams ?? []); // S18 : idem
    return json([]); // financements, factures, laps, administrateurs
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

// --- S18 : bloc amont/cœur/aval écrit sur chaque ligne signature -------------
describe('syncSession — champ `bloc` sur les signatures (S18)', () => {
  /** Les lignes upsertées, indexées par idParticipant. */
  const lignes = (): Map<string, { bloc: string; documentName: string }> => {
    const out = new Map<string, { bloc: string; documentName: string }>();
    for (const [ligne] of upsertSignatureMock.mock.calls as unknown as [{ idParticipant: string; bloc: string; documentName: string }][]) {
      out.set(ligne.idParticipant, { bloc: ligne.bloc, documentName: ligne.documentName });
    }
    return out;
  };

  it('écrit le bloc déduit du documentName, une branche par cas réel', async () => {
    const syncSession = await freshSync();
    const { client } = makeClient({ fichiers: FICHIERS_BLOCS });

    const res = await syncSession('3117', client);

    expect(res.attestations).toBe(3);
    const l = lignes();
    expect(l.get('p1')?.bloc).toBe('amont'); // "…EPP amont_2025"
    expect(l.get('p2')?.bloc).toBe('aval'); // "…EPP aval_2025"
    expect(l.get('p3')?.bloc).toBe('coeur'); // aucun marqueur → défaut
  });

  it('le bloc est TOUJOURS renseigné (jamais undefined → écriture Firestore jamais rejetée)', async () => {
    const syncSession = await freshSync();
    const { client } = makeClient({ fichiers: FICHIERS_BLOCS });

    await syncSession('3117', client);

    expect(upsertSignatureMock).toHaveBeenCalledTimes(3);
    for (const [ligne] of upsertSignatureMock.mock.calls as unknown as [{ bloc: unknown }][]) {
      expect(['amont', 'coeur', 'aval']).toContain(ligne.bloc);
    }
  });

  it('0 appel Dendreo ajouté : fichiers.php reste lu UNE fois par session', async () => {
    const syncSession = await freshSync();
    const { client, nb } = makeClient({ fichiers: FICHIERS_BLOCS });

    await syncSession('3117', client);

    expect(nb('fichiers.php')).toBe(1);
  });
});

// --- S18 : facturableAnneeN écrit sur la session ----------------------------
describe('syncSession — facturableAnneeN (S18)', () => {
  /** Le flag de la DERNIÈRE session upsertée. */
  const flagEcrit = (): unknown => {
    const dernier = upsertSessionMock.mock.calls.at(-1) as unknown as [{ facturableAnneeN: unknown }] | undefined;
    return dernier?.[0].facturableAnneeN;
  };

  it('modules non-aval TERMINÉS + aval futur → true (cas 3818)', async () => {
    const syncSession = await freshSync();
    const { client } = makeClient({ lams: LAMS_ANNEE_N_FINIE });

    await syncSession('3117', client);

    expect(flagEcrit()).toBe(true);
  });

  it('un module cœur encore à venir → false', async () => {
    const syncSession = await freshSync();
    const { client } = makeClient({ lams: LAMS_ANNEE_N_EN_COURS });

    await syncSession('3117', client);

    expect(flagEcrit()).toBe(false);
  });

  it('aucun LAM lu → false (défaut sûr), et le champ est TOUJOURS un booléen', async () => {
    const syncSession = await freshSync();
    const { client } = makeClient(); // lams.php → []

    await syncSession('3117', client);

    expect(flagEcrit()).toBe(false);
    expect(typeof flagEcrit()).toBe('boolean'); // jamais undefined → validateSessionInput passe
  });

  it('0 appel Dendreo ajouté : lams.php reste lu UNE fois par session', async () => {
    const syncSession = await freshSync();
    const { client, nb } = makeClient({ lams: LAMS_ANNEE_N_FINIE });

    await syncSession('3117', client);

    expect(nb('lams.php')).toBe(1);
  });
});
