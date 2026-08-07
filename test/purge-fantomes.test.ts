// test/purge-fantomes.test.ts — S17.4 : purge des fantômes intégrée au sync.
//
// Zone SENSIBLE (cœur du sync en prod, suppressions IRRÉVERSIBLES). Ces tests
// verrouillent les 3 propriétés qui comptent :
//   1. ce qui est supprimé  : uniquement une clé absente de Dendreo ET pending ;
//   2. ce qui ne l'est JAMAIS : une signée, même absente (anomalie loggée) ;
//   3. quand on ne purge PAS : réponse douteuse, appel KO, ou chemin webhook.
// Firestore est mocké → tests hermétiques, aucune écriture réelle.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DendreoClient } from '../src/dendreo/client';

const { upsertSessionMock, upsertSignatureMock, recalcMock, listMirrorMock } = vi.hoisted(() => ({
  upsertSessionMock: vi.fn(async () => {}),
  upsertSignatureMock: vi.fn(async () => {}),
  recalcMock: vi.fn(async () => {}),
  listMirrorMock: vi.fn(async () => [] as MirrorEntry[]),
}));
vi.mock('../src/firebase/firestore', () => ({
  upsertSession: upsertSessionMock,
  upsertSignature: upsertSignatureMock,
  recalcSessionCounts: recalcMock,
  listSessionSignatureMirror: listMirrorMock,
}));

const ADF = [{
  id_action_de_formation: '3094', numero_complet: 'ADF_3094', intitule: 'AFGSU',
  date_debut: '2025-09-24 00:00:00', date_fin: '2026-01-15 23:59:59',
  id_etape_process: '6', total_participants: '15', id_centre_de_formation: '1',
  type: 'inter', num_session_dpc: '26.001', numero_comptable: '92622525478', mode_organisation: 'mixte',
}];

// --- fixtures miroir ---------------------------------------------------------
interface MirrorEntry {
  key: string;
  idParticipant: string;
  doctypeId: string;
  status: string;
  nom: string;
  documentName: string;
  signatureDate: string | null;
  delete: () => Promise<void>;
}

/** Une ligne du miroir, avec un `delete` espionné (on vérifie QUI est supprimé). */
function mirrorDoc(idParticipant: string, doctypeId: string, status: string, opts: { deleteFails?: boolean } = {}): MirrorEntry {
  return {
    key: `3094_${idParticipant}_${doctypeId}`,
    idParticipant,
    doctypeId,
    status,
    nom: `Participant ${idParticipant}`,
    documentName: 'Attestation de formation',
    signatureDate: status === 'signed' ? '2025-10-01T10:00:00' : null,
    delete: vi.fn(async () => {
      if (opts.deleteFails) throw new Error('permission-denied');
    }),
  };
}

/** Un fichier signature Dendreo (forme API réelle : entite_liee.Participant). */
function fichier(idParticipant: string, doctypeId: string, signed = false): Record<string, unknown> {
  return {
    collection_name: 'signature',
    name: 'Attestation de formation',
    doctype_id: doctypeId,
    signature_date: signed ? '2025-10-01 10:00:00' : '',
    created_at: '2025-09-25 08:00:00',
    public_url: 'https://pro.dendreo.com/x',
    entite_liee: { Participant: { id_participant: idParticipant, prenom: 'A', nom: 'B' } },
  };
}

/** Client Dendreo : `fichiers` = réponse de fichiers.php ; `fichiersStatus` != 200 → appel KO. */
function makeClient(opts: { fichiers?: unknown; fichiersStatus?: number } = {}) {
  const calls = new Map<string, number>();
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
  const fetchImpl = vi.fn(async (url: string) => {
    const resource = new URL(url).pathname.split('/').pop() ?? '';
    calls.set(resource, (calls.get(resource) ?? 0) + 1);
    if (resource === 'actions_de_formation.php') return json(ADF);
    if (resource === 'etapes.php') return json([{ id_etape_process: '6', intitule: 'Réalisation' }]);
    if (resource === 'financeurs.php') return json([{ id_financeur: '360', raison_sociale: 'ANDPC' }]);
    if (resource === 'fichiers.php') {
      if (opts.fichiersStatus && opts.fichiersStatus !== 200) return new Response('boom', { status: opts.fichiersStatus });
      return json(opts.fichiers ?? []);
    }
    return json([]); // lams, financements, factures, laps, administrateurs
  });
  const client = new DendreoClient({ baseUrl: 'https://x/api', apiKey: 'SECRET', fetchImpl, sleep: async () => {} });
  return { client, calls, nb: (r: string) => calls.get(r) ?? 0, totalCalls: () => [...calls.values()].reduce((a, b) => a + b, 0) };
}

/** Module FRAIS → caches module (étapes, ANDPC, commerciaux) remis à zéro. */
async function freshSync() {
  vi.resetModules();
  return (await import('../src/dendreo/sync')).syncSession;
}

const deleted = (docs: MirrorEntry[]): string[] => docs.filter((d) => (d.delete as unknown as { mock: { calls: unknown[] } }).mock.calls.length > 0).map((d) => d.key);

/** Toutes les lignes écrites sur la console pendant le test. */
const logs = (): string[] => (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  upsertSessionMock.mockClear();
  upsertSignatureMock.mockClear();
  recalcMock.mockClear();
  listMirrorMock.mockReset();
  listMirrorMock.mockResolvedValue([]);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

// =============================================================================
describe('S17.4 — purge des fantômes dans syncSession', () => {
  it('fantôme pending absent de Dendreo → SUPPRIMÉ, et les counts sont recalculés APRÈS', async () => {
    const syncSession = await freshSync();
    // Dendreo renvoie p1 et p2 ; le miroir a en plus p9 (pending) = le fantôme.
    const miroir = [mirrorDoc('1', '10', 'pending'), mirrorDoc('2', '10', 'signed'), mirrorDoc('9', '10', 'pending')];
    listMirrorMock.mockResolvedValue(miroir);
    const { client } = makeClient({ fichiers: [fichier('1', '10'), fichier('2', '10', true)] });

    const res = await syncSession('3094', client, { purge: true });

    expect(deleted(miroir)).toEqual(['3094_9_10']); // le fantôme, et LUI SEUL
    expect(res.purged).toBe(1);
    expect(res.purgeSkipped).toBeNull();
    expect(recalcMock).toHaveBeenCalledWith('3094'); // counts recalculés sur le miroir purgé
    // Ordre : la suppression a lieu AVANT le recalcul (sinon les counts restent faux).
    const ordre = (fn: unknown): number => Number((fn as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0]);
    expect(ordre(miroir[2]?.delete)).toBeLessThan(ordre(recalcMock));
  });

  it('SIGNÉE absente de Dendreo → JAMAIS supprimée, comptée comme anomalie', async () => {
    const syncSession = await freshSync();
    // p9 signée au miroir mais absente de Dendreo → preuve de conformité, on n'y touche pas.
    const miroir = [mirrorDoc('1', '10', 'pending'), mirrorDoc('2', '10', 'pending'), mirrorDoc('9', '10', 'signed')];
    listMirrorMock.mockResolvedValue(miroir);
    const { client } = makeClient({ fichiers: [fichier('1', '10'), fichier('2', '10')] });

    const res = await syncSession('3094', client, { purge: true });

    expect(deleted(miroir)).toEqual([]); // AUCUNE suppression
    expect(res.purged).toBe(0);
    expect(res.signedMissing).toBe(1); // signalée
    // Tracée par sa CLÉ (elle suffit à retrouver le participant dans Dendreo), pas par son nom.
    expect(logs().some((l) => l.includes('[PURGE ANOMALIE — NON SUPPRIMÉE]') && l.includes('3094_9_10'))).toBe(true);
  });

  it('un status miroir INATTENDU (ni pending ni signed) n\'est pas supprimé non plus', async () => {
    const syncSession = await freshSync();
    const miroir = [mirrorDoc('1', '10', 'pending'), mirrorDoc('2', '10', 'pending'), mirrorDoc('9', '10', 'PENDING')];
    listMirrorMock.mockResolvedValue(miroir);
    const { client } = makeClient({ fichiers: [fichier('1', '10'), fichier('2', '10')] });

    const res = await syncSession('3094', client, { purge: true });

    expect(deleted(miroir)).toEqual([]); // 'PENDING' !== 'pending' → traité comme non-pending
    expect(res.purged).toBe(0);
  });
});

// =============================================================================
describe('S17.4 — garde-fous : réponse Dendreo douteuse → purge SKIP, sync OK', () => {
  it('réponse VIDE alors que le miroir est peuplé → 0 suppression, sync réussit', async () => {
    const syncSession = await freshSync();
    const miroir = [mirrorDoc('1', '10', 'pending'), mirrorDoc('2', '10', 'pending')];
    listMirrorMock.mockResolvedValue(miroir);
    const { client } = makeClient({ fichiers: [] }); // hoquet API : rien renvoyé

    const res = await syncSession('3094', client, { purge: true });

    expect(deleted(miroir)).toEqual([]); // docs GARDÉS
    expect(res.purged).toBe(0);
    expect(res.purgeSkipped).toMatch(/VIDE/);
    expect(res.found).toBe(true); // le sync CONTINUE normalement
    expect(upsertSessionMock).toHaveBeenCalledTimes(1);
    expect(recalcMock).toHaveBeenCalledWith('3094');
  });

  it('réponse PARTIELLE (< 50 % du miroir) → 0 suppression, sync réussit', async () => {
    const syncSession = await freshSync();
    const miroir = ['1', '2', '3', '4', '5'].map((p) => mirrorDoc(p, '10', 'pending'));
    listMirrorMock.mockResolvedValue(miroir);
    const { client } = makeClient({ fichiers: [fichier('1', '10'), fichier('2', '10')] }); // 2 < 5 * 0.5

    const res = await syncSession('3094', client, { purge: true });

    expect(deleted(miroir)).toEqual([]);
    expect(res.purgeSkipped).toMatch(/partielle/);
    expect(res.found).toBe(true);
  });

  it('lignes Dendreo sans doctype_id (jeu de clés incomplet) → 0 suppression', async () => {
    const syncSession = await freshSync();
    const miroir = [mirrorDoc('1', '10', 'pending'), mirrorDoc('2', '10', 'pending'), mirrorDoc('9', '10', 'pending')];
    listMirrorMock.mockResolvedValue(miroir);
    // p9 EST côté Dendreo mais sans doctype_id → non clefable : sans ce garde-fou
    // elle passerait pour un fantôme et serait supprimée à tort.
    const { client } = makeClient({ fichiers: [fichier('1', '10'), fichier('2', '10'), { ...fichier('9', ''), doctype_id: '' }] });

    const res = await syncSession('3094', client, { purge: true });

    expect(deleted(miroir)).toEqual([]);
    expect(res.purgeSkipped).toMatch(/doctype_id/);
  });

  it('miroir Firestore illisible → 0 suppression, le sync se termine quand même', async () => {
    const syncSession = await freshSync();
    listMirrorMock.mockRejectedValue(new Error('RESOURCE_EXHAUSTED'));
    const { client } = makeClient({ fichiers: [fichier('1', '10')] });

    const res = await syncSession('3094', client, { purge: true });

    expect(res.purged).toBe(0);
    expect(res.purgeSkipped).toMatch(/miroir illisible/);
    expect(res.found).toBe(true);
    expect(recalcMock).toHaveBeenCalledWith('3094');
  });

  it('une suppression en ÉCHEC ne fait pas tomber le sync ni les autres suppressions', async () => {
    const syncSession = await freshSync();
    const miroir = [
      mirrorDoc('1', '10', 'pending'),
      mirrorDoc('8', '10', 'pending', { deleteFails: true }),
      mirrorDoc('9', '10', 'pending'),
    ];
    listMirrorMock.mockResolvedValue(miroir);
    const { client } = makeClient({ fichiers: [fichier('1', '10'), fichier('2', '10')] });

    const res = await syncSession('3094', client, { purge: true });

    expect(deleted(miroir).sort()).toEqual(['3094_8_10', '3094_9_10']); // les 2 tentées
    expect(res.purged).toBe(1); // seule celle qui a abouti est comptée
    expect(res.found).toBe(true);
  });

  it('appel fichiers.php KO (HTTP 500) → AUCUNE suppression ; le sync remonte l\'erreur comme avant', async () => {
    const syncSession = await freshSync();
    const miroir = [mirrorDoc('1', '10', 'pending'), mirrorDoc('9', '10', 'pending')];
    listMirrorMock.mockResolvedValue(miroir);
    const { client } = makeClient({ fichiersStatus: 500 });

    await expect(syncSession('3094', client, { purge: true })).rejects.toThrow();

    expect(deleted(miroir)).toEqual([]); // rien supprimé sur une réponse jamais obtenue
    expect(listMirrorMock).not.toHaveBeenCalled(); // la purge n'est même pas atteinte
    expect(recalcMock).not.toHaveBeenCalled();
  });
});

// =============================================================================
describe('S17.4 — isolation cron / webhook, coût, idempotence', () => {
  it('webhook (purge:false) → le miroir n\'est même pas lu, 0 suppression', async () => {
    const syncSession = await freshSync();
    const miroir = [mirrorDoc('1', '10', 'pending'), mirrorDoc('9', '10', 'pending')];
    listMirrorMock.mockResolvedValue(miroir);
    const { client } = makeClient({ fichiers: [fichier('1', '10')] });

    const res = await syncSession('3094', client, { purge: false });

    expect(listMirrorMock).not.toHaveBeenCalled();
    expect(deleted(miroir)).toEqual([]);
    expect(res.purged).toBe(0);
    expect(res.purgeSkipped).toBeNull();
  });

  it('DÉFAUT (aucune option) = purge INACTIVE — un appel qui oublie le flag ne supprime rien', async () => {
    const syncSession = await freshSync();
    const miroir = [mirrorDoc('1', '10', 'pending'), mirrorDoc('9', '10', 'pending')];
    listMirrorMock.mockResolvedValue(miroir);
    const { client } = makeClient({ fichiers: [fichier('1', '10')] });

    const res = await syncSession('3094', client);

    expect(listMirrorMock).not.toHaveBeenCalled();
    expect(res.purged).toBe(0);
  });

  it('ZÉRO appel Dendreo ajouté : purge:true et purge:false consomment exactement pareil', async () => {
    const fichiers = [fichier('1', '10'), fichier('2', '10')];
    const miroir = () => [mirrorDoc('1', '10', 'pending'), mirrorDoc('2', '10', 'pending'), mirrorDoc('9', '10', 'pending')];

    const syncSansPurge = await freshSync();
    listMirrorMock.mockResolvedValue(miroir());
    const sans = makeClient({ fichiers });
    await syncSansPurge('3094', sans.client, { purge: false });

    const syncAvecPurge = await freshSync();
    listMirrorMock.mockResolvedValue(miroir());
    const avec = makeClient({ fichiers });
    await syncAvecPurge('3094', avec.client, { purge: true });

    expect(avec.totalCalls()).toBe(sans.totalCalls());
    expect(avec.nb('fichiers.php')).toBe(1); // la purge réutilise CETTE réponse
  });

  it('idempotent : re-sync sans fantôme → 0 suppression, aucun delete tenté', async () => {
    const syncSession = await freshSync();
    const miroir = [mirrorDoc('1', '10', 'pending'), mirrorDoc('2', '10', 'signed')];
    listMirrorMock.mockResolvedValue(miroir);
    const { client } = makeClient({ fichiers: [fichier('1', '10'), fichier('2', '10', true)] });

    const un = await syncSession('3094', client, { purge: true });
    const deux = await syncSession('3094', client, { purge: true });

    expect(deleted(miroir)).toEqual([]);
    expect(un.purged).toBe(0);
    expect(deux.purged).toBe(0);
    expect(deux.purgeSkipped).toBeNull();
  });

  // S17.4b — RGPD : les journaux GitHub Actions sont conservés 90 j et lisibles par
  // tout collaborateur du dépôt. Aucune donnée nominative ne doit y transiter.
  it('logs SANS PII : ni nom de participant ni nom de document, quel que soit le cas', async () => {
    const syncSession = await freshSync();
    const miroir = [
      mirrorDoc('1', '10', 'pending'), // conservé (présent chez Dendreo)
      mirrorDoc('8', '10', 'pending'), // fantôme → supprimé
      mirrorDoc('9', '10', 'signed'), // signée absente → anomalie loggée
    ];
    listMirrorMock.mockResolvedValue(miroir);
    const { client } = makeClient({ fichiers: [fichier('1', '10'), fichier('2', '10')] });

    const res = await syncSession('3094', client, { purge: true });
    expect(res.purged).toBe(1);
    expect(res.signedMissing).toBe(1); // les 2 chemins de log ont bien été empruntés

    const purgeLogs = logs().filter((l) => l.startsWith('[PURGE'));
    expect(purgeLogs.length).toBeGreaterThanOrEqual(2);
    for (const l of purgeLogs) {
      expect(l).not.toMatch(/Participant \d/); // fixture `nom`
      expect(l).not.toContain('Attestation de formation'); // fixture `documentName`
    }
    // Ce qui RESTE : de quoi auditer sans identifier — idAdf, clé, doctype, status.
    expect(purgeLogs.some((l) => l.includes('[PURGE SUPPRIMÉ]') && l.includes('clé=3094_8_10') && l.includes('doctype=10') && l.includes('status=pending'))).toBe(true);
    expect(purgeLogs.some((l) => l.includes('[PURGE ANOMALIE') && l.includes('clé=3094_9_10') && l.includes('status=signed'))).toBe(true);
  });

  it('logs SANS PII : un SKIP ne divulgue rien non plus (raison technique seule)', async () => {
    const syncSession = await freshSync();
    const miroir = [mirrorDoc('1', '10', 'pending'), mirrorDoc('2', '10', 'pending')];
    listMirrorMock.mockResolvedValue(miroir);
    const { client } = makeClient({ fichiers: [] }); // réponse vide → skip

    await syncSession('3094', client, { purge: true });

    const skips = logs().filter((l) => l.startsWith('[PURGE SKIP]'));
    expect(skips).toHaveLength(1);
    expect(skips[0]).not.toMatch(/Participant \d/);
    expect(skips[0]).not.toContain('Attestation de formation');
    expect(skips[0]).toContain('idAdf=3094');
  });

  it('miroir VIDE → purge sans effet, aucun skip signalé (cas nominal d\'une session neuve)', async () => {
    const syncSession = await freshSync();
    listMirrorMock.mockResolvedValue([]);
    const { client } = makeClient({ fichiers: [] });

    const res = await syncSession('3094', client, { purge: true });

    expect(res.purged).toBe(0);
    expect(res.purgeSkipped).toBeNull(); // miroir vide + Dendreo vide = cohérent, pas un hoquet
  });
});
