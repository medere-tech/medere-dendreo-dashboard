import { timingSafeEqual } from 'node:crypto';

/**
 * Auth de la route de lecture `GET /api/export/sheet` (S10.1). Jeton statique
 * bas-privilège (lecture seule, révocable en changeant l'env `SHEET_EXPORT_TOKEN`)
 * transporté dans `Authorization: Bearer <token>`, comparé en TIMING-SAFE.
 * SERVEUR uniquement (node:crypto) — jamais importé côté client. Le jeton n'est
 * jamais loggé.
 */

const BEARER_RE = /^Bearer (.+)$/;

/** Égalité de chaînes en temps constant. Longueurs ≠ → false (pas de timingSafeEqual
 *  qui jette sinon), même compromis que `verifyDendreoSignature`. */
function timingSafeStrEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * `true` si `Authorization: Bearer <token>` correspond EXACTEMENT (timing-safe) au
 * jeton attendu. `expected` absent/vide → toujours `false` (fail-closed : la route
 * n'est jamais ouverte si l'env n'est pas configurée). Header absent/malformé →
 * `false`. Jamais d'exception.
 */
export function isSheetExportAuthorized(authHeader: string | null | undefined, expected: string | undefined): boolean {
  if (!expected) return false;
  const m = typeof authHeader === 'string' ? BEARER_RE.exec(authHeader.trim()) : null;
  if (!m) return false;
  return timingSafeStrEqual(m[1]!, expected);
}
