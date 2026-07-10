import { describe, it, expect } from 'vitest';
import { isSheetExportAuthorized } from './sheet-auth';

const TOKEN = 'sheet-token-abc123';

describe('isSheetExportAuthorized (Bearer timing-safe)', () => {
  it('Bearer + bon jeton → true', () => {
    expect(isSheetExportAuthorized(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
  });
  it('trim du header → true', () => {
    expect(isSheetExportAuthorized(`  Bearer ${TOKEN}  `, TOKEN)).toBe(true);
  });
  it('mauvais jeton (même longueur) → false', () => {
    expect(isSheetExportAuthorized('Bearer sheet-token-abc124', TOKEN)).toBe(false);
  });
  it('jeton de longueur différente → false (pas d\'exception)', () => {
    expect(isSheetExportAuthorized('Bearer court', TOKEN)).toBe(false);
  });
  it('header absent / vide / sans préfixe Bearer → false', () => {
    expect(isSheetExportAuthorized(null, TOKEN)).toBe(false);
    expect(isSheetExportAuthorized(undefined, TOKEN)).toBe(false);
    expect(isSheetExportAuthorized('', TOKEN)).toBe(false);
    expect(isSheetExportAuthorized(TOKEN, TOKEN)).toBe(false); // pas de "Bearer "
    expect(isSheetExportAuthorized(`Basic ${TOKEN}`, TOKEN)).toBe(false);
  });
  it('env attendue absente/vide → false (fail-closed, route jamais ouverte)', () => {
    expect(isSheetExportAuthorized(`Bearer ${TOKEN}`, undefined)).toBe(false);
    expect(isSheetExportAuthorized(`Bearer ${TOKEN}`, '')).toBe(false);
  });
});
