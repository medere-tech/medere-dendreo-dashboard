'use client';

import { useAuth } from '@/lib/auth/auth-context';
import { firstNameFrom } from '@/lib/auth/display-name';
import { SessionsView } from '@/components/sessions/sessions-view';

export default function HomePage() {
  const { user } = useAuth();

  return (
    <section>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Bonjour {firstNameFrom(user)}</h1>
        <p className="mt-1 text-sm text-muted">Sessions terminées — signatures en un coup d&apos;œil.</p>
      </div>

      <SessionsView />
    </section>
  );
}
