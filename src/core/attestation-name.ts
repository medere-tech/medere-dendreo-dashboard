// src/core/attestation-name.ts — Lecture du NOM d'un document d'attestation.
//
// Module NEUTRE et PUR : il n'importe RIEN (ni Dendreo, ni Firebase, ni Node).
// C'est délibéré — il est consommé par les DEUX couches :
//   - `src/dendreo/` (règle signature : quel fichier est une attestation trackée) ;
//   - `src/firebase/` (recalcSessionCounts : agrégats par bloc).
// Le placer ici évite que la couche Firestore importe la couche Dendreo.
//
// (Nommé `core/` et non `shared/` : l'alias Next `@shared/*` pointe déjà sur `src/*`,
//  un dossier `src/shared/` donnerait des imports `@shared/shared/...` côté web.)

/** minuscules + sans accents + trim (pour le préfixe "attestation"). */
export function normalizeDocName(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

// ---------------------------------------------------------------------------
// Bloc pédagogique (brique 1) — D'APRÈS LE NOM DU DOCUMENT
// ---------------------------------------------------------------------------
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
