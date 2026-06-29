// src/firebase/types.ts — Modèle Firestore typé (conforme à docs/firestore-model.md).

export type SignatureStatus = 'signed' | 'pending' | 'notSent';

export interface Counts {
  signed: number;
  pending: number;
  notSent: number;
}

/** Document `sessions/{idAdf}`. */
export interface SessionDoc {
  idAdf: string;
  numeroComplet: string;
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

/** Document `signatures/{idAdf}_{idParticipant}_{doctypeId}`. */
export interface SignatureDoc {
  idAdf: string;
  idParticipant: string;
  doctypeId: string;
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

/** Entrée d'upsert session (la couche ajoute source + lastSyncedAt ; counts/oldest = recalc). */
export type SessionUpsertInput = Omit<SessionDoc, 'counts' | 'oldestPendingSentDate' | 'lastSyncedAt' | 'source'>;

/** Entrée d'upsert signature (la couche ajoute lastSyncedAt). */
export type SignatureUpsertInput = Omit<SignatureDoc, 'lastSyncedAt'>;
