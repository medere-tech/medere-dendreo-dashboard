'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  GoogleAuthProvider,
  browserLocalPersistence,
  onAuthStateChanged,
  setPersistence,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import { getFirebaseAuth } from '@/lib/firebase/client';
import { isAllowedMedereUser } from './is-allowed-medere-user';

const DENIED_MESSAGE = 'Accès réservé aux comptes @medere.fr';

type AuthState = {
  /** Utilisateur autorisé, ou null si déconnecté / refusé. */
  user: User | null;
  /** true tant que l'état d'auth initial n'est pas résolu. */
  loading: boolean;
  /** Message d'erreur affichable (refus de domaine, échec technique). */
  error: string | null;
  signIn: () => Promise<void>;
  signOutUser: () => Promise<void>;
};

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Verrou permanent : à chaque changement d'état, on revalide le domaine.
  useEffect(() => {
    const auth = getFirebaseAuth();
    return onAuthStateChanged(auth, (u) => {
      void (async () => {
        if (u && !isAllowedMedereUser(u.email, u.emailVerified)) {
          await signOut(auth);
          setUser(null);
          setError(DENIED_MESSAGE);
        } else {
          setUser(u);
          if (u) setError(null);
        }
        setLoading(false);
      })();
    });
  }, []);

  const signIn = useCallback(async () => {
    setError(null);
    const auth = getFirebaseAuth();
    try {
      await setPersistence(auth, browserLocalPersistence);
      const provider = new GoogleAuthProvider();
      // hd = indice de domaine côté Google ; ne remplace PAS notre verrou.
      provider.setCustomParameters({ hd: 'medere.fr', prompt: 'select_account' });
      const cred = await signInWithPopup(auth, provider);
      if (!isAllowedMedereUser(cred.user.email, cred.user.emailVerified)) {
        await signOut(auth);
        setUser(null);
        setError(DENIED_MESSAGE);
      }
      // Cas autorisé : onAuthStateChanged pose l'utilisateur.
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
        return; // annulation volontaire : pas d'erreur affichée
      }
      // On ne propage jamais le détail technique (pas de fuite d'info).
      setError('La connexion a échoué. Réessayez.');
    }
  }, []);

  const signOutUser = useCallback(async () => {
    await signOut(getFirebaseAuth());
    setUser(null);
  }, []);

  const value = useMemo<AuthState>(
    () => ({ user, loading, error, signIn, signOutUser }),
    [user, loading, error, signIn, signOutUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth doit être utilisé dans <AuthProvider>');
  return ctx;
}
