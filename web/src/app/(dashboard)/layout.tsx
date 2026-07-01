'use client';

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth/auth-context';
import { AppShell } from '@/components/app-shell';

/**
 * Garde d'authentification pour toutes les routes du dashboard.
 * Non connecté → redirection /login. En cours de résolution → skeleton (pas de spinner).
 */
export default function DashboardLayout({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [loading, user, router]);

  if (loading || !user) {
    return (
      <div className="flex min-h-dvh flex-col">
        <div className="h-14 border-b border-hairline-soft bg-canvas" />
        <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
          <div className="h-8 w-48 animate-pulse rounded-md bg-hairline-soft" />
          <div className="mt-6 h-40 w-full animate-pulse rounded-2xl bg-hairline-soft" />
        </div>
      </div>
    );
  }

  return <AppShell>{children}</AppShell>;
}
