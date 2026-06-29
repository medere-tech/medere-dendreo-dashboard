// src/dendreo/types.ts — Types Dendreo (lecture seule)
// Shape BRUT prouvé en S0 (voir docs/recon-findings.md §4-5) + types DOMAINE.

// ---------------------------------------------------------------------------
// Types BRUTS renvoyés par fichiers.php (collection "signature")
// ---------------------------------------------------------------------------
export interface DendreoEntite {
  id_participant?: string;
  nom?: string;
  prenom?: string;
  // (autres champs PII ignorés volontairement)
}

/** entite_liee est un objet à UNE clé : le type de cible lié au média. */
export type EntiteLiee = Partial<Record<'Participant' | 'Formateur', DendreoEntite>>;

/** Inscription d'un participant à une session (laps.php?include=participant). */
export interface DendreoLap {
  id_lap?: string;
  id_participant?: string;
  status?: string;
  lap_status_id?: string;
  participant?: DendreoEntite;
}

export interface DendreoFichier {
  id: string;
  uuid?: string;
  collection_name: string; // "signature"
  name: string; // ex. "Convention_Participant_Formation_Médéré"
  doctype_id: string; // ex. "111"
  mime_type?: string;
  signature_date: string; // "" => en attente ; ISO => signé
  related_media_id?: string;
  created_at: string; // date d'émission (ancienneté de relance)
  cible: string; // "action-de-formation"
  id_cible: string; // = idAdf
  public_url: string;
  entite_liee: EntiteLiee | null;
}

// ---------------------------------------------------------------------------
// Types DOMAINE (résultat consommé par S2/UI)
// ---------------------------------------------------------------------------
export interface SignedSignature {
  idParticipant: string;
  nom: string; // libellé d'affichage = `${prenom} ${nom}`
  signatureDate: string; // ISO, garanti non vide
  viewerUrl: string; // = public_url
}

export interface PendingSignature {
  idParticipant: string;
  nom: string;
  sentDate: string; // = created_at (ancienneté → priorité de relance)
  viewerUrl: string;
}

export interface NotSentParticipant {
  idParticipant: string;
  nom: string;
}

export interface SessionSignatureStatus {
  idAdf: string;
  signed: SignedSignature[]; // signature_date présente
  pending: PendingSignature[]; // fichier présent, signature_date vide (à relancer)
  notSent: NotSentParticipant[]; // participant attendu sans aucun fichier de signature
}

/**
 * Règle « ce participant est-il ATTENDU pour le document suivi ? ».
 * Hypothèse temporaire (en attente de Justine) : tout inscrit est attendu.
 * Isolée ici pour pouvoir l'affiner (ex. filtrer sur un sous-module non connecté)
 * sans toucher au reste de la logique.
 */
export type ExpectedParticipantRule = (lap: DendreoLap) => boolean;

export interface SignatureStatusOptions {
  /** doctype_id du document suivi. Défaut: Convention "111". */
  doctypeId?: string;
  /** Règle d'éligibilité « attendu ». Défaut: tout inscrit est attendu. */
  isExpected?: ExpectedParticipantRule;
}
