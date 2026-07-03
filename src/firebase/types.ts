// src/firebase/types.ts — Modèle Firestore typé (conforme à docs/firestore-model.md).

export type SignatureStatus = 'signed' | 'pending';

/** Compteurs par session (cf. docs/signature-rule.md §4). Invariant: signes+nonSignes==envoyes. */
export interface Counts {
  envoyes: number;
  signes: number;
  nonSignes: number;
  participantsConcernes: number;
  participantsARelancer: number;
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
  nom: string;
  status: SignatureStatus; // "signed" | "pending" (plus de "notSent")
  signatureDate: string | null;
  sentDate: string | null;
  viewerUrl: string | null;
  sessionNumeroComplet: string;
  sessionIntitule: string;
  sessionDateDebut: string;
  lastSyncedAt: string;
}

/** Entrée d'upsert session (la couche ajoute source + lastSyncedAt ; counts/oldest = recalc). */
export type SessionUpsertInput = Omit<SessionDoc, 'counts' | 'oldestPendingSentDate' | 'lastSyncedAt' | 'source'>;

/** Entrée d'upsert signature (la couche ajoute lastSyncedAt). */
export type SignatureUpsertInput = Omit<SignatureDoc, 'lastSyncedAt'>;
