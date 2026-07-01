import { describe, it, expect } from 'vitest';
import { isAllowedMedereUser } from './is-allowed-medere-user';

describe('isAllowedMedereUser', () => {
  it('autorise un email @medere.fr vérifié', () => {
    expect(isAllowedMedereUser('justine@medere.fr', true)).toBe(true);
  });

  it('normalise la casse et les espaces', () => {
    expect(isAllowedMedereUser('  Justine@Medere.FR ', true)).toBe(true);
  });

  it('refuse un email @medere.fr NON vérifié', () => {
    expect(isAllowedMedereUser('justine@medere.fr', false)).toBe(false);
  });

  it('refuse un domaine hors Médéré', () => {
    expect(isAllowedMedereUser('justine@gmail.com', true)).toBe(false);
  });

  it('refuse un sous-domaine de medere.fr', () => {
    expect(isAllowedMedereUser('justine@paie.medere.fr', true)).toBe(false);
  });

  it('refuse une usurpation par suffixe (medere.fr.evil.com)', () => {
    expect(isAllowedMedereUser('justine@medere.fr.evil.com', true)).toBe(false);
  });

  it('refuse un email absent ou vide', () => {
    expect(isAllowedMedereUser(null, true)).toBe(false);
    expect(isAllowedMedereUser(undefined, true)).toBe(false);
    expect(isAllowedMedereUser('', true)).toBe(false);
  });

  it('refuse une chaîne sans partie locale', () => {
    expect(isAllowedMedereUser('@medere.fr', true)).toBe(false);
  });
});
