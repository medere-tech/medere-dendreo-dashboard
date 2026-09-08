// src/reco/exclusion.ts — Sessions à NE PAS resynchroniser (pur, testable).
//
// POURQUOI : le backfill appelle 5 endpoints Dendreo par session (fichiers.php,
// lams.php, financements.php, factures.php, laps.php). Deux familles de sessions
// n'ont plus rien à apprendre de Dendreo ; les écarter AVANT `processSession`
// économise leurs 5 appels d'un coup.
//
//   A « payée »    : le dossier est soldé (montant payé > 0 + date de paiement).
//                    À cheval = 2 factures : c'est la facture 2 (budget de
//                    l'année de FIN) qui solde — la facture 1 payée ne suffit PAS.
//   B « ancienne » : session NON à cheval commencée à l'année plancher ou avant.
//                    Bornée aux NON à cheval : une session à cheval 2025/2026 vit
//                    encore en 2026 et ne doit JAMAIS être figée par l'ancienneté.
//
// Aucun I/O ici : `session` vient de mapSession (ADF-only, connu avant tout appel)
// et `miroir` du préchargement Firestore fait une fois par run (cf. backfill.mjs).

import { RECO_START_YEAR } from './years';

/**
 * Seuil de la règle B. Aligné sur RECO_START_YEAR : le backfill ne réconcilie
 * rien avant cette année, donc une session NON à cheval qui y commence est figée.
 * ⚠ Les DEUX constantes se remontent ENSEMBLE (test de cohérence dédié).
 */
export const ANNEE_ANCIENNE_MAX = RECO_START_YEAR;

/** Ce que mapSession sait AVANT tout appel par session (ADF-only). */
export interface SessionAExclure {
  aCheval: boolean;
  dateDebut: string; // ISO naïf ; '' si absente côté Dendreo
}

/** Les 3 champs relus du miroir (écrits la nuit précédente). */
export interface MiroirFacture {
  factureMontantHt: number | null;
  factureDatePaiement: string | null;
  facture2DatePaiement: string | null;
}

/** Motif d'exclusion, ou null si la session doit être traitée. */
export type MotifExclusion = 'payee' | 'ancienne' | null;

/** « Renseignée » = chaîne non vide après trim. Tout autre type → false (défensif :
 *  un doc miroir mal formé ne doit JAMAIS provoquer une exclusion). */
const rempli = (v: unknown): boolean => typeof v === 'string' && v.trim() !== '';

/** Montant strictement positif. Tout autre type (dont '2400' en string) → false. */
const montantPositif = (v: unknown): boolean =>
  typeof v === 'number' && Number.isFinite(v) && v > 0;

/** Année d'une date ISO naïve ; null si illisible/absente (JAMAIS devinée). */
function annee(v: string): number | null {
  const a = Number(String(v ?? '').slice(0, 4));
  return Number.isInteger(a) && a > 1900 ? a : null;
}

/**
 * Motif d'exclusion d'une session, ou `null` si elle doit être traitée.
 *
 * - `miroir` à `undefined` = session inconnue du miroir (jamais synchronisée) :
 *   la règle A ne s'applique PAS — on ne suppose pas qu'une session jamais vue
 *   est payée. La règle B, elle, reste évaluable (elle ne dépend que de l'ADF).
 * - `dateDebut` vide ou illisible → règle B inapplicable → session traitée.
 * - A est testée en premier : si les deux règles sont vraies, le motif rapporté
 *   est 'payee' (motif stable, pour que les compteurs de log ne dérivent pas).
 */
export function estSessionExclue(
  session: SessionAExclure,
  miroir: MiroirFacture | undefined,
): MotifExclusion {
  if (miroir) {
    // aCheval choisit QUEL champ de date solde le dossier — pas SI la règle A
    // s'applique : une session à cheval dont la facture 2 est payée est exclue.
    const paiement = session.aCheval ? miroir.facture2DatePaiement : miroir.factureDatePaiement;
    if (montantPositif(miroir.factureMontantHt) && rempli(paiement)) return 'payee';
  }

  const an = annee(session.dateDebut);
  if (!session.aCheval && an !== null && an <= ANNEE_ANCIENNE_MAX) return 'ancienne';

  return null;
}
