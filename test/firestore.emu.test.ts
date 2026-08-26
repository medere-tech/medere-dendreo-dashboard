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
  facturableAnneeN: false, // S18
  eppAmontConnecte: false,
  eppAvalConnecte: false,
  eligibleDpc: true,
  aEpp: false,
  datesSynchrones: [],
  financeurAndpc: false,
  montantAndpc: null,
  factureDateEnvoi: null,
  factureMontantHt: null,
  factureDatePaiement: null,
  facture1DateEnvoi: null,
  facture1DatePaiement: null,
  facture2DateEnvoi: null,
  facture2DatePaiement: null,
});

const sig = (idAdf: string, idParticipant: string, over: Partial<SignatureUpsertInput>): SignatureUpsertInput => ({
  idAdf,
  idParticipant,
  doctypeId: '177',
  documentName: 'Attestation test',
  bloc: 'coeur', // S18 — surchargeable par `over` ; cohérent avec le documentName par défaut
  nom: 'Prenom Nom',
  status: 'pending',
  signatureDate: null,
  sentDate: '2026-03-01T00:00:00.000Z',
  viewerUrl: null,
  financeurAndpc: null,
  commercial: null,
  assidu: null, // S14
  inscrit: null, // S14
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

    const expected = {
      envoyes: 4, signes: 2, nonSignes: 2, participantsConcernes: 3, participantsARelancer: 1,
      // documentName par défaut = "Attestation test" → aucun marqueur → tout en amontCoeur.
      amontCoeur: { signes: 2, total: 4 }, aval: { signes: 0, total: 0 },
    };
    const res = await recalcSessionCounts('T2');
    expect(res.counts).toEqual(expected);
    expect(res.oldestPendingSentDate).toBe('2026-03-05T00:00:00.000Z'); // le plus ancien pending

    const s = await getSession('T2');
    expect(s?.counts).toEqual(expected);
    expect(s?.oldestPendingSentDate).toBe('2026-03-05T00:00:00.000Z');
  });

  // --- S18 : ventilation par bloc --------------------------------------------
  it('recalcSessionCounts ventile amontCoeur / aval d\'après le documentName', async () => {
    await upsertSession(session('T6'));
    // amont : 1 signée + 1 pending | cœur (sans marqueur) : 1 signée | aval : 1 signée + 2 pending
    await upsertSignature(sig('T6', 'a', { doctypeId: '1', documentName: 'Attestation_honneur_EPP amont_2025', bloc: 'amont', status: 'signed', signatureDate: '2026-02-10T00:00:00.000Z' }));
    await upsertSignature(sig('T6', 'b', { doctypeId: '2', documentName: "Attestation sur l'honneur amont PI_2026", bloc: 'amont' }));
    await upsertSignature(sig('T6', 'c', { doctypeId: '3', documentName: "Attestation sur l'honneur PI_2026", bloc: 'coeur', status: 'signed', signatureDate: '2026-02-11T00:00:00.000Z' }));
    await upsertSignature(sig('T6', 'd', { doctypeId: '4', documentName: 'Attestation_honneur_EPP aval_2025', bloc: 'aval', status: 'signed', signatureDate: '2026-02-12T00:00:00.000Z' }));
    await upsertSignature(sig('T6', 'e', { doctypeId: '5', documentName: 'ATTESTATION EPP AVAL', bloc: 'aval' }));
    await upsertSignature(sig('T6', 'f', { doctypeId: '6', documentName: 'attestation eppaval', bloc: 'aval' }));

    const { counts } = await recalcSessionCounts('T6');
    expect(counts.amontCoeur).toEqual({ signes: 2, total: 3 }); // amont(1/2) + cœur(1/1)
    expect(counts.aval).toEqual({ signes: 1, total: 3 });
    // INVARIANT : aucune attestation perdue entre les deux blocs.
    expect(counts.amontCoeur.total + counts.aval.total).toBe(counts.envoyes);
    expect(counts.amontCoeur.signes + counts.aval.signes).toBe(counts.signes);
  });

  it('S18 — doc LEGACY sans champ `bloc` : compté quand même (dérivation du documentName)', async () => {
    await upsertSession(session('T7'));
    // Écriture DIRECTE (contourne upsertSignature/validation) : reproduit un doc écrit
    // AVANT S18, donc sans champ `bloc`. C'est la preuve qu'aucune migration n'est requise.
    const legacy = (idParticipant: string, doctypeId: string, documentName: string, status: string, signatureDate: string | null) =>
      getDb().collection('signatures').doc(signatureKey('T7', idParticipant, doctypeId)).set({
        idAdf: 'T7', idParticipant, doctypeId, documentName, nom: 'Prenom Nom',
        status, signatureDate, sentDate: '2026-03-01T00:00:00.000Z', viewerUrl: null,
        financeurAndpc: null, commercial: null, assidu: null, inscrit: null,
        sessionNumeroComplet: 'ADF_T7', sessionIntitule: 'Session test',
        sessionDateDebut: '2026-01-01T00:00:00.000Z', lastSyncedAt: '2026-03-01T00:00:00.000Z',
        // PAS de champ `bloc` — volontairement.
      });
    await legacy('a', '1', 'Attestation_honneur_EPP aval_2025', 'signed', '2026-02-10T00:00:00.000Z');
    await legacy('b', '2', 'Attestation_honneur_EPP amont_2025', 'pending', null);

    const docA = await getDb().collection('signatures').doc(signatureKey('T7', 'a', '1')).get();
    expect(docA.get('bloc')).toBeUndefined(); // le doc n'a bien AUCUN champ bloc

    const { counts } = await recalcSessionCounts('T7');
    expect(counts.aval).toEqual({ signes: 1, total: 1 });
    expect(counts.amontCoeur).toEqual({ signes: 0, total: 1 });
    expect(counts.amontCoeur.total + counts.aval.total).toBe(counts.envoyes);
  });

  it('S18 — upsertSignature REJETTE un bloc invalide (et un bloc absent)', async () => {
    await expect(upsertSignature(sig('T8', 'p1', { bloc: 'AMONT' as unknown as 'amont' }))).rejects.toThrow(/bloc invalide/);
    await expect(upsertSignature(sig('T8', 'p2', { bloc: undefined as unknown as 'coeur' }))).rejects.toThrow(/bloc invalide/);
    const all = await getDb().collection('signatures').get();
    expect(all.size).toBe(0); // rien n'a été écrit
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
