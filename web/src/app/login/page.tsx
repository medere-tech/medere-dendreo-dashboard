'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth/auth-context';
import { Brand } from '@/components/brand';
import { GoogleIcon } from '@/components/google-icon';

export default function LoginPage() {
  const { user, loading, error, signIn } = useAuth();
  const router = useRouter();

  // Déjà connecté (session persistée) → on file au cockpit.
  useEffect(() => {
    if (!loading && user) router.replace('/');
  }, [loading, user, router]);

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <Brand className="text-xl" />
        </div>

        <div className="rounded-2xl border border-hairline bg-surface p-8 shadow-sm">
          <h1 className="text-center text-lg font-semibold text-ink">Connexion</h1>
          <p className="mt-2 text-center text-sm text-muted">
            Accès réservé à l&apos;équipe Médéré.
          </p>

          <button
            type="button"
            onClick={() => void signIn()}
            disabled={loading}
            className="mt-7 flex w-full items-center justify-center gap-3 rounded-xl border border-hairline bg-surface px-4 py-3 text-sm font-semibold text-ink shadow-sm transition hover:bg-canvas active:bg-canvas disabled:cursor-not-allowed disabled:opacity-60"
          >
            <GoogleIcon className="h-5 w-5" />
            Se connecter avec Google
          </button>

          {error && (
            <p
              role="alert"
              className="mt-5 rounded-lg border border-hairline bg-canvas px-3 py-2.5 text-center text-sm text-ink-soft"
            >
              {error}
            </p>
          )}
        </div>

        <p className="mt-6 text-center text-xs text-faint">
          Comptes @medere.fr uniquement · lecture seule
        </p>
      </div>
    </div>
  );
}
