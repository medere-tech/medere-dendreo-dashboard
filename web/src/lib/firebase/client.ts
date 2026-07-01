/**
 * Firebase Web SDK (CLIENT uniquement) — Auth + Firestore.
 *
 * ⚠️ Rien à voir avec l'Admin SDK serveur (src/firebase à la racine du repo) :
 * ce module vit dans l'app `web/`, qui NE dépend PAS de `firebase-admin`.
 * Ici, aucun secret serveur : uniquement des identifiants publics NEXT_PUBLIC_*.
 *
 * Initialisation paresseuse : `initializeApp` n'est appelé qu'au premier accès
 * (côté navigateur), jamais au rendu serveur (SSR).
 */
import { initializeApp, getApps, getApp, type FirebaseApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

function getFirebaseApp(): FirebaseApp {
  return getApps().length ? getApp() : initializeApp(firebaseConfig);
}

export function getFirebaseAuth(): Auth {
  return getAuth(getFirebaseApp());
}

export function getFirebaseDb(): Firestore {
  return getFirestore(getFirebaseApp());
}
