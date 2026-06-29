// src/dendreo/rate-limiter.ts — Limiteur de débit (fenêtre glissante) pour l'API Dendreo.
// Borne le NOMBRE de requêtes qui PARTENT dans une fenêtre glissante (≠ concurrence).
// Horloge et sleep injectables → testable de façon déterministe (sans timer réel).

export interface RateLimiterOptions {
  /** Nb max de requêtes autorisées par fenêtre. */
  maxRequests: number;
  /** Largeur de la fenêtre glissante, en ms. */
  windowMs: number;
  /** Horloge (ms). Défaut : Date.now. Injectable pour les tests. */
  now?: () => number;
  /** Attente. Défaut : setTimeout. Injectable pour les tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** Plafond Dendreo réel = 100 req / 10 s ; on vise 80 pour garder une marge. */
export const DENDREO_RATE_DEFAULTS = { maxRequests: 80, windowMs: 10_000 } as const;

export class RateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly departures: number[] = []; // horodatages des départs récents (dans la fenêtre)
  private tail: Promise<unknown> = Promise.resolve(); // sérialise la réservation des créneaux

  constructor(opts: RateLimiterOptions) {
    this.maxRequests = opts.maxRequests;
    this.windowMs = opts.windowMs;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * Réserve un créneau de départ. Sérialisé : les réservations sont accordées une à une,
   * dans l'ordre d'appel. Si la fenêtre est pleine, attend qu'un créneau se libère.
   * Retourne l'instant (ms) de départ accordé.
   */
  async acquire(): Promise<number> {
    const run = this.tail.then(() => this.reserve());
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async reserve(): Promise<number> {
    for (;;) {
      const t = this.now();
      // purge des départs sortis de la fenêtre
      while (this.departures.length > 0 && this.departures[0]! <= t - this.windowMs) this.departures.shift();
      if (this.departures.length < this.maxRequests) {
        this.departures.push(t);
        return t;
      }
      // fenêtre pleine : attendre que le plus ancien départ sorte de la fenêtre
      const waitMs = this.departures[0]! + this.windowMs - t;
      await this.sleep(waitMs > 0 ? waitMs : 0);
    }
  }
}
