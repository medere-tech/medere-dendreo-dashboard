import { describe, it, expect } from 'vitest';
import { todayInParis, msUntilNextParisMidnight, parisDayOfInstant, daysBetween } from './time';

describe('todayInParis', () => {
  it('été (UTC+2) : 23:30 UTC → déjà le lendemain à Paris', () => {
    expect(todayInParis(new Date('2026-07-03T23:30:00Z'))).toBe('2026-07-04');
  });
  it('été : 21:30 UTC → encore le même jour à Paris (23:30)', () => {
    expect(todayInParis(new Date('2026-07-03T21:30:00Z'))).toBe('2026-07-03');
  });
  it('hiver (UTC+1) : 23:30 UTC → lendemain à Paris (00:30)', () => {
    expect(todayInParis(new Date('2026-01-15T23:30:00Z'))).toBe('2026-01-16');
  });
});

describe('parisDayOfInstant (cas B : instant UTC-Z → jour Paris)', () => {
  it('soir UTC (22:01Z, été) → lendemain à Paris', () => {
    expect(parisDayOfInstant('2025-06-02T22:01:04.000000Z')).toBe('2025-06-03');
  });
  it('20:00Z (été = 22:00 Paris) → même jour', () => {
    expect(parisDayOfInstant('2025-06-02T20:00:00.000000Z')).toBe('2025-06-02');
  });
  it('hiver 23:30Z → lendemain à Paris (00:30)', () => {
    expect(parisDayOfInstant('2025-01-15T23:30:00.000000Z')).toBe('2025-01-16');
  });
  it('null/vide → ""', () => {
    expect(parisDayOfInstant(null)).toBe('');
    expect(parisDayOfInstant('')).toBe('');
  });
});

describe('daysBetween', () => {
  it('jours consécutifs → 1', () => {
    expect(daysBetween('2025-06-01', '2025-06-02')).toBe(1);
  });
  it('même jour → 0', () => {
    expect(daysBetween('2025-06-02', '2025-06-02')).toBe(0);
  });
  it('à cheval sur un mois → 2', () => {
    expect(daysBetween('2025-05-31', '2025-06-02')).toBe(2);
  });
  it('à cheval sur une année → 1', () => {
    expect(daysBetween('2024-12-31', '2025-01-01')).toBe(1);
  });
});

describe('msUntilNextParisMidnight', () => {
  it('borne toujours dans ]0, 24h]', () => {
    const ms = msUntilNextParisMidnight(new Date('2026-07-03T12:00:00Z'));
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });
  it('à 22:00 Paris (été = 20:00 UTC) il reste ~2h', () => {
    const ms = msUntilNextParisMidnight(new Date('2026-07-03T20:00:00Z'));
    expect(ms).toBe(2 * 60 * 60 * 1000);
  });
});
