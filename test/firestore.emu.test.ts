// test/firestore.emu.test.ts — Couche de données Firestore contre l'ÉMULATEUR.
// Déterministe, zéro écriture prod. Skip si pas d'émulateur (npm test reste vert).
// Exécution réelle : npm run test:emu.

import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../src/firebase/admin';
import {
  getSession,
  listSignaturesByStatus,
  recalcSessionCounts,
  upsertSession,
  upsertSignature,
} from '../src/firebase/firestore';
import { signatureKey } from '../src/firebase/keys';
import type { SessionUpsertInput, SignatureUpsertInput } from '../src/firebase/types';

const onEmu = describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST);

async function clear(collection: string): Promise<void> {
  const snap = await getDb().collection(collection).get();
  const batch = getDb().batch();
  snap.forEach((d) => batch.delete(d.ref));
  await batch.commit();
}

const session = (idAdf: string): SessionUpsertInput => ({
  idAdf,
  numeroComplet: `ADF_${idAdf}`,
  numeroSessionDpc: '26.001',
  numeroCompteProduit: null,
  intitule: 'Session test',
  dateDebut: '2026-01-01T00:00:00.000Z',
  dateFin: '2026-06-30T00:00:00.000Z',
  idEtapeProcess: '6',
  etape: 'Réalisation',
  idCentre: '1',
  type: 'inter',
  totalParticipants: 4,
  format: 'Mixte',
  aCheval: false,
  eppAmontConnecte: false,
  eppAvalConnecte: false,
});

const sig = (idAdf: string, idParticipant: string, over: Partial<SignatureUpsertInput>): SignatureUpsertInput => ({
  idAdf,
  idParticipant,
  doctypeId: '177',
  documentName: 'Attestation test',
  nom: 'Prenom Nom',
  status: 'pending',
  signatureDate: null,
  sentDate: '2026-03-01T00:00:00.000Z',
  viewerUrl: null,
  sessionNumeroComplet: `ADF_${idAdf}`,
  sessionIntitule: 'Session test',
  sessionDateDebut: '2026-01-01T00:00:00.000Z',
  ...over,
});

onEmu('couche Firestore (émulateur)', () => {
  beforeEach(async () => {
    await clear('signatures');
    await clear('sessions');
  });

  it('upsert + relecture session et signatures', async () => {
    await upsertSession(session('T1'));
    await upsertSignature(sig('T1', 'p1', { status: 'signed', signatureDate: '2026-02-01T10:00:00.000Z', viewerUrl: 'https://x/1' }));
    await upsertSignature(sig('T1', 'p2', { status: 'pending', sentDate: '2026-03-01T10:00:00.000Z', viewerUrl: 'https://x/2' }));

    const s = await getSession('T1');
    expect(s?.numeroComplet).toBe('ADF_T1');
    expect(s?.numeroSessionDpc).toBe('26.001');
    expect(s?.numeroCompteProduit).toBeNull();
    expect(s?.source).toBe('dendreo');
    expect(typeof s?.lastSyncedAt).toBe('string');

    const pending = await listSignaturesByStatus('pending', { idAdf: 'T1' });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.idParticipant).toBe('p2');
  });

  it('accepte une session non-DPC (numeroSessionDpc=null) sans erreur', async () => {
    await upsertSession({ ...session('T4'), numeroSessionDpc: null });
    const s = await getSession('T4');
    expect(s?.numeroSessionDpc).toBeNull();
    expect(s?.numeroComplet).toBe('ADF_T4');
  });

  it('idempotence : ré-upsert de la même signature ne crée pas de doublon', async () => {
    const input = sig('T1', 'p1', { status: 'pending', sentDate: '2026-03-01T10:00:00.000Z' });
    await upsertSignature(input);
    await upsertSignature(input);
    await upsertSignature({ ...input, nom: 'Maj Nom' }); // réécriture (last-write-wins)

    const all = await getDb().collection('signatures').get();
    expect(all.size).toBe(1);
    const doc = await getDb().collection('signatures').doc(signatureKey('T1', 'p1', '177')).get();
    expect(doc.get('nom')).toBe('Maj Nom');
  });

  it('recalcSessionCounts (transaction) recompte les 5 compteurs + oldestPendingSentDate', async () => {
    await upsertSession(session('T2'));
    // participant "c" a DEUX attestations (doctypes différents) → 1 seul participant concerné.
    await upsertSignature(sig('T2', 'a', { status: 'signed', signatureDate: '2026-02-10T00:00:00.000Z', doctypeId: '177' }));
    await upsertSignature(sig('T2', 'b', { status: 'signed', signatureDate: '2026-02-11T00:00:00.000Z', doctypeId: '177' }));
    await upsertSignature(sig('T2', 'c', { status: 'pending', sentDate: '2026-03-20T00:00:00.000Z', doctypeId: '177' }));
    await upsertSignature(sig('T2', 'c', { status: 'pending', sentDate: '2026-03-05T00:00:00.000Z', doctypeId: '165' }));

    const expected = { envoyes: 4, signes: 2, nonSignes: 2, participantsConcernes: 3, participantsARelancer: 1 };
    const res = await recalcSessionCounts('T2');
    expect(res.counts).toEqual(expected);
    expect(res.oldestPendingSentDate).toBe('2026-03-05T00:00:00.000Z'); // le plus ancien pending

    const s = await getSession('T2');
    expect(s?.counts).toEqual(expected);
    expect(s?.oldestPendingSentDate).toBe('2026-03-05T00:00:00.000Z');
  });

  it('validation stricte : rejette un input incohérent (signed sans signatureDate)', async () => {
    await expect(upsertSignature(sig('T3', 'p1', { status: 'signed' }))).rejects.toThrow();
  });

  it('session TOLÉRANTE : champs mous vides → la session s\'écrit quand même', async () => {
    // Seuls idAdf + numeroComplet sont requis ; le reste peut être vide (jamais perdre une session).
    await upsertSession({
      ...session('T5'),
      intitule: '', dateDebut: '', dateFin: '', idEtapeProcess: '', etape: '', idCentre: '', type: '',
    });
    const s = await getSession('T5');
    expect(s?.numeroComplet).toBe('ADF_T5');
    expect(s?.dateDebut).toBe('');
    expect(s?.etape).toBe('');
  });

  it('session rejetée UNIQUEMENT si idAdf ou numeroComplet manquant', async () => {
    await expect(upsertSession({ ...session('T6'), numeroComplet: '' })).rejects.toThrow();
    // …mais un champ mou vide ne rejette pas :
    await expect(upsertSession({ ...session('T7'), type: '', idCentre: '' })).resolves.toBeUndefined();
  });
});
