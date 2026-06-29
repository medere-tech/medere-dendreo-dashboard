// test/rules.emu.test.ts — Règles Firestore contre l'émulateur (@firebase/rules-unit-testing).
// Teste explicitement les CHEMINS DE REFUS + le cas autorisé. Skip sans émulateur.
// Exécution réelle : npm run test:emu.

import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { deleteDoc, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';

const onEmu = describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST);

const [host, portStr] = (process.env.FIRESTORE_EMULATOR_HOST ?? 'localhost:8080').split(':');

onEmu('règles Firestore', () => {
  let testEnv: RulesTestEnvironment;

  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: 'demo-medere-dendreo',
      firestore: {
        rules: readFileSync('firestore.rules', 'utf8'),
        host: host ?? 'localhost',
        port: Number(portStr ?? '8080'),
      },
    });
  });

  afterAll(async () => {
    if (testEnv) await testEnv.cleanup();
  });

  const unauth = () => testEnv.unauthenticatedContext().firestore();
  const foreign = () => testEnv.authenticatedContext('u1', { email: 'intrus@gmail.com', email_verified: true }).firestore();
  const unverified = () => testEnv.authenticatedContext('u2', { email: 'agent@medere.fr', email_verified: false }).firestore();
  const medere = () => testEnv.authenticatedContext('u3', { email: 'agent@medere.fr', email_verified: true }).firestore();

  // --- REFUS ---
  it('non authentifié → lecture REFUSÉE', async () => {
    await assertFails(getDoc(doc(unauth(), 'sessions/ADF_1')));
  });

  it('authentifié hors @medere.fr → lecture REFUSÉE', async () => {
    await assertFails(getDoc(doc(foreign(), 'sessions/ADF_1')));
  });

  it('@medere.fr mais email_verified=false → lecture REFUSÉE', async () => {
    await assertFails(getDoc(doc(unverified(), 'sessions/ADF_1')));
  });

  it('écriture client (set/update/delete) → REFUSÉE même pour un Médéré vérifié', async () => {
    await assertFails(setDoc(doc(medere(), 'sessions/ADF_1'), { hacked: true }));
    await assertFails(updateDoc(doc(medere(), 'sessions/ADF_1'), { hacked: true }));
    await assertFails(deleteDoc(doc(medere(), 'sessions/ADF_1')));
    await assertFails(setDoc(doc(medere(), 'signatures/ADF_1_p1_111'), { hacked: true }));
  });

  it('lecture de _meta par un client → REFUSÉE même pour un Médéré vérifié', async () => {
    await assertFails(getDoc(doc(medere(), '_meta/backfill')));
  });

  // --- AUTORISATION ---
  it('@medere.fr + email_verified → lecture AUTORISÉE (sessions et signatures)', async () => {
    await assertSucceeds(getDoc(doc(medere(), 'sessions/ADF_1')));
    await assertSucceeds(getDoc(doc(medere(), 'signatures/ADF_1_p1_111')));
  });
});
