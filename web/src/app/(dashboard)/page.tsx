'use client';

import { useAuth } from '@/lib/auth/auth-context';
import { firstNameFrom } from '@/lib/auth/display-name';

export default function HomePage() {
  const { user } = useAuth();

  return (
    <section>
      <h1 className="text-2xl font-semibold tracking-tight text-ink">
        Bonjour {firstNameFrom(user)}
      </h1>
      <p className="mt-1 text-sm text-muted">
        Le suivi des signatures arrive ici.
      </p>

      <div className="mt-8 flex min-h-40 flex-col items-center justify-center rounded-2xl border border-dashed border-hairline bg-surface px-6 py-12 text-center">
        <p className="text-sm font-medium text-ink">Données à venir</p>
        <p className="mt-1 max-w-sm text-sm text-muted">
          Les sessions et les participants à relancer s&apos;afficheront ici au prochain sprint.
        </p>
      </div>
    </section>
  );
}
