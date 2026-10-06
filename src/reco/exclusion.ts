// src/reco/exclusion.ts — Sessions à NE PAS resynchroniser (pur, testable).
//
// POURQUOI : le backfill appelle 5 endpoints Dendreo par session (fichiers.php,
// lams.php, financements.php, factures.php, laps.php). Deux familles de sessions
// n'ont plus rien à apprendre de Dendreo ; les écarter AVANT `processSession`
// économise leurs 5 appels d'un coup.
//
//   A « payée »    : le dossier est soldé (montant payé > 0 + date de paiement)
//                    DEPUIS PLUS DE FENETRE_PAIEMENT_RECENT_JOURS. Une session payée
//                    RÉCEMMENT reste dans le cron : d'autres dashboards lisent les
//                    onglets et ont besoin de données fraîches juste après paiement
//                    (mesure validée : N = 90 jours, sous le plafond 120 000/mois).
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

/**
 * Règle A : un paiement daté d'AU PLUS ce nombre de jours est « récent » → la session
 * reste dans le cron. Strictement au-delà (> 90 j) → exclue. 90 j pile = gardée.
 */
export const FENETRE_PAIEMENT_RECENT_JOURS = 90;

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
const rempli = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** Montant strictement positif. Tout autre type (dont '2400' en string) → false. */
const montantPositif = (v: unknown): boolean =>
  typeof v === 'number' && Number.isFinite(v) && v > 0;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Écart en jours calendaires `today − date` entre deux jours naïfs "AAAA-MM-JJ"
 * (slice 0,10). Date.UTC sur les composantes = arithmétique de calendrier, AUCUN fuseau
 * (jamais `new Date(iso)`, qui interpréterait la date naïve en UTC). null si illisible.
 */
function ecartJours(today: string, date: string): number | null {
  const ta = jourUtc(today);
  const tb = jourUtc(date);
  return ta === null || tb === null ? null : Math.round((ta - tb) / 86_400_000);
}

/** Timestamp UTC minuit d'un jour naïf, ou null s'il n'EXISTE pas au calendrier.
 *  Aller-retour obligatoire : sans lui, "0000-00-00" (date zéro MySQL) ou "2026-02-31"
 *  seraient « normalisés » par Date.UTC en une vraie date → fausse exclusion. */
function jourUtc(v: string): number | null {
  const d = String(v ?? '').trim().slice(0, 10);
  if (!ISO_DAY.test(d) || Number(d.slice(0, 4)) <= 1900) return null;
  const t = Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d ? t : null;
}

/** Paiement ANCIEN = strictement plus de FENETRE_PAIEMENT_RECENT_JOURS jours.
 *  Illisible, `today` invalide ou date FUTURE → false (défaut sûr : on garde dans le cron). */
function paiementAncien(today: string, datePaiement: string): boolean {
  const ecart = ecartJours(today, datePaiement);
  return ecart !== null && ecart > FENETRE_PAIEMENT_RECENT_JOURS;
}

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
 * - Règle A seulement si le paiement est ANCIEN (> FENETRE_PAIEMENT_RECENT_JOURS) ;
 *   payée récemment, date illisible ou future → A ne s'applique pas (B reste évaluée).
 * - A est testée en premier : si les deux règles sont vraies, le motif rapporté
 *   est 'payee' (motif stable, pour que les compteurs de log ne dérivent pas).
 * @param today jour de référence "AAAA-MM-JJ" (jour Paris), INJECTÉ par l'appelant →
 *              déterministe. Invalide → aucun paiement n'est « ancien » → A inactive.
 */
export function estSessionExclue(
  session: SessionAExclure,
  miroir: MiroirFacture | undefined,
  today: string,
): MotifExclusion {
  if (miroir) {
    // aCheval choisit QUEL champ de date solde le dossier — pas SI la règle A
    // s'applique : une session à cheval dont la facture 2 est payée est exclue.
    const paiement = session.aCheval ? miroir.facture2DatePaiement : miroir.factureDatePaiement;
    if (montantPositif(miroir.factureMontantHt) && rempli(paiement) && paiementAncien(today, paiement)) {
      return 'payee';
    }
  }

  const an = annee(session.dateDebut);
  if (!session.aCheval && an !== null && an <= ANNEE_ANCIENNE_MAX) return 'ancienne';

  return null;
}
