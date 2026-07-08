import { DENDREO } from '@shared/config';
import { normalizeDocName } from '@shared/dendreo/signatures';

/**
 * Filtre métier des webhooks Dendreo (S8.1). On ne traite que "media.signed"
 * ciblant une Action de Formation ET dont le document est une ATTESTATION —
 * en réutilisant EXACTEMENT la normalisation `normalizeDocName` (règle
 * `isTrackedAttestation`, moitié "nom") et la constante `DENDREO.CIBLE_ADF`.
 */

export interface DendreoWebhookMedia {
  id?: string;
  name?: string;
  cible?: string;
  id_cible?: string;
  url?: string;
}

export interface DendreoWebhookPayload {
  event?: string;
  media?: DendreoWebhookMedia;
  signatures?: unknown[];
  created_by?: unknown;
  timestamp?: unknown;
}

const ATTESTATION_PREFIX = 'attestation'; // = ATTESTATION_PREFIX de src/dendreo/signatures.ts

export type WebhookDecision =
  | { action: 'process'; idAdf: string }
  | { action: 'ignore'; reason: string };

/** Est-ce un nom d'attestation trackée ? (moitié "nom" de isTrackedAttestation). */
export function isAttestationName(name: string | undefined): boolean {
  return normalizeDocName(name ?? '').startsWith(ATTESTATION_PREFIX);
}

/**
 * Décide quoi faire d'un payload webhook. `process` (avec idAdf) uniquement si :
 * event === "media.signed" ET media.cible === "action-de-formation" ET nom = attestation
 * ET id_cible présent. Sinon `ignore` (→ 200 côté route, aucun re-fetch).
 */
export function decideWebhook(payload: DendreoWebhookPayload | null | undefined): WebhookDecision {
  const event = payload?.event;
  if (event !== 'media.signed') return { action: 'ignore', reason: `event non traité: ${event ?? '(absent)'}` };

  const media = payload?.media ?? {};
  if (media.cible !== DENDREO.CIBLE_ADF) return { action: 'ignore', reason: `cible non-ADF: ${media.cible ?? '(absente)'}` };

  if (!isAttestationName(media.name)) return { action: 'ignore', reason: `document non-attestation: ${media.name ?? '(sans nom)'}` };

  const idAdf = String(media.id_cible ?? '').trim();
  if (!idAdf) return { action: 'ignore', reason: 'id_cible manquant' };

  return { action: 'process', idAdf };
}
