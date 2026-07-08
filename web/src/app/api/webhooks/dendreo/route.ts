import { syncSession } from '@shared/dendreo/sync';
import { verifyDendreoSignature } from '@/lib/server/webhook-verify';
import { decideWebhook, type DendreoWebhookPayload } from '@/lib/server/webhook-filter';

/**
 * Endpoint webhook Dendreo (S8.1). SERVEUR uniquement (Admin SDK + secret HMAC).
 * Reçoit "media.signed" → vérifie l'origine (HMAC-SHA256 du body brut, header
 * "Signature") → filtre métier (ADF + attestation) → re-fetch fichiers.php de la
 * session → upsert idempotent (session + signatures + recalcSessionCounts).
 *
 * Idempotent : 5 retries Dendreo → clés déterministes, aucun doublon.
 *
 * Variables d'env (Vercel, jamais commitées / loggées) :
 *  - DENDREO_WEBHOOK_SECRET      (vérif signature)
 *  - DENDREO_API_KEY / DENDREO_BASE_URL           (re-fetch, via @shared/config)
 *  - FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY (Admin SDK)
 */
export const runtime = 'nodejs'; // node:crypto + firebase-admin → jamais Edge
export const dynamic = 'force-dynamic';

const isDev = process.env.NODE_ENV !== 'production';
function devLog(...args: unknown[]): void {
  if (isDev) console.log('[webhook/dendreo]', ...args);
}

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.DENDREO_WEBHOOK_SECRET ?? '';
  // 1) Corps BRUT + vérification de signature (timing-safe) AVANT tout parsing.
  const raw = await req.text();
  const signature = req.headers.get('signature');
  if (!verifyDendreoSignature(raw, signature, secret)) {
    devLog('signature invalide → 401');
    return json({ error: 'invalid signature' }, 401);
  }

  // 2) Parse + filtre métier.
  let payload: DendreoWebhookPayload;
  try {
    payload = JSON.parse(raw) as DendreoWebhookPayload;
  } catch {
    devLog('JSON invalide → 400');
    return json({ error: 'invalid json' }, 400);
  }

  const decision = decideWebhook(payload);
  const name = payload?.media?.name;
  if (decision.action === 'ignore') {
    devLog({ event: payload?.event, name, matched: false, ignored: decision.reason });
    return json({ ok: true, ignored: decision.reason }, 200);
  }

  // 3) Re-fetch + upsert idempotent (fonctions existantes via @shared).
  try {
    const res = await syncSession(decision.idAdf); // res inclut idAdf
    devLog({ event: payload?.event, name, matched: true, ...res });
    return json({ ok: true, ...res }, 200);
  } catch (err) {
    // On renvoie 500 → Dendreo relancera (backoff). Aucune donnée sensible loggée.
    devLog('sync KO → 500', String(err instanceof Error ? err.message : err).slice(0, 200));
    return json({ error: 'sync failed' }, 500);
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
