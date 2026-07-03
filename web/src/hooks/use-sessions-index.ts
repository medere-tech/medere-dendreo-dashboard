'use client';

import { useCallback, useEffect, useState } from 'react';
import { onSnapshot, type FirestoreError } from 'firebase/firestore';
import { getFirebaseDb } from '@/lib/firebase/client';
import { allSessionsQuery, type SessionDoc } from '@/lib/firestore/sessions';

interface State {
  index: Map<string, SessionDoc>;
  loading: boolean;
  error: FirestoreError | null;
}

/**
 * Index temps réel de TOUTES les sessions (`idAdf → SessionDoc`), pour la
 * jointure de la vue « À relancer » : exclusion des sessions en « Echec » +
 * `numeroSessionDpc`. Temps réel → une session passant en « Echec » retire ses
 * relances sans rechargement.
 */
export function useSessionsIndex(): State & { retry: () => void } {
  const [state, setState] = useState<State>({ index: new Map(), loading: true, error: null });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setState((s) => ({ ...s, loading: true, error: null }));
    const unsub = onSnapshot(
      allSessionsQuery(getFirebaseDb()),
      (snap) => {
        const index = new Map<string, SessionDoc>();
        snap.docs.forEach((d) => {
          const s = d.data() as SessionDoc;
          index.set(s.idAdf, s);
        });
        setState({ index, loading: false, error: null });
      },
      (error) => setState({ index: new Map(), loading: false, error }),
    );
    return unsub;
  }, [attempt]);

  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  return { ...state, retry };
}
