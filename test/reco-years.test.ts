// test/reco-years.test.ts — helper d'années du cron (pur, dates injectées).
import { describe, it, expect } from 'vitest';
import { RECO_START_YEAR, monthlyYears, nightlyYears, parisYear } from '../src/reco/years';

// Dates à midi UTC → année Paris non ambiguë (loin des bascules de minuit).
const at = (iso: string) => new Date(iso);

describe('parisYear', () => {
  it('année civile en Europe/Paris', () => {
    expect(parisYear(at('2026-06-15T12:00:00Z'))).toBe(2026);
    expect(parisYear(at('2025-01-05T12:00:00Z'))).toBe(2025);
  });
  it('bascule de fin d\'année : 31/12 23:30 UTC = 01/01 00:30 Paris (hiver, +1)', () => {
    expect(parisYear(at('2025-12-31T23:30:00Z'))).toBe(2026);
  });
});

describe('nightlyYears (glissant 2 ans, borné à RECO_START_YEAR)', () => {
  it('2026 → [2025, 2026]', () => {
    expect(nightlyYears(at('2026-06-15T12:00:00Z'))).toEqual([2025, 2026]);
  });
  it('2028 → [2027, 2028]', () => {
    expect(nightlyYears(at('2028-06-15T12:00:00Z'))).toEqual([2027, 2028]);
  });
  it('début 2025 → [2025] (pas d\'année < RECO_START_YEAR)', () => {
    expect(nightlyYears(at('2025-01-05T12:00:00Z'))).toEqual([2025]);
  });
});

describe('monthlyYears (RECO_START_YEAR → année en cours)', () => {
  it('2026 → [2025, 2026]', () => {
    expect(monthlyYears(at('2026-06-15T12:00:00Z'))).toEqual([2025, 2026]);
  });
  it('2028 → [2025, 2026, 2027, 2028]', () => {
    expect(monthlyYears(at('2028-06-15T12:00:00Z'))).toEqual([2025, 2026, 2027, 2028]);
  });
  it('début 2025 → [2025]', () => {
    expect(monthlyYears(at('2025-01-05T12:00:00Z'))).toEqual([2025]);
  });
  it('RECO_START_YEAR est bien 2025 (constante isolée)', () => {
    expect(RECO_START_YEAR).toBe(2025);
  });
});
