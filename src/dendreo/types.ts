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
// Types DOMAINE (résultat consommé par le miroir/UI)
// RÈGLE : docs/signature-rule.md (fait autorité). Unité de suivi = l'ATTESTATION
// (fichier signature dont le nom commence par "Attestation" + cible Participant).
// Plus de notSent, plus de laps : on ne compte que ce que Dendreo a envoyé.
// ---------------------------------------------------------------------------
export type AttestationStatus = 'signed' | 'pending';

/** Une attestation trackée (participant × session × doctype), après dédup. */
export interface AttestationLine {
  idParticipant: string;
  nom: string; // libellé d'affichage = `${prenom} ${nom}` (interne, sanitisé en fixture)
  doctypeId: string;
  documentName: string; // = fichier.name (ex. "Attestation sur l'honneur PI_2026")
  status: AttestationStatus;
  signatureDate: string | null; // ISO naïf si signé, sinon null
  sentDate: string | null; // = created_at normalisé (date d'envoi / ancienneté)
  viewerUrl: string | null; // = public_url
}

/** Compteurs par session (cf. signature-rule.md §4). Invariant: signes+nonSignes==envoyes. */
export interface SessionSignatureCounts {
  envoyes: number; // nb d'attestations trackées envoyées
  signes: number; // parmi envoyées, signées
  nonSignes: number; // = envoyes - signes (à relancer)
  participantsConcernes: number; // participants distincts avec ≥1 attestation
  participantsARelancer: number; // participants distincts avec ≥1 attestation non signée
}

export interface SessionSignatureStatus {
  idAdf: string;
  attestations: AttestationLine[];
  counts: SessionSignatureCounts;
  /**
   * Lignes d'attestation trackées (nom "Attestation" + cible Participant) mais
   * IGNORÉES car sans `doctype_id` exploitable → non clefables (cf. signatureKey)
   * et dédup impossible. Comptées pour visibilité : jamais perdues silencieusement,
   * et elles ne font JAMAIS tomber la session.
   */
  ignored: number;
}
