// src/dendreo/attestation-bloc.ts — Bloc pédagogique d'une attestation, D'APRÈS SON NOM.
//
// BRIQUE 1 : fonction PURE, non branchée au sync. Aucune I/O, aucun état.
//
// RÈGLE (observée sur données réelles, sessions 3117 et 3818 —
// cf. scripts/recon-classification-attestation.mjs) :
//   nom normalisé contient "amont" → 'amont'
//   sinon contient        "aval"   → 'aval'
//   sinon                          → 'coeur'
//
// L'ORDRE COMPTE : "amont" est testé AVANT "aval". Sur un nom qui porterait les deux
// marqueurs, 'amont' l'emporte — choix déterministe assumé, pas un hasard de lecture.
//
// 'coeur' est un DÉFAUT, pas une preuve : aucun nom réel ne contient le mot « cœur ».
// Un nom sans marqueur signifie seulement « ni amont ni aval ».
//
// Nom vide, non-string ou undefined → 'coeur'. La fonction ne lève JAMAIS : elle est
// appelée sur des données Dendreo brutes, où `name` peut manquer.
//
// La normalisation est celle de la règle signature en prod (`normalizeDocName`,
// src/dendreo/signatures.ts) : minuscules + sans accents + trim. Elle est IMPORTÉE,
// jamais redéfinie — deux normalisations concurrentes finiraient par diverger.

import { normalizeDocName } from './signatures';

/** Bloc pédagogique auquel une attestation se rattache. */
export type AttestationBloc = 'amont' | 'coeur' | 'aval';

/** Marqueurs cherchés dans le nom normalisé, DANS CET ORDRE (amont avant aval). */
const MARQUEURS: ReadonlyArray<readonly [string, AttestationBloc]> = [
  ['amont', 'amont'],
  ['aval', 'aval'],
];

/**
 * Classe une attestation en amont / cœur / aval à partir de son nom de document.
 * Fonction pure et totale : tout nom non exploitable retombe sur 'coeur'.
 */
export function classifyAttestationBloc(documentName: string): AttestationBloc {
  // Garde AVANT normalizeDocName : celui-ci suppose une string (il appellerait
  // .normalize sur undefined). Ici on encaisse le brut de l'API sans lever.
  if (typeof documentName !== 'string' || documentName.trim() === '') return 'coeur';

  const nom = normalizeDocName(documentName);
  for (const [marqueur, bloc] of MARQUEURS) {
    if (nom.includes(marqueur)) return bloc;
  }
  return 'coeur';
}
