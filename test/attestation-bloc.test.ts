// test/attestation-bloc.test.ts — classifyAttestationBloc (fonction PURE, aucun réseau).
// Les noms testés sont ceux OBSERVÉS RÉELLEMENT sur les sessions 3117 et 3818
// (cf. scripts/recon-classification-attestation.mjs), plus les cas limites de robustesse.

import { describe, it, expect } from 'vitest';
import { classifyAttestationBloc } from '../src/core/attestation-name';
import type { AttestationBloc } from '../src/core/attestation-name';

describe('classifyAttestationBloc — noms RÉELS observés (3117 / 3818)', () => {
  const cas: ReadonlyArray<readonly [string, AttestationBloc]> = [
    ['Attestation_honneur_EPP amont_2025', 'amont'],
    ["Attestation sur l'honneur amont PI_2026", 'amont'],
    ['Attestation_honneur_EPP aval_2025', 'aval'],
    ["Attestation sur l'honneur PI_2026", 'coeur'],
    ["Attestation sur l'honneur PI_CV_PRES_EL_2025", 'coeur'],
    ["Attestation sur l'honneur PI_CV_2025", 'coeur'],
  ];

  for (const [nom, attendu] of cas) {
    it(`"${nom}" → ${attendu}`, () => {
      expect(classifyAttestationBloc(nom)).toBe(attendu);
    });
  }
});

describe('classifyAttestationBloc — casse, accents, marqueur collé', () => {
  it('ignore la casse : "ATTESTATION EPP AMONT" → amont', () => {
    expect(classifyAttestationBloc('ATTESTATION EPP AMONT')).toBe('amont');
  });

  it('marqueur collé au mot précédent : "attestation eppaval" → aval', () => {
    expect(classifyAttestationBloc('attestation eppaval')).toBe('aval');
  });

  it('ignore les accents (normalizeDocName partagé avec la règle signature)', () => {
    expect(classifyAttestationBloc('Attestation Médéré EPP AMÔNT')).toBe('amont');
    expect(classifyAttestationBloc('Attestation sur l’honneur EPP avàl 2025')).toBe('aval');
  });

  it('tolère les espaces de bord', () => {
    expect(classifyAttestationBloc('   Attestation EPP amont 2025   ')).toBe('amont');
  });
});

describe('classifyAttestationBloc — ordre des marqueurs (amont AVANT aval)', () => {
  it('un nom portant les DEUX marqueurs retombe sur amont, de façon déterministe', () => {
    expect(classifyAttestationBloc('Attestation EPP amont et aval 2025')).toBe('amont');
    expect(classifyAttestationBloc('Attestation EPP aval et amont 2025')).toBe('amont');
  });
});

describe('classifyAttestationBloc — défaut sûr, jamais de throw', () => {
  it('nom vide → coeur', () => {
    expect(classifyAttestationBloc('')).toBe('coeur');
  });

  it('nom uniquement composé d’espaces → coeur', () => {
    expect(classifyAttestationBloc('   ')).toBe('coeur');
  });

  // La signature publique est (documentName: string), mais l'appelant réel reçoit du
  // JSON Dendreo brut où `name` peut manquer : on prouve que le runtime encaisse.
  it('undefined → coeur, sans lever', () => {
    const absent = undefined as unknown as string;
    expect(() => classifyAttestationBloc(absent)).not.toThrow();
    expect(classifyAttestationBloc(absent)).toBe('coeur');
  });

  it('null → coeur, sans lever', () => {
    const nul = null as unknown as string;
    expect(() => classifyAttestationBloc(nul)).not.toThrow();
    expect(classifyAttestationBloc(nul)).toBe('coeur');
  });

  it('valeur non-string (nombre) → coeur, sans lever', () => {
    const nombre = 42 as unknown as string;
    expect(() => classifyAttestationBloc(nombre)).not.toThrow();
    expect(classifyAttestationBloc(nombre)).toBe('coeur');
  });
});
