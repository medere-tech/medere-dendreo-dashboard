import { describe, it, expect } from 'vitest';
import { todayInParis, msUntilNextParisMidnight } from './time';

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
