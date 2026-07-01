import type { User } from 'firebase/auth';

/**
 * Prénom affichable : 1er mot du displayName Google, sinon la partie locale
 * de l'email, sinon un repli neutre.
 */
export function firstNameFrom(user: Pick<User, 'displayName' | 'email'> | null): string {
  const display = user?.displayName?.trim();
  if (display) {
    const first = display.split(/\s+/)[0];
    if (first) return first;
  }
  const email = user?.email?.trim();
  if (email) {
    const local = email.slice(0, email.lastIndexOf('@'));
    if (local) return local;
  }
  return 'à vous';
}

/** Initiale pour l'avatar du menu. */
export function initialFrom(user: Pick<User, 'displayName' | 'email'> | null): string {
  const source = user?.displayName?.trim() || user?.email?.trim() || '?';
  return source.charAt(0).toUpperCase();
}
