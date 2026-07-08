import { describe, it, expect } from 'vitest';
import { computeSignature, verifyDendreoSignature } from './webhook-verify';

const SECRET = 'whsec-test-123';

describe('verifyDendreoSignature (HMAC-SHA256 du body brut)', () => {
  it('signature valide → true', () => {
    const body = '{"event":"media.signed"}';
    expect(verifyDendreoSignature(body, computeSignature(body, SECRET), SECRET)).toBe(true);
  });
  it('body ALTÉRÉ (même longueur) → false', () => {
    const sig = computeSignature('{"a":1}', SECRET);
    expect(verifyDendreoSignature('{"a":2}', sig, SECRET)).toBe(false);
  });
  it('signature bidon → false (pas d\'exception)', () => {
    expect(verifyDendreoSignature('{"a":1}', 'deadbeef', SECRET)).toBe(false);
  });
  it('header absent / secret absent → false', () => {
    expect(verifyDendreoSignature('{}', null, SECRET)).toBe(false);
    expect(verifyDendreoSignature('{}', computeSignature('{}', SECRET), '')).toBe(false);
  });
  it('hex insensible à la casse + trim', () => {
    const body = '{"x":1}';
    const sig = computeSignature(body, SECRET);
    expect(verifyDendreoSignature(body, `  ${sig.toUpperCase()}  `, SECRET)).toBe(true);
  });
  it('mauvais secret → false', () => {
    const body = '{"x":1}';
    expect(verifyDendreoSignature(body, computeSignature(body, 'autre'), SECRET)).toBe(false);
  });
});
