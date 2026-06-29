// src/dendreo/client.ts — Client Dendreo typé, LECTURE SEULE (GET only).
// - Auth par header Authorization: Token token="..." (clé jamais dans l'URL).
// - Clé jamais loggée : toute erreur passe par le redactor.
// - Gestion du 429 (HTTP_TOO_MANY_REQUESTS) : backoff + respect de Retry-After.

import { makeRedactor } from './redact';
import { DENDREO_RATE_DEFAULTS, RateLimiter } from './rate-limiter';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface DendreoClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Nb max de tentatives supplémentaires sur 429 (défaut 4). */
  maxRetries?: number;
  /** Délai de base du backoff en ms (défaut 1000). */
  backoffBaseMs?: number;
  /** Limiteur de débit : nb max de requêtes par fenêtre (défaut 80). */
  maxRequests?: number;
  /** Limiteur de débit : largeur de fenêtre en ms (défaut 10000). */
  windowMs?: number;
  /** Injection pour tests. Défaut : fetch global. */
  fetchImpl?: FetchLike;
  /** Injection pour tests. Défaut : setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Injection pour tests. Défaut : Date.now (utilisé par le limiteur). */
  now?: () => number;
}

/** Erreur Dendreo : son message est déjà rédigé (clé masquée). */
export class DendreoError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'DendreoError';
    this.status = status;
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class DendreoClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly redact: (input: unknown) => string;
  private readonly limiter: RateLimiter;

  constructor(opts: DendreoClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.maxRetries = opts.maxRetries ?? 4;
    this.backoffBaseMs = opts.backoffBaseMs ?? 1000;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleep = opts.sleep ?? defaultSleep;
    this.redact = makeRedactor(opts.apiKey);
    this.limiter = new RateLimiter({
      maxRequests: opts.maxRequests ?? DENDREO_RATE_DEFAULTS.maxRequests,
      windowMs: opts.windowMs ?? DENDREO_RATE_DEFAULTS.windowMs,
      sleep: this.sleep,
      now: opts.now,
    });
  }

  /** GET typé. `params` est encodé dans la query (jamais la clé). */
  async get<T>(resource: string, params: Record<string, string | number> = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}/${resource}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const safeUrl = this.redact(url.toString());

    let attempt = 0;
    for (;;) {
      // Limiteur de débit : toute requête (1re tentative ET retries) traverse la fenêtre.
      await this.limiter.acquire();

      let res: Response;
      try {
        res = await this.fetchImpl(url.toString(), {
          method: 'GET', // GET UNIQUEMENT — ne jamais changer (lecture seule).
          headers: {
            Authorization: `Token token="${this.apiKey}"`,
            Accept: 'application/json',
          },
        });
      } catch (err) {
        // Une erreur réseau/SDK peut transporter la clé via message/cause → on rédige.
        throw new DendreoError(this.redact(`fetch a échoué pour ${safeUrl} : ${errMessage(err)}`));
      }

      if (res.status === 429) {
        if (attempt >= this.maxRetries) {
          throw new DendreoError(`HTTP 429 (quota) après ${attempt} retries sur ${safeUrl}`, 429);
        }
        await this.sleep(this.retryDelayMs(res, attempt));
        attempt += 1;
        continue;
      }

      const text = await res.text();
      if (!res.ok) {
        throw new DendreoError(`HTTP ${res.status} ${res.statusText} sur ${safeUrl}\n${this.redact(text).slice(0, 600)}`, res.status);
      }
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new DendreoError(`Réponse non-JSON sur ${safeUrl} : ${this.redact(text).slice(0, 300)}`, res.status);
      }
    }
  }

  /** Délai de backoff : respecte Retry-After (s) si présent, sinon exponentiel. */
  private retryDelayMs(res: Response, attempt: number): number {
    const retryAfter = res.headers.get('retry-after');
    if (retryAfter) {
      const secs = Number(retryAfter);
      if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
    }
    return this.backoffBaseMs * 2 ** attempt;
  }
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
