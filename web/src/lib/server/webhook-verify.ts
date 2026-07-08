import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Vérification d'origine des webhooks Dendreo (S8.1). Header "Signature" =
 * HMAC-SHA256 du BODY BRUT avec la clé secrète (hex). Comparaison timing-safe.
 * SERVEUR uniquement (node:crypto) — jamais importé côté client.
 */

/** HMAC-SHA256(body, secret) en hex minuscules. */
export function computeSignature(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

/**
 * `true` si le header correspond au HMAC recalculé (timing-safe). Toute entrée
 * absente/vide ou de longueur différente → `false` (jamais d'exception).
 */
export function verifyDendreoSignature(rawBody: string, header: string | null | undefined, secret: string): boolean {
  if (!secret || !header) return false;
  const expected = Buffer.from(computeSignature(rawBody, secret), 'utf8');
  const given = Buffer.from(header.trim().toLowerCase(), 'utf8');
  if (expected.length !== given.length) return false; // longueurs ≠ → pas de timingSafeEqual (throw sinon)
  return timingSafeEqual(expected, given);
}
