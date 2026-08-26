// src/core/paris-day.ts — Jour « mur » Europe/Paris, partagé serveur ↔ web.
//
// Module NEUTRE et PUR : aucun import (comme src/core/attestation-name.ts).
// Il existe parce que `src/` ne peut PAS importer `web/` : l'alias `@shared/*` va de
// web vers src, jamais l'inverse. Le sync (src/) et l'UI (web/) doivent pourtant
// s'accorder sur « aujourd'hui », d'où cette implémentation UNIQUE, re-exportée par
// web/src/lib/time.ts.
//
// On ne passe JAMAIS par UTC/toISOString, qui décalerait d'un jour les dates naïves
// à 00:00 (cf. docs/firestore-model.md §6, cas A). On formate l'instant DANS le
// fuseau Paris via Intl, qui gère l'heure d'été/hiver.

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
