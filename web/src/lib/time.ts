/**
 * Temps « mur » Europe/Paris — sans jamais passer par UTC/toISOString (qui
 * décalerait d'un jour les dates naïves à 00:00, cf. firestore-model.md §6).
 * On formate un instant DANS le fuseau Paris via Intl (gère l'heure d'été/hiver).
 */

const PARIS = 'Europe/Paris';

/** Date du jour à Paris, "YYYY-MM-DD" (en-CA = format ISO). Injectable pour tests. */
export function todayInParis(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: PARIS,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * Millisecondes jusqu'au prochain minuit Paris (pour re-évaluer « aujourd'hui »
 * pile au changement de jour, sans rechargement). Toujours dans ]0, 24h].
 */
/**
 * Cas B (firestore-model.md §6) : un INSTANT absolu (ISO avec `Z`, ex. `sentDate`
 * / `signatureDate` = `"2025-06-02T22:01:04.000000Z"`) → jour Paris "YYYY-MM-DD".
 * Ici `new Date()` est LÉGITIME car l'instant est non ambigu (`Z`) ; on formate
 * ENSUITE dans le fuseau Paris via Intl. JAMAIS de `slice(0,10)` (donnerait le
 * jour UTC → décalage le soir). null/invalide → "".
 */
export function parisDayOfInstant(instant: string | null | undefined): string {
  if (!instant) return '';
  const ms = instant.replace(/\.(\d{3})\d+Z$/, '.$1Z'); // microsecondes → millisecondes
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: PARIS,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/**
 * Nombre de jours calendaires entre deux jours "YYYY-MM-DD" (toDay − fromDay).
 * Arithmétique pure via `Date.UTC` comme simple ancre (aucune conversion de
 * fuseau) → déterministe. Entrées vides → NaN (à garder par l'appelant).
 */
export function daysBetween(fromDay: string, toDay: string): number {
  const [fy, fm, fd] = fromDay.split('-').map(Number);
  const [ty, tm, td] = toDay.split('-').map(Number);
  const a = Date.UTC(fy ?? 0, (fm ?? 1) - 1, fd ?? 1);
  const b = Date.UTC(ty ?? 0, (tm ?? 1) - 1, td ?? 1);
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

export function msUntilNextParisMidnight(now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: PARIS,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  const h = get('hour') % 24; // en-GB peut rendre "24" à minuit
  const m = get('minute');
  const s = get('second');
  const elapsedMs = ((h * 60 + m) * 60 + s) * 1000 + (now.getMilliseconds() || 0);
  const DAY_MS = 24 * 60 * 60 * 1000;
  return DAY_MS - elapsedMs;
}
