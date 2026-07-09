// src/reco/years.ts — Années à réconcilier par le cron (pur, testable).
// `today` est INJECTÉ (Date) → déterministe. Année calculée en Europe/Paris.

/**
 * Borne de départ FIXE de la réconciliation complète — SEULE année en dur.
 * Périmètre "relances vivantes" : on ne réconcilie pas l'historique avant 2025.
 * ⚠️ Abaisser cette valeur si Justine veut réintégrer 2024/2023/2022 (des
 * attestations existent depuis 2022, cf. rapport S9.0b) — au prix d'un run plus lourd.
 */
export const RECO_START_YEAR = 2025;

/** Année civile de `today` dans le fuseau Europe/Paris. */
export function parisYear(today: Date): number {
  return Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric' }).format(today));
}

/** Intervalle d'années [lo..hi] inclus ; [] si lo > hi. */
function range(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let n = lo; n <= hi; n++) out.push(n);
  return out;
}

/**
 * Nocturne : fenêtre glissante de 2 ans [année-1, année], bornée en bas à
 * RECO_START_YEAR. Léger : ne touche que le présent et l'année précédente.
 * Ex. 2026 → [2025, 2026] ; 2028 → [2027, 2028] ; début 2025 → [2025].
 */
export function nightlyYears(today: Date): number[] {
  const y = parisYear(today);
  return range(Math.max(RECO_START_YEAR, y - 1), y);
}

/**
 * Mensuel : réconciliation complète [RECO_START_YEAR .. année en cours]
 * (borne de fin glissante). Ex. 2026 → [2025, 2026] ; 2028 → [2025..2028].
 */
export function monthlyYears(today: Date): number[] {
  return range(RECO_START_YEAR, parisYear(today));
}
