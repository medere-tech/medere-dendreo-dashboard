// src/dendreo/signatures.ts — Statut de signature d'une session (lecture seule).
//
// computeSignatureStatus : fonction PURE (DendreoFichier[] -> SessionSignatureStatus),
//   testée sur fixtures réelles. getSessionSignatureStatus : I/O via le client.
//
// Règles (validées S0/archi) :
//  - garder collection_name="signature"
//  - garder doctype_id = DOCTYPE suivi (défaut "111", Convention)
//  - garder uniquement entite_liee.type = "Participant" (exclut Formateur)
//  - dédupliquer par participant × session × doctype :
//      * s'il existe un doc signé, on garde le signé le plus récent ;
//      * sinon le plus récent en attente.
//  - SIGNÉ = signature_date non vide ; EN ATTENTE = signature_date vide.

import { DENDREO } from '../config';
import { DendreoClient } from './client';
import type {
  DendreoFichier,
  DendreoLap,
  ExpectedParticipantRule,
  NotSentParticipant,
  PendingSignature,
  SessionSignatureStatus,
  SignatureStatusOptions,
  SignedSignature,
} from './types';

// --- Prédicats de la règle "attendu" (isolés, réutilisables, paramétrables) ---

/**
 * Participant IDENTIFIÉ : on ne peut ni envoyer ni relancer un document à un
 * participant anonyme. Exclut id_participant absent, vide ou "0".
 */
export const isIdentifiedParticipant: ExpectedParticipantRule = (lap) => {
  const id = (lap.id_participant ?? lap.participant?.id_participant ?? '').trim();
  return id !== '' && id !== '0';
};

/**
 * Inscription ACTIVE : on n'attend pas une inscription désinscrite/annulée.
 * Convention Dendreo observée en S0 : lap.status === "1" = actif.
 */
export const isActiveEnrollment: ExpectedParticipantRule = (lap) => lap.status === '1';

/**
 * Règle d'éligibilité par défaut (hypothèse temporaire, en attente de Justine) :
 * tout inscrit IDENTIFIÉ **et** ACTIF est attendu pour la Convention.
 * Les 2 filtres vivent ICI (pas en dur ailleurs) → affinables sans rien casser
 * (ex. restreindre plus tard à un sous-module non connecté).
 */
export const defaultExpectedRule: ExpectedParticipantRule = (lap) => isIdentifiedParticipant(lap) && isActiveEnrollment(lap);

interface Candidate {
  idParticipant: string;
  nom: string;
  signed: boolean;
  signatureDate: string;
  createdAt: string;
  viewerUrl: string;
}

const isSigned = (f: DendreoFichier): boolean => typeof f.signature_date === 'string' && f.signature_date.trim() !== '';

const displayName = (prenom?: string, nom?: string): string => [prenom, nom].map((s) => (s ?? '').trim()).filter(Boolean).join(' ');

/** Compare deux dates ISO ; retourne true si `a` est plus récent que `b`. */
const isMoreRecent = (a: string, b: string): boolean => Date.parse(a) > Date.parse(b);

/**
 * Calcule le statut de signature à partir des fichiers BRUTS d'une session.
 * Fonction pure, déterministe — aucune I/O.
 */
export function computeSignatureStatus(
  idAdf: string,
  fichiers: DendreoFichier[],
  laps: DendreoLap[] = [],
  options: SignatureStatusOptions = {},
): SessionSignatureStatus {
  const doctypeId = options.doctypeId ?? DENDREO.DOCTYPE_CONVENTION;
  const isExpected = options.isExpected ?? defaultExpectedRule;

  // 1) Filtre : collection signature + doctype suivi + cible Participant uniquement.
  const candidates: Candidate[] = [];
  for (const f of fichiers) {
    if (f.collection_name !== DENDREO.COLLECTION_SIGNATURE) continue;
    if (f.doctype_id !== doctypeId) continue;
    const participant = f.entite_liee?.Participant;
    if (!participant) continue; // exclut Formateur (et tout doc non rattaché à un participant)
    const idParticipant = participant.id_participant;
    if (!idParticipant) continue;
    candidates.push({
      idParticipant,
      nom: displayName(participant.prenom, participant.nom),
      signed: isSigned(f),
      signatureDate: f.signature_date,
      createdAt: f.created_at,
      viewerUrl: f.public_url,
    });
  }

  // 2) Dédup par participant (session & doctype déjà fixés par l'appel).
  const best = new Map<string, Candidate>();
  for (const c of candidates) {
    const prev = best.get(c.idParticipant);
    if (!prev || preferred(c, prev)) best.set(c.idParticipant, c);
  }

  // 3) Classement signé / en attente.
  const signed: SignedSignature[] = [];
  const pending: PendingSignature[] = [];
  const withFile = new Set<string>();
  for (const c of best.values()) {
    withFile.add(c.idParticipant);
    if (c.signed) {
      signed.push({ idParticipant: c.idParticipant, nom: c.nom, signatureDate: c.signatureDate, viewerUrl: c.viewerUrl });
    } else {
      pending.push({ idParticipant: c.idParticipant, nom: c.nom, sentDate: c.createdAt, viewerUrl: c.viewerUrl });
    }
  }

  // 4) notSent = participants ATTENDUS (règle paramétrable) SANS aucun fichier suivi.
  const notSent: NotSentParticipant[] = [];
  const seenExpected = new Set<string>();
  for (const lap of laps) {
    if (!isExpected(lap)) continue;
    const idParticipant = lap.id_participant ?? lap.participant?.id_participant;
    if (!idParticipant) continue;
    if (withFile.has(idParticipant)) continue; // a déjà un doc (signé ou en attente)
    if (seenExpected.has(idParticipant)) continue; // dédup inscriptions multiples
    seenExpected.add(idParticipant);
    notSent.push({ idParticipant, nom: displayName(lap.participant?.prenom, lap.participant?.nom) });
  }

  // Tris utiles : en attente du plus ancien au plus récent (priorité de relance).
  pending.sort((a, b) => Date.parse(a.sentDate) - Date.parse(b.sentDate));
  signed.sort((a, b) => Date.parse(b.signatureDate) - Date.parse(a.signatureDate));

  return { idAdf, signed, pending, notSent };
}

/** `cand` est-il préférable au `current` retenu pour ce participant ? */
function preferred(cand: Candidate, current: Candidate): boolean {
  // Un signé l'emporte toujours sur un non signé.
  if (cand.signed !== current.signed) return cand.signed;
  // À statut égal, on garde le plus récent (par date d'émission).
  return isMoreRecent(cand.createdAt, current.createdAt);
}

/**
 * Récupère et calcule le statut de signature d'une session via l'API (lecture seule).
 * 2 appels :
 *  - fichiers.php?cible=action-de-formation&id_cible={idAdf}&collection_name=signature (signés/en attente)
 *  - laps.php?id_action_de_formation={idAdf}&include=participant (participants attendus → notSent)
 */
export async function getSessionSignatureStatus(
  idAdf: string | number,
  client: DendreoClient,
  options: SignatureStatusOptions = {},
): Promise<SessionSignatureStatus> {
  const id = String(idAdf);
  const [fichiers, laps] = await Promise.all([
    client.get<DendreoFichier[]>('fichiers.php', {
      cible: DENDREO.CIBLE_ADF,
      id_cible: id,
      collection_name: DENDREO.COLLECTION_SIGNATURE,
    }),
    client.get<DendreoLap[]>('laps.php', {
      id_action_de_formation: id,
      include: 'participant',
    }),
  ]);
  const fichiersArr = Array.isArray(fichiers) ? fichiers : [];
  const lapsArr = Array.isArray(laps) ? laps : [];
  return computeSignatureStatus(id, fichiersArr, lapsArr, options);
}
