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
