/**
 * Verrou de domaine Médéré — fonction PURE (testée), unique source de vérité
 * pour "cet utilisateur a-t-il le droit d'accéder au dashboard ?".
 *
 * Règle : l'email doit être VÉRIFIÉ et appartenir exactement au domaine
 * `medere.fr`. Les sous-domaines (`x@paie.medere.fr`) et les usurpations
 * (`x@medere.fr.evil.com`) sont refusés — on compare le domaine à l'égalité,
 * jamais par `endsWith`.
 */
const ALLOWED_DOMAIN = 'medere.fr';

export function isAllowedMedereUser(
  email: string | null | undefined,
  emailVerified: boolean,
): boolean {
  if (!emailVerified) return false;
  if (!email) return false;

  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf('@');
  if (at <= 0) return false; // pas de partie locale → invalide

  const domain = normalized.slice(at + 1);
  return domain === ALLOWED_DOMAIN;
}
