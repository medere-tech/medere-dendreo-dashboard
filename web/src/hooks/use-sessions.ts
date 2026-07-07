'use client';

import { useCallback, useEffect, useState } from 'react';
import { onSnapshot, type FirestoreError } from 'firebase/firestore';
import { getFirebaseDb } from '@/lib/firebase/client';
import { allSessionsQuery, toSessionDoc, type SessionDoc } from '@/lib/firestore/sessions';

interface SessionsState {
  sessions: SessionDoc[];
  loading: boolean;
  error: FirestoreError | null;
}

/**
 * Abonnement temps réel à TOUTE la collection sessions (`onSnapshot`). Le miroir
 * ne contient que 2025–2026 (backfill par started_after) ; l'appartenance à une
 * année ne se déduit JAMAIS du `numeroComplet` (= année de création), seulement
 * de `dateDebut/dateFin`. Le filtre cockpit (terminées + hors Echec) est ensuite
 * appliqué en mémoire par `isCockpitVisible`. `retry()` ré-abonne après erreur.
 */
export function useSessions(): SessionsState & { retry: () => void } {
  const [state, setState] = useState<SessionsState>({ sessions: [], loading: true, error: null });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setState((s) => ({ ...s, loading: true, error: null }));
    const unsub = onSnapshot(
      allSessionsQuery(getFirebaseDb()),
      (snap) => {
        const sessions = snap.docs.map((d) => toSessionDoc(d.data()));
        setState({ sessions, loading: false, error: null });
      },
      (error) => setState({ sessions: [], loading: false, error }),
    );
    return unsub;
  }, [attempt]);

  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  return { ...state, retry };
}
