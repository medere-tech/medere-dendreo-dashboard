/**
 * Constantes Dendreo côté UI (lecture seule). `web_base` = racine SANS `/api`
 * (prouvé en S5.0, cf. docs/recon-s5-findings.md §4). Source unique : ne jamais
 * réécrire cette URL en dur ailleurs.
 */
export const DENDREO_WEB_BASE = 'https://pro.dendreo.com/nes_formation';

/** Espace de stockage « Suivi des signatures » d'une session : /formations/{idAdf}/suivi-signatures. */
export function suiviSignaturesUrl(idAdf: string): string {
  return `${DENDREO_WEB_BASE}/formations/${encodeURIComponent(idAdf)}/suivi-signatures`;
}
