import { parisDayOfInstant } from './time';

/** Placeholder d'affichage unique pour une valeur absente/vide (SOURCE DE VÉRITÉ). */
export const EMPTY_DISPLAY = '-';

/**
 * Date ISO naïve ("2026-01-01T00:00:00") → "JJ/MM/AAAA".
 * On NE passe PAS par `new Date()` (éviterait un décalage de fuseau, cf.
 * docs/firestore-model.md §6). null/vide → EMPTY_DISPLAY.
 */
export function formatDateFr(iso: string | null | undefined): string {
  if (!iso) return EMPTY_DISPLAY;
  const [y, m, d] = iso.slice(0, 10).split('-');
  if (!y || !m || !d) return EMPTY_DISPLAY;
  return `${d}/${m}/${y}`;
}

/** Valeur nullable affichable : null/vide → EMPTY_DISPLAY. */
export function orDash(v: string | null | undefined): string {
  return v && v.trim() !== '' ? v : EMPTY_DISPLAY;
}

/**
 * INSTANT absolu (ISO avec `Z`, ex. `sentDate`/`signatureDate`) → "JJ/MM/AAAA"
 * au JOUR PARIS (cf. firestore-model.md §6 cas B). Passe par Intl, jamais par
 * `slice` (qui donnerait le jour UTC). null/invalide → EMPTY_DISPLAY.
 */
export function formatInstantParisFr(instant: string | null | undefined): string {
  return formatDateFr(parisDayOfInstant(instant));
}

/** Ancienneté (jours) → libellé humain. null → EMPTY_DISPLAY. */
export function formatAgeDays(days: number | null): string {
  if (days === null) return EMPTY_DISPLAY;
  if (days <= 0) return "aujourd'hui";
  if (days === 1) return 'hier';
  return `il y a ${days} j`;
}
