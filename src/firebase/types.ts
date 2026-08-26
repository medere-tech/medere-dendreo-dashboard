// src/firebase/types.ts — Modèle Firestore typé (conforme à docs/firestore-model.md).

import type { AttestationBloc } from '../core/attestation-name';

export type SignatureStatus = 'signed' | 'pending';

/** Signées / total d'un bloc pédagogique (S18 — onglet Sheet à cheval 26/27). */
export interface BlocCounts {
  signes: number;
  total: number;
}

/** Compteurs par session (cf. docs/signature-rule.md §4). Invariant: signes+nonSignes==envoyes. */
export interface Counts {
  envoyes: number;
  signes: number;
  nonSignes: number;
  participantsConcernes: number;
  participantsARelancer: number;
  // --- S18 : ventilation par BLOC (amont+cœur vs aval) ------------------------
  // Le bloc est DÉRIVÉ de `documentName` à chaque recalc (cf. recalcSessionCounts),
  // jamais lu depuis le champ `bloc` persisté → aucune migration du miroir requise.
  // Invariant : amontCoeur.total + aval.total === envoyes.
  /** Attestations dont le bloc N'EST PAS 'aval' (amont + cœur, dont les noms sans marqueur). */
  amontCoeur: BlocCounts;
  /** Attestations dont le bloc est 'aval'. */
  aval: BlocCounts;
}

/** Document `sessions/{idAdf}`. */
export interface SessionDoc {
  idAdf: string;
  numeroComplet: string;
  numeroSessionDpc: string | null; // "26.001" — N° de session DPC (Dendreo: num_session_dpc, null si non-DPC)
  numeroCompteProduit: string | null; // "92622626015" — N° compte produit / action DPC (Dendreo: numero_comptable, optionnel)
  intitule: string;
  dateDebut: string;
  dateFin: string;
  idEtapeProcess: string;
  etape: string;
  idCentre: string;
  type: string;
  totalParticipants: number;
  // --- Enrichissement S5.1b (cf. docs/recon-s5-findings.md) -------------------
  format: string; // libellé Format depuis mode_organisation (Présentiel/Mixte/E-learning/Classe virtuelle)
  aCheval: boolean; // année(dateDebut) != année(dateFin)
  /**
   * S18 — facturable au titre de l'ANNÉE N : TOUS les modules non-aval (catégorie != 21)
   * ont leur `date_fin` strictement passée (jour Paris). Calculé pour TOUTES les sessions ;
   * c'est l'onglet Sheet à cheval qui décide de l'afficher. `false` par défaut : aucun
   * module lu, lecture LAM KO, que des modules aval, ou une date_fin illisible → false.
   */
  facturableAnneeN: boolean;
  eppAmontConnecte: boolean; // module id_categorie_module=22 avec heures connectées > 0
  eppAvalConnecte: boolean; // module id_categorie_module=21 avec heures connectées > 0
  eligibleDpc: boolean; // eligible_dpc="1" du module cœur (S6.2)
  aEpp: boolean; // ∃ module EPP (cat 22 ou 21) dans la session
  // --- Enrichissement S12.1 : dates des séances synchrones -------------------
  datesSynchrones: string[]; // jours ISO "AAAA-MM-JJ" des créneaux des LAM elearning_sync, dédupliqués + triés ; [] si aucun
  // --- Enrichissement S11.1 : FINANCEMENTS (V2) + FACTURES (V3) ---------------
  financeurAndpc: boolean; // ∃ ligne financements.id_financeur=360 (ANDPC)
  montantAndpc: number | null; // Σ montant_finance des lignes 360 UNIQUEMENT ; null si aucune
  factureDateEnvoi: string | null; // plus ancienne date_envoi des factures id_opca=360 (jour Paris) ; null si aucune
  factureMontantHt: number | null; // Σ montant_total_ht des factures id_opca=360 ; null si aucune
  factureDatePaiement: string | null; // plus récente date_paiement des factures id_opca=360 (jour Paris) ; null si aucune/impayé
  // --- S15 : FACTURE 1 / FACTURE 2 des sessions À CHEVAL ----------------------
  // Factures ANDPC triées par date_emission croissante (départage id_facture) :
  // position 1 = budget de l'année de DÉBUT, position 2 = budget de l'année de FIN.
  // TOUS null si la session n'est PAS à cheval. Facture 2 null si une seule facture.
  // N'affecte pas factureMontantHt (montant payé), qui reste l'agrégat des payées.
  facture1DateEnvoi: string | null;
  facture1DatePaiement: string | null;
  facture2DateEnvoi: string | null;
  facture2DatePaiement: string | null;
  counts: Counts;
  oldestPendingSentDate: string | null;
  lastSyncedAt: string;
  source: 'dendreo';
}

/** Document `signatures/{idAdf}_{idParticipant}_{doctypeId}` (une ATTESTATION). */
export interface SignatureDoc {
  idAdf: string;
  idParticipant: string;
  doctypeId: string;
  documentName: string; // nom du document (commence par "Attestation")
  /**
   * S18 — bloc pédagogique déduit du `documentName` (classifyAttestationBloc).
   * Sert à l'AFFICHAGE par ligne et aux futurs `where('bloc','==',…)`. Les agrégats
   * `counts.amontCoeur` / `counts.aval` ne le lisent PAS : ils re-dérivent depuis
   * `documentName`, pour que les docs écrits avant S18 soient comptés sans migration.
   */
  bloc: AttestationBloc; // 'amont' | 'coeur' | 'aval'
  nom: string;
  status: SignatureStatus; // "signed" | "pending" (plus de "notSent")
  signatureDate: string | null;
  sentDate: string | null;
  viewerUrl: string | null;
  financeurAndpc: boolean | null; // S11.1 : true=ANDPC(360) | false=autre financeur | null=aucun financement rattaché
  commercial: string | null; // S13.1 : "Prénom NOM" du commercial de l'inscription (laps.commercial_id → administrateurs.php) ; null si absent/non résolu
  assidu: boolean | null; // S14 : laps.presence==='OUI' (a suivi jusqu'au bout) | false ('INC.' pas fini, 'NON' no-show) | null=inconnu
  inscrit: boolean | null; // S14 : laps.first_lam_inscrit_id non vide | false=DÉSINSCRIT (aucun module) | null=inconnu
  sessionNumeroComplet: string;
  sessionIntitule: string;
  sessionDateDebut: string;
  lastSyncedAt: string;
}

/** Entrée d'upsert session (la couche ajoute source + lastSyncedAt ; counts/oldest = recalc). */
export type SessionUpsertInput = Omit<SessionDoc, 'counts' | 'oldestPendingSentDate' | 'lastSyncedAt' | 'source'>;

/** Entrée d'upsert signature (la couche ajoute lastSyncedAt). */
export type SignatureUpsertInput = Omit<SignatureDoc, 'lastSyncedAt'>;
