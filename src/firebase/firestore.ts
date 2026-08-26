// src/firebase/firestore.ts — Couche de données Firestore typée (écriture serveur).
// Idempotent (clés déterministes + merge, last-write-wins). Validation stricte des
// entrées (aucun undefined silencieux). Recalcul des counts en TRANSACTION.

import type { Query } from 'firebase-admin/firestore';
import { classifyAttestationBloc, type AttestationBloc } from '../core/attestation-name';
import { getDb } from './admin';
import { sessionKey, signatureKey } from './keys';
import type {
  BlocCounts,
  Counts,
  SessionDoc,
  SessionUpsertInput,
  SignatureDoc,
  SignatureStatus,
  SignatureUpsertInput,
} from './types';

const SESSIONS = 'sessions';
const SIGNATURES = 'signatures';
const STATUSES: readonly SignatureStatus[] = ['signed', 'pending'];
const BLOCS: readonly AttestationBloc[] = ['amont', 'coeur', 'aval'];

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
function assertNullableNumber(v: unknown, name: string): asserts v is number | null {
  if (v !== null && (typeof v !== 'number' || !Number.isFinite(v))) throw new Error(`Champ doit être number|null : ${name}`);
}
function assertNullableBoolean(v: unknown, name: string): asserts v is boolean | null {
  if (v !== null && typeof v !== 'boolean') throw new Error(`Champ doit être boolean|null : ${name}`);
}
/** String tolérante : type string exigé, mais valeur VIDE acceptée (champ "mou",
 *  non identitaire). Sert à ne jamais rejeter une session sur un champ secondaire. */
function assertStringType(v: unknown, name: string): asserts v is string {
  if (typeof v !== 'string') throw new Error(`Champ doit être une string : ${name}`);
}
function assertBoolean(v: unknown, name: string): asserts v is boolean {
  if (typeof v !== 'boolean') throw new Error(`Champ doit être un booléen : ${name}`);
}
/** Tableau de strings (défensif) : type array exigé, chaque élément string. Vide [] toléré. */
function assertStringArray(v: unknown, name: string): asserts v is string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new Error(`Champ doit être string[] : ${name}`);
}
function assertStatus(v: unknown): asserts v is SignatureStatus {
  if (typeof v !== 'string' || !STATUSES.includes(v as SignatureStatus)) throw new Error(`status invalide (attendu signed|pending) : ${String(v)}`);
}
/** S18 : `bloc` vient de classifyAttestationBloc, qui ne peut renvoyer que ces 3 valeurs.
 *  Tout autre valeur = un mapper a oublié le champ → on échoue BRUYAMMENT plutôt que
 *  d'écrire un `undefined` (que firebase-admin refuserait de toute façon plus loin). */
function assertBloc(v: unknown): asserts v is AttestationBloc {
  if (typeof v !== 'string' || !BLOCS.includes(v as AttestationBloc)) throw new Error(`bloc invalide (attendu amont|coeur|aval) : ${String(v)}`);
}

function validateSessionInput(s: SessionUpsertInput): void {
  // SEULS champs strictement requis (non vides) = l'IDENTITÉ de la session :
  //   - idAdf (clé Firestore) + numeroComplet (clé humaine).
  // Tout le reste est TOLÉRÉ (string éventuellement vide, ou null) : une session
  // ne doit JAMAIS être perdue à cause d'un champ secondaire absent (même
  // philosophie que numeroSessionDpc nullable). Le mapper fournit des défauts sûrs.
  assertString(s.idAdf, 'idAdf');
  assertString(s.numeroComplet, 'numeroComplet');
  assertNullableString(s.numeroSessionDpc, 'numeroSessionDpc'); // null si session non-DPC
  assertNullableString(s.numeroCompteProduit, 'numeroCompteProduit');
  assertStringType(s.intitule, 'intitule');
  assertStringType(s.dateDebut, 'dateDebut');
  assertStringType(s.dateFin, 'dateFin');
  assertStringType(s.idEtapeProcess, 'idEtapeProcess');
  assertStringType(s.etape, 'etape');
  assertStringType(s.idCentre, 'idCentre');
  assertStringType(s.type, 'type');
  assertStringType(s.format, 'format'); // libellé Format, toléré vide
  assertBoolean(s.aCheval, 'aCheval');
  assertBoolean(s.facturableAnneeN, 'facturableAnneeN'); // S18 : dérivé des date_fin des modules non-aval
  assertBoolean(s.eppAmontConnecte, 'eppAmontConnecte');
  assertBoolean(s.eppAvalConnecte, 'eppAvalConnecte');
  assertBoolean(s.eligibleDpc, 'eligibleDpc');
  assertBoolean(s.aEpp, 'aEpp');
  assertStringArray(s.datesSynchrones, 'datesSynchrones'); // S12.1 : [] toléré, jamais bloquant
  assertNumber(s.totalParticipants, 'totalParticipants');
  // S11.1 : financements (V2) + factures (V3) — champs "mous", jamais bloquants.
  assertBoolean(s.financeurAndpc, 'financeurAndpc');
  assertNullableNumber(s.montantAndpc, 'montantAndpc');
  assertNullableString(s.factureDateEnvoi, 'factureDateEnvoi');
  assertNullableNumber(s.factureMontantHt, 'factureMontantHt');
  assertNullableString(s.factureDatePaiement, 'factureDatePaiement');
  // S15 : facture 1/2 des sessions à cheval — champs "mous", jamais bloquants.
  assertNullableString(s.facture1DateEnvoi, 'facture1DateEnvoi');
  assertNullableString(s.facture1DatePaiement, 'facture1DatePaiement');
  assertNullableString(s.facture2DateEnvoi, 'facture2DateEnvoi');
  assertNullableString(s.facture2DatePaiement, 'facture2DatePaiement');
}

function validateSignatureInput(s: SignatureUpsertInput): void {
  // Clés/identité de la ligne : strictement requis (non vides).
  assertString(s.idAdf, 'idAdf');
  assertString(s.idParticipant, 'idParticipant');
  assertString(s.doctypeId, 'doctypeId');
  assertString(s.documentName, 'documentName');
  assertBloc(s.bloc); // S18 : amont|coeur|aval, dérivé du documentName par les mappers
  assertString(s.nom, 'nom');
  // Échos dénormalisés de la session : tolérés (miroir de champs "mous" de session).
  assertStringType(s.sessionNumeroComplet, 'sessionNumeroComplet');
  assertStringType(s.sessionIntitule, 'sessionIntitule');
  assertStringType(s.sessionDateDebut, 'sessionDateDebut');
  assertStatus(s.status);
  assertNullableString(s.signatureDate, 'signatureDate');
  assertNullableString(s.sentDate, 'sentDate');
  assertNullableString(s.viewerUrl, 'viewerUrl');
  assertNullableBoolean(s.financeurAndpc, 'financeurAndpc'); // S11.1 : true|false|null
  assertNullableString(s.commercial, 'commercial'); // S13.1 : "Prénom NOM" | null
  assertNullableBoolean(s.assidu, 'assidu'); // S14 : true|false|null
  assertNullableBoolean(s.inscrit, 'inscrit'); // S14 : true|false|null

  // cohérence statut <-> dates
  if (s.status === 'signed' && !s.signatureDate) throw new Error('Incohérence : status=signed sans signatureDate');
  if (s.status === 'pending' && !s.sentDate) throw new Error('Incohérence : status=pending sans sentDate');
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

// --- Miroir des signatures d'une session (S17.4 : purge des fantômes) --------

/**
 * Une ligne du miroir `signatures` d'une session, accompagnée de SA méthode de
 * suppression — liée au document RÉELLEMENT LU (`doc.ref`), jamais à une clé
 * reconstruite : il est structurellement impossible de supprimer autre chose que
 * le document qu'on vient d'inspecter. (Même garantie que scripts/purge-fantomes.mjs.)
 */
export interface SignatureMirrorEntry {
  key: string; // id du doc = {idAdf}_{idParticipant}_{doctypeId}
  idParticipant: string;
  doctypeId: string;
  status: string; // brut (pas de cast : un status inattendu ne doit PAS ressembler à 'pending')
  nom: string;
  documentName: string;
  signatureDate: string | null;
  /** Supprime EXACTEMENT ce document. IRRÉVERSIBLE. */
  delete(): Promise<void>;
}

/** Lit le miroir `signatures` d'UNE session (index idAdf). Lecture seule. */
export async function listSessionSignatureMirror(idAdf: string): Promise<SignatureMirrorEntry[]> {
  assertString(idAdf, 'idAdf');
  const snap = await getDb().collection(SIGNATURES).where('idAdf', '==', idAdf).get();
  return snap.docs.map((d) => ({
    key: d.id,
    idParticipant: String(d.get('idParticipant') ?? ''),
    doctypeId: String(d.get('doctypeId') ?? ''),
    status: String(d.get('status') ?? ''),
    nom: String(d.get('nom') ?? ''),
    documentName: String(d.get('documentName') ?? ''),
    signatureDate: (d.get('signatureDate') as string | null) ?? null,
    delete: async (): Promise<void> => {
      await d.ref.delete();
    },
  }));
}

// --- Recalcul agrégat de la session (TRANSACTION, atomique) ------------------
export async function recalcSessionCounts(idAdf: string): Promise<{ counts: Counts; oldestPendingSentDate: string | null }> {
  assertString(idAdf, 'idAdf');
  const db = getDb();
  const sessionRef = db.collection(SESSIONS).doc(sessionKey(idAdf));
  const sigQuery = db.collection(SIGNATURES).where('idAdf', '==', idAdf);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(sigQuery);
    // Une ligne signatures = une attestation. Compteurs = docs.signature-rule.md §4.
    let signes = 0;
    const concernes = new Set<string>();
    const aRelancer = new Set<string>();
    let oldestPendingSentDate: string | null = null;
    // S18 — ventilation par bloc, MÊME passe, MÊME snapshot : aucune lecture ajoutée.
    // Le bloc est RE-DÉRIVÉ de `documentName` (déjà persisté sur chaque doc depuis S1)
    // et non lu du champ `bloc` : les docs écrits avant S18 ne l'ont pas, et on veut
    // qu'ils soient comptés correctement dès ce recalc, sans migration du miroir.
    const amontCoeur: BlocCounts = { signes: 0, total: 0 };
    const aval: BlocCounts = { signes: 0, total: 0 };

    snap.forEach((doc) => {
      const status = doc.get('status') as SignatureStatus;
      const idParticipant = String(doc.get('idParticipant') ?? '');
      if (idParticipant) concernes.add(idParticipant);

      // Chaque doc tombe dans EXACTEMENT un bloc → amontCoeur.total + aval.total === envoyes.
      const bloc = classifyAttestationBloc(String(doc.get('documentName') ?? ''));
      const cible = bloc === 'aval' ? aval : amontCoeur;
      cible.total += 1;
      if (status === 'signed') cible.signes += 1;

      if (status === 'signed') {
        signes += 1;
      } else if (status === 'pending') {
        if (idParticipant) aRelancer.add(idParticipant);
        const sd = doc.get('sentDate');
        if (typeof sd === 'string' && (oldestPendingSentDate === null || sd < oldestPendingSentDate)) {
          oldestPendingSentDate = sd; // ISO → comparaison lexicographique = chronologique
        }
      }
    });

    const envoyes = snap.size;
    const counts: Counts = {
      envoyes,
      signes,
      nonSignes: envoyes - signes,
      participantsConcernes: concernes.size,
      participantsARelancer: aRelancer.size,
      amontCoeur,
      aval,
    };

    tx.set(sessionRef, { counts, oldestPendingSentDate, lastSyncedAt: nowIso() }, { merge: true });
    return { counts, oldestPendingSentDate };
  });
}
