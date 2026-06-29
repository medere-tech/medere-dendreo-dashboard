// src/firebase/admin.ts — Init Firebase Admin SDK (lecture/écriture serveur).
// Creds via env, JAMAIS loggées. En mode émulateur (FIRESTORE_EMULATOR_HOST défini)
// → projet "demo-…", aucune creds réelle requise (100% hors-ligne).

import { type App, cert, getApps, initializeApp } from 'firebase-admin/app';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';
import { loadFirebaseEnv } from '../config';

const EMULATOR_PROJECT_ID = 'demo-medere-dendreo';

let dbSingleton: Firestore | null = null;

/** Initialise (ou réutilise) l'app Admin. Ne logge aucune creds. */
export function initAdmin(): App {
  const apps = getApps();
  if (apps.length > 0) return apps[0]!;

  if (process.env.FIRESTORE_EMULATOR_HOST) {
    const projectId = process.env.GCLOUD_PROJECT ?? process.env.FIREBASE_PROJECT_ID ?? EMULATOR_PROJECT_ID;
    return initializeApp({ projectId });
  }

  const env = loadFirebaseEnv();
  return initializeApp({
    credential: cert({ projectId: env.projectId, clientEmail: env.clientEmail, privateKey: env.privateKey }),
    projectId: env.projectId,
  });
}

/** Firestore (singleton). Se connecte automatiquement à l'émulateur si présent. */
export function getDb(): Firestore {
  if (dbSingleton) return dbSingleton;
  dbSingleton = getFirestore(initAdmin());
  return dbSingleton;
}
