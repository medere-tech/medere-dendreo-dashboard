// test/rate-limiter.test.ts — Limiteur de débit, déterministe (horloge virtuelle, zéro réseau).

import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/dendreo/rate-limiter';

/** Horloge virtuelle : sleep AVANCE le temps, now le lit. Déterministe. */
function virtualClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => { t += ms; },
    current: () => t,
  };
}

describe('RateLimiter (fenêtre glissante)', () => {
  it('laisse passer jusqu\'à maxRequests sans attendre', async () => {
    const clk = virtualClock();
    const rl = new RateLimiter({ maxRequests: 5, windowMs: 1000, now: clk.now, sleep: clk.sleep });
    const deps: number[] = [];
    for (let i = 0; i < 5; i++) deps.push(await rl.acquire());
    expect(deps).toEqual([0, 0, 0, 0, 0]); // aucun n'attend
    expect(clk.current()).toBe(0); // aucun sleep déclenché
  });

  it('jamais plus de maxRequests départs dans une fenêtre de windowMs (N appels rapprochés)', async () => {
    const clk = virtualClock();
    const MAX = 5;
    const WINDOW = 1000;
    const rl = new RateLimiter({ maxRequests: MAX, windowMs: WINDOW, now: clk.now, sleep: clk.sleep });

    const deps: number[] = [];
    for (let i = 0; i < 23; i++) deps.push(await rl.acquire());

    // Invariant : le (i+MAX)-ème départ part au moins WINDOW après le i-ème.
    for (let i = 0; i + MAX < deps.length; i++) {
      expect(deps[i + MAX]! - deps[i]!).toBeGreaterThanOrEqual(WINDOW);
    }

    // Contrôle direct : pour toute fenêtre [t, t+WINDOW), au plus MAX départs.
    for (const start of deps) {
      const inWindow = deps.filter((d) => d >= start && d < start + WINDOW).length;
      expect(inWindow).toBeLessThanOrEqual(MAX);
    }
  });

  it('respecte l\'ordre des réservations (sérialisé)', async () => {
    const clk = virtualClock();
    const rl = new RateLimiter({ maxRequests: 2, windowMs: 100, now: clk.now, sleep: clk.sleep });
    const deps: number[] = [];
    for (let i = 0; i < 6; i++) deps.push(await rl.acquire());
    // départs non décroissants
    for (let i = 1; i < deps.length; i++) expect(deps[i]!).toBeGreaterThanOrEqual(deps[i - 1]!);
    // 2 par fenêtre de 100ms → [0,0,100,100,200,200]
    expect(deps).toEqual([0, 0, 100, 100, 200, 200]);
  });
});
