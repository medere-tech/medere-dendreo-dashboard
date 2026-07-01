'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth/auth-context';
import { initialFrom } from '@/lib/auth/display-name';
import { Brand } from './brand';

/**
 * Coquille applicative responsive (mobile-first) : en-tête collant avec la
 * marque, une navigation placeholder, et un menu utilisateur (déconnexion).
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { user, signOutUser } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Fermeture du menu au clic extérieur / touche Échap.
  useEffect(() => {
    if (!menuOpen) return;
    function onPointer(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenuOpen(false);
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-10 border-b border-hairline-soft bg-canvas/85 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
          <Brand className="text-base" />

          <div className="flex items-center gap-1">
            {/* Navigation placeholder (S3.2 branchera les vues réelles). */}
            <nav className="hidden items-center gap-1 sm:flex" aria-label="Navigation">
              <span className="rounded-md px-3 py-1.5 text-sm font-medium text-ink">Sessions</span>
              <span className="rounded-md px-3 py-1.5 text-sm text-faint">À relancer</span>
            </nav>

            <div className="relative" ref={menuRef}>
              <button
                type="button"
                onClick={() => setMenuOpen((v) => !v)}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-surface text-sm font-semibold text-muted shadow-sm ring-1 ring-hairline transition hover:text-ink"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label="Menu du compte"
              >
                {initialFrom(user)}
              </button>

              {menuOpen && (
                <div
                  role="menu"
                  className="absolute right-0 mt-2 w-64 overflow-hidden rounded-xl border border-hairline bg-surface shadow-lg"
                >
                  <div className="border-b border-hairline-soft px-4 py-3">
                    <p className="truncate text-sm font-medium text-ink">{user?.displayName ?? 'Compte Médéré'}</p>
                    <p className="truncate text-xs text-muted">{user?.email}</p>
                  </div>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      void signOutUser();
                    }}
                    className="block w-full px-4 py-2.5 text-left text-sm text-ink transition hover:bg-canvas"
                  >
                    Se déconnecter
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
