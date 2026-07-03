import { collection, orderBy, query, where, type Firestore, type Query, type DocumentData } from 'firebase/firestore';

/**
 * Miroir client de `sessions/{idAdf}` et `signatures/{...}` (cf.
 * docs/firestore-model.md + docs/signature-rule.md — ce dernier fait autorité).
 * Lecture seule côté UI ; l'écriture est faite par la couche serveur (Admin SDK).
 */

/**
 * Compteurs par session (signature-rule.md §4). L'unité de suivi est
 * l'ATTESTATION (un participant peut en avoir plusieurs par session), d'où la
 * distinction documents ↔ participants. Invariant : `signes + nonSignes == envoyes`.
 */
export interface Counts {
  envoyes: number; // attestations trackées réellement envoyées
  signes: number; // parmi envoyées, signées
  nonSignes: number; // = envoyes − signes (à relancer)
  participantsConcernes: number; // participants distincts avec ≥ 1 attestation
  participantsARelancer: number; // participants distincts avec ≥ 1 attestation non signée
}

export interface SessionDoc {
  idAdf: string;
  numeroComplet: string;
  numeroSessionDpc: string | null; // null si session non-DPC
  numeroCompteProduit: string | null;
  intitule: string;
  dateDebut: string;
  dateFin: string;
  idEtapeProcess: string;
  etape: string;
  idCentre: string;
  type: string;
  totalParticipants: number;
  counts: Counts;
  oldestPendingSentDate: string | null;
  lastSyncedAt: string;
  source: string;
}

export type SignatureStatus = 'signed' | 'pending';

/** Document `signatures/{idAdf}_{idParticipant}_{doctypeId}` — une ATTESTATION. */
export interface SignatureDoc {
  idAdf: string;
  idParticipant: string;
  doctypeId: string;
  documentName: string;
  nom: string;
  status: SignatureStatus;
  signatureDate: string | null;
  sentDate: string | null;
  viewerUrl: string | null;
  sessionNumeroComplet: string;
  sessionIntitule: string;
  sessionDateDebut: string;
  lastSyncedAt: string;
}

/** Filtre du drawer : quel chiffre a été cliqué. */
export type SignatureFilter = 'envoyes' | 'signes' | 'nonSignes';

export const SIGNATURE_FILTER_LABELS: Record<SignatureFilter, string> = {
  envoyes: 'Envoyés',
  signes: 'Signés',
  nonSignes: 'À relancer',
};

/** Compteur session correspondant à un filtre (pour l'entête du drawer). */
export function countForFilter(counts: Counts, filter: SignatureFilter): number {
  return filter === 'signes' ? counts.signes : filter === 'nonSignes' ? counts.nonSignes : counts.envoyes;
}

/**
 * Working set 2026 : plage lexicographique sur `numeroComplet`
 * ("ADF_2026xxxx"). Fiable (toujours présent), aucun index composite requis.
 */
export function sessions2026Query(db: Firestore): Query<DocumentData> {
  return query(
    collection(db, 'sessions'),
    where('numeroComplet', '>=', 'ADF_2026'),
    where('numeroComplet', '<', 'ADF_2027'),
  );
}

/**
 * Attestations d'une session pour le drawer (one-shot `getDocs`, pas de listener).
 * `signes`/`nonSignes` ajoutent le filtre `status` (index composite idAdf+status
 * déclaré, cf. firestore-model.md §2) ; `envoyes` = toutes.
 */
export function signaturesForSessionQuery(db: Firestore, idAdf: string, filter: SignatureFilter): Query<DocumentData> {
  const base = collection(db, 'signatures');
  if (filter === 'signes') return query(base, where('idAdf', '==', idAdf), where('status', '==', 'signed'));
  if (filter === 'nonSignes') return query(base, where('idAdf', '==', idAdf), where('status', '==', 'pending'));
  return query(base, where('idAdf', '==', idAdf));
}

/**
 * Vue transverse « À relancer » (ui-spec.md §4.2) : toutes les attestations
 * NON SIGNÉES, triées par ancienneté (plus vieux d'abord). Index composite
 * `signatures(status ASC, sentDate ASC)` — confirmé ENABLED.
 */
export function pendingSignaturesQuery(db: Firestore): Query<DocumentData> {
  return query(collection(db, 'signatures'), where('status', '==', 'pending'), orderBy('sentDate', 'asc'));
}

/**
 * Toutes les sessions (tous millésimes) → index en mémoire pour la jointure de
 * la vue « À relancer » : exclusion des sessions en « Echec » + `numeroSessionDpc`
 * (absent du doc signature). Le working set 2026 du cockpit ne suffit pas ici.
 */
export function allSessionsQuery(db: Firestore): Query<DocumentData> {
  return query(collection(db, 'sessions'));
}
