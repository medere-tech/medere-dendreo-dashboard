'use client';

import { useCallback, useEffect, useState } from 'react';
import { onSnapshot, type FirestoreError } from 'firebase/firestore';
import { getFirebaseDb } from '@/lib/firebase/client';
import { sessions2026Query, type SessionDoc } from '@/lib/firestore/sessions';

interface SessionsState {
  sessions: SessionDoc[];
  loading: boolean;
  error: FirestoreError | null;
}

/**
 * Abonnement temps réel au working set 2026 (`onSnapshot`).
 * Working set gardé en mémoire → recherche/tri/filtre instantanés côté UI.
 * `retry()` ré-abonne après une erreur (bouton "Réessayer").
 */
export function useSessions(): SessionsState & { retry: () => void } {
  const [state, setState] = useState<SessionsState>({ sessions: [], loading: true, error: null });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setState((s) => ({ ...s, loading: true, error: null }));
    const unsub = onSnapshot(
      sessions2026Query(getFirebaseDb()),
      (snap) => {
        const sessions = snap.docs.map((d) => d.data() as SessionDoc);
        setState({ sessions, loading: false, error: null });
      },
      (error) => setState({ sessions: [], loading: false, error }),
    );
    return unsub;
  }, [attempt]);

  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  return { ...state, retry };
}
