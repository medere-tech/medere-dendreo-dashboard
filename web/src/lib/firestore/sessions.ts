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
  format: string; // libellé Format (Présentiel/Mixte/E-learning/Classe virtuelle) — S5.1b
  aCheval: boolean; // année(dateDebut) != année(dateFin)
  eppAmontConnecte: boolean; // module EPP amont (cat 22) avec heures connectées > 0
  eppAvalConnecte: boolean; // module EPP aval (cat 21) avec heures connectées > 0
  counts: Counts;
  oldestPendingSentDate: string | null;
  lastSyncedAt: string;
  source: string;
}

/** Compteurs neutres : appliqués quand `counts` est absent/partiel (ex. session
 *  écrite par un backfill interrompu par le quota, avant `recalcSessionCounts`). */
export const EMPTY_COUNTS: Counts = {
  envoyes: 0,
  signes: 0,
  nonSignes: 0,
  participantsConcernes: 0,
  participantsARelancer: 0,
};

// --- Normalisation à la LECTURE (défensif) -----------------------------------
// Le miroir peut contenir des docs incomplets (backfill partiel). L'UI ne doit
// ni crasher ni fausser : un doc incomplet est normalisé (0 partout, null-safe).
const asStr = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const asNullableStr = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const asNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const asBool = (v: unknown): boolean => v === true; // défaut false pour un doc pré-S5.1b

function normalizeCounts(raw: unknown): Counts {
  const c = (raw ?? {}) as Partial<Record<keyof Counts, unknown>>;
  return {
    envoyes: asNum(c.envoyes),
    signes: asNum(c.signes),
    nonSignes: asNum(c.nonSignes),
    participantsConcernes: asNum(c.participantsConcernes),
    participantsARelancer: asNum(c.participantsARelancer),
  };
}

/**
 * Normalise un doc Firestore brut en `SessionDoc` sûr : `counts` TOUJOURS complet
 * (même si absent → 0 partout), `numeroSessionDpc`/`numeroCompteProduit`/
 * `oldestPendingSentDate` null-safe. Aucun accès aval ne peut plus lire un champ
 * `undefined`. À utiliser à CHAQUE lecture de la collection `sessions`.
 */
export function toSessionDoc(raw: DocumentData): SessionDoc {
  return {
    idAdf: asStr(raw.idAdf),
    numeroComplet: asStr(raw.numeroComplet),
    numeroSessionDpc: asNullableStr(raw.numeroSessionDpc),
    numeroCompteProduit: asNullableStr(raw.numeroCompteProduit),
    intitule: asStr(raw.intitule),
    dateDebut: asStr(raw.dateDebut),
    dateFin: asStr(raw.dateFin),
    idEtapeProcess: asStr(raw.idEtapeProcess),
    etape: asStr(raw.etape),
    idCentre: asStr(raw.idCentre),
    type: asStr(raw.type),
    totalParticipants: asNum(raw.totalParticipants),
    format: asStr(raw.format),
    aCheval: asBool(raw.aCheval),
    eppAmontConnecte: asBool(raw.eppAmontConnecte),
    eppAvalConnecte: asBool(raw.eppAvalConnecte),
    counts: normalizeCounts(raw.counts),
    oldestPendingSentDate: asNullableStr(raw.oldestPendingSentDate),
    lastSyncedAt: asStr(raw.lastSyncedAt),
    source: asStr(raw.source),
  };
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

/** Normalise un doc `signatures/*` brut en `SignatureDoc` sûr (défensif, null-safe). */
export function toSignatureDoc(raw: DocumentData): SignatureDoc {
  const status: SignatureStatus = raw.status === 'signed' ? 'signed' : 'pending';
  return {
    idAdf: asStr(raw.idAdf),
    idParticipant: asStr(raw.idParticipant),
    doctypeId: asStr(raw.doctypeId),
    documentName: asStr(raw.documentName),
    nom: asStr(raw.nom),
    status,
    signatureDate: asNullableStr(raw.signatureDate),
    sentDate: asNullableStr(raw.sentDate),
    viewerUrl: asNullableStr(raw.viewerUrl),
    sessionNumeroComplet: asStr(raw.sessionNumeroComplet),
    sessionIntitule: asStr(raw.sessionIntitule),
    sessionDateDebut: asStr(raw.sessionDateDebut),
    lastSyncedAt: asStr(raw.lastSyncedAt),
  };
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
 * Toute la collection sessions. Utilisée par :
 *  - le cockpit (working set en mémoire ; l'année se lit sur `dateDebut/dateFin`,
 *    jamais sur `numeroComplet` = année de création) ;
 *  - la vue « À relancer » (index de jointure : exclusion « Echec » +
 *    `numeroSessionDpc`, absent du doc signature).
 * Le miroir ne contient que 2025–2026 (backfill par started_after).
 */
export function allSessionsQuery(db: Firestore): Query<DocumentData> {
  return query(collection(db, 'sessions'));
}
