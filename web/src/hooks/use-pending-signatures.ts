'use client';

import { useCallback, useEffect, useState } from 'react';
import { onSnapshot, type FirestoreError } from 'firebase/firestore';
import { getFirebaseDb } from '@/lib/firebase/client';
import { pendingSignaturesQuery, toSignatureDoc, type SignatureDoc } from '@/lib/firestore/sessions';

interface State {
  pending: SignatureDoc[];
  loading: boolean;
  error: FirestoreError | null;
}

/**
 * Abonnement temps réel aux attestations NON SIGNÉES (`status=='pending'`,
 * triées `sentDate asc`). Quand quelqu'un signe, le doc quitte `pending` → la
 * ligne disparaît seule (pas de refresh). `retry()` ré-abonne après erreur.
 */
export function usePendingSignatures(): State & { retry: () => void } {
  const [state, setState] = useState<State>({ pending: [], loading: true, error: null });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setState((s) => ({ ...s, loading: true, error: null }));
    const unsub = onSnapshot(
      pendingSignaturesQuery(getFirebaseDb()),
      (snap) => setState({ pending: snap.docs.map((d) => toSignatureDoc(d.data())), loading: false, error: null }),
      (error) => setState({ pending: [], loading: false, error }),
    );
    return unsub;
  }, [attempt]);

  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  return { ...state, retry };
}
