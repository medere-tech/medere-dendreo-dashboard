// src/firebase/firestore.ts — Couche de données Firestore typée (écriture serveur).
// Idempotent (clés déterministes + merge, last-write-wins). Validation stricte des
// entrées (aucun undefined silencieux). Recalcul des counts en TRANSACTION.

import type { Query } from 'firebase-admin/firestore';
import { getDb } from './admin';
import { sessionKey, signatureKey } from './keys';
import type {
  Counts,
  SessionDoc,
  SessionUpsertInput,
  SignatureDoc,
  SignatureStatus,
  SignatureUpsertInput,
} from './types';

const SESSIONS = 'sessions';
const SIGNATURES = 'signatures';
const STATUSES: readonly SignatureStatus[] = ['signed', 'pending', 'notSent'];

const nowIso = (): string => new Date().toISOString();

// --- Validation (messages = NOMS de champs, jamais de valeurs PII) -----------
function assertString(v: unknown, name: string): asserts v is string {
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`Champ requis manquant/vide : ${name}`);
}
function assertNumber(v: unknown, name: string): asserts v is number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`Champ numérique invalide : ${name}`);
}
function assertNullableString(v: unknown, name: string): asserts v is string | null {
  if (v !== null && typeof v !== 'string') throw new Error(`Champ doit être string|null : ${name}`);
}
function assertStatus(v: unknown): asserts v is SignatureStatus {
  if (typeof v !== 'string' || !STATUSES.includes(v as SignatureStatus)) throw new Error(`status invalide (attendu signed|pending|notSent) : ${String(v)}`);
}

function validateSessionInput(s: SessionUpsertInput): void {
  assertString(s.idAdf, 'idAdf');
  assertString(s.numeroComplet, 'numeroComplet');
  assertString(s.intitule, 'intitule');
  assertString(s.dateDebut, 'dateDebut');
  assertString(s.dateFin, 'dateFin');
  assertString(s.idEtapeProcess, 'idEtapeProcess');
  assertString(s.etape, 'etape');
  assertString(s.idCentre, 'idCentre');
  assertString(s.type, 'type');
  assertNumber(s.totalParticipants, 'totalParticipants');
}

function validateSignatureInput(s: SignatureUpsertInput): void {
  assertString(s.idAdf, 'idAdf');
  assertString(s.idParticipant, 'idParticipant');
  assertString(s.doctypeId, 'doctypeId');
  assertString(s.nom, 'nom');
  assertString(s.sessionNumeroComplet, 'sessionNumeroComplet');
  assertString(s.sessionIntitule, 'sessionIntitule');
  assertString(s.sessionDateDebut, 'sessionDateDebut');
  assertStatus(s.status);
  assertNullableString(s.signatureDate, 'signatureDate');
  assertNullableString(s.sentDate, 'sentDate');
  assertNullableString(s.viewerUrl, 'viewerUrl');
  // cohérence statut <-> dates
  if (s.status === 'signed' && !s.signatureDate) throw new Error('Incohérence : status=signed sans signatureDate');
  if (s.status === 'pending' && !s.sentDate) throw new Error('Incohérence : status=pending sans sentDate');
  if (s.status === 'notSent' && (s.signatureDate || s.sentDate)) throw new Error('Incohérence : status=notSent avec une date');
}

// --- Upserts (merge → idempotents, last-write-wins) --------------------------
export async function upsertSession(input: SessionUpsertInput): Promise<void> {
  validateSessionInput(input);
  const ref = getDb().collection(SESSIONS).doc(sessionKey(input.idAdf));
  const data = { ...input, source: 'dendreo' as const, lastSyncedAt: nowIso() };
  await ref.set(data, { merge: true }); // ne touche pas counts/oldestPendingSentDate (recalc séparé)
}

export async function upsertSignature(input: SignatureUpsertInput): Promise<void> {
  validateSignatureInput(input);
  const ref = getDb().collection(SIGNATURES).doc(signatureKey(input.idAdf, input.idParticipant, input.doctypeId));
  const data: SignatureDoc = { ...input, lastSyncedAt: nowIso() };
  await ref.set(data, { merge: true });
}

// --- Lectures ----------------------------------------------------------------
export async function getSession(idAdf: string): Promise<SessionDoc | null> {
  const snap = await getDb().collection(SESSIONS).doc(sessionKey(idAdf)).get();
  return snap.exists ? (snap.data() as SessionDoc) : null;
}

export async function listSignaturesByStatus(
  status: SignatureStatus,
  options: { idAdf?: string } = {},
): Promise<SignatureDoc[]> {
  assertStatus(status);
  const col = getDb().collection(SIGNATURES);
  let query: Query = col.where('status', '==', status);
  if (options.idAdf) {
    query = query.where('idAdf', '==', options.idAdf); // index idAdf+status
  } else {
    query = query.orderBy('sentDate', 'asc'); // index status+sentDate (à relancer par ancienneté)
  }
  const snap = await query.get();
  return snap.docs.map((d) => d.data() as SignatureDoc);
}

// --- Recalcul agrégat de la session (TRANSACTION, atomique) ------------------
export async function recalcSessionCounts(idAdf: string): Promise<{ counts: Counts; oldestPendingSentDate: string | null }> {
  assertString(idAdf, 'idAdf');
  const db = getDb();
  const sessionRef = db.collection(SESSIONS).doc(sessionKey(idAdf));
  const sigQuery = db.collection(SIGNATURES).where('idAdf', '==', idAdf);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(sigQuery);
    const counts: Counts = { signed: 0, pending: 0, notSent: 0 };
    let oldestPendingSentDate: string | null = null;

    snap.forEach((doc) => {
      const status = doc.get('status') as SignatureStatus;
      if (status === 'signed') counts.signed += 1;
      else if (status === 'notSent') counts.notSent += 1;
      else if (status === 'pending') {
        counts.pending += 1;
        const sd = doc.get('sentDate');
        if (typeof sd === 'string' && (oldestPendingSentDate === null || sd < oldestPendingSentDate)) {
          oldestPendingSentDate = sd; // ISO → comparaison lexicographique = chronologique
        }
      }
    });

    tx.set(sessionRef, { counts, oldestPendingSentDate, lastSyncedAt: nowIso() }, { merge: true });
    return { counts, oldestPendingSentDate };
  });
}
