import { describe, it, expect } from 'vitest';
import { DENDREO_WEB_BASE, suiviSignaturesUrl } from './dendreo';

describe('suiviSignaturesUrl', () => {
  it('construit {web_base}/formations/{idAdf}/suivi-signatures (web_base sans /api)', () => {
    expect(DENDREO_WEB_BASE.endsWith('/api')).toBe(false);
    expect(suiviSignaturesUrl('2656')).toBe('https://pro.dendreo.com/nes_formation/formations/2656/suivi-signatures');
  });
  it('encode l\'idAdf', () => {
    expect(suiviSignaturesUrl('a b')).toContain('/formations/a%20b/suivi-signatures');
  });
});
