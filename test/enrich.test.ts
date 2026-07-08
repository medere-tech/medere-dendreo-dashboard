// test/enrich.test.ts — dérivations d'enrichissement S5.1b (PURES).
// Cas ancrés sur données réelles (docs/recon-s5-findings.md + verify-compte-produit).

import { describe, it, expect } from 'vitest';
import {
  deriveEligibleDpc,
  deriveNumeroCompteProduit,
  eppConnecte,
  formatLabel,
  hasEpp,
  isACheval,
  parseHeures,
  type SessionModuleView,
} from '../src/dendreo/enrich';

const mod = (categorie: string, heuresConnectees: number, numProgrammeDpc = '', eligibleDpc = '1'): SessionModuleView => ({
  categorie,
  heuresConnectees,
  numProgrammeDpc,
  eligibleDpc,
});

describe('formatLabel', () => {
  it('mappe les 4 valeurs prouvées', () => {
    expect(formatLabel('presentiel')).toBe('Présentiel');
    expect(formatLabel('mixte')).toBe('Mixte');
    expect(formatLabel('elearning_async')).toBe('E-learning');
    expect(formatLabel('elearning_sync')).toBe('Classe virtuelle');
  });
  it('valeur inconnue → renvoyée telle quelle ; vide/null → ""', () => {
    expect(formatLabel('autre_mode')).toBe('autre_mode');
    expect(formatLabel('')).toBe('');
    expect(formatLabel(null)).toBe('');
    expect(formatLabel(undefined)).toBe('');
  });
});

describe('isACheval', () => {
  it('true si années différentes (ex. idAdf 2408 : 2024→2025)', () => {
    expect(isACheval('2024-09-25T00:00:00', '2025-01-09T23:59:59')).toBe(true);
  });
  it('false si même année (ex. idAdf 2656 : 2025→2025)', () => {
    expect(isACheval('2025-02-09T00:00:00', '2025-05-31T23:59:59')).toBe(false);
  });
  it('date manquante → false (prudent)', () => {
    expect(isACheval('', '2025-01-01')).toBe(false);
    expect(isACheval('2025-01-01', '')).toBe(false);
    expect(isACheval(null, null)).toBe(false);
  });
});

describe('parseHeures', () => {
  it('parse nombres, virgule décimale, vide/null → 0', () => {
    expect(parseHeures('3.5')).toBe(3.5);
    expect(parseHeures('2')).toBe(2);
    expect(parseHeures('1,5')).toBe(1.5);
    expect(parseHeures('')).toBe(0);
    expect(parseHeures(null)).toBe(0);
    expect(parseHeures(undefined)).toBe(0);
  });
});

describe('eppConnecte (2 booléens indépendants)', () => {
  it('amont connecté (cat 22, h>0) ; aval non (cat 21, h=0) — cas idAdf 2714', () => {
    const mods = [mod('22', 1), mod('13', 7), mod('21', 0)];
    expect(eppConnecte(mods, 'amont')).toBe(true);
    expect(eppConnecte(mods, 'aval')).toBe(false);
  });
  it('aval connecté, amont non — cas idAdf 2691', () => {
    const mods = [mod('22', 0), mod('4', 4), mod('21', 1)];
    expect(eppConnecte(mods, 'amont')).toBe(false);
    expect(eppConnecte(mods, 'aval')).toBe(true);
  });
  it('aucun EPP connecté (h=0 partout) — cas CBCT idAdf 2656', () => {
    const mods = [mod('22', 0), mod('15', 3.5), mod('21', 0)];
    expect(eppConnecte(mods, 'amont')).toBe(false);
    expect(eppConnecte(mods, 'aval')).toBe(false);
  });
  it('pas de module EPP du tout → false', () => {
    expect(eppConnecte([mod('15', 3.5)], 'amont')).toBe(false);
  });
});

describe('hasEpp / deriveEligibleDpc', () => {
  it('hasEpp : ∃ module cat 22 ou 21', () => {
    expect(hasEpp([mod('22', 0), mod('15', 3.5)])).toBe(true);
    expect(hasEpp([mod('15', 3.5), mod('21', 0)])).toBe(true);
    expect(hasEpp([mod('15', 3.5)])).toBe(false); // pas d'EPP
    expect(hasEpp([])).toBe(false);
  });
  it('deriveEligibleDpc : eligible_dpc="1" du module CŒUR', () => {
    // cœur cat 15 = "1" → éligible (les EPP à "0" ne comptent pas)
    expect(deriveEligibleDpc([mod('22', 0, '', '0'), mod('15', 3.5, '', '1'), mod('21', 0, '', '0')])).toBe(true);
    // cœur cat 3 = "0" → non éligible
    expect(deriveEligibleDpc([mod('3', 0, '', '0'), mod('22', 0, '', '1')])).toBe(false);
    // pas de cœur → repli sur le 1er module
    expect(deriveEligibleDpc([mod('22', 0, '', '1')])).toBe(true);
    expect(deriveEligibleDpc([])).toBe(false);
  });
});

describe('deriveNumeroCompteProduit', () => {
  it('ADF renseigné → gardé tel quel (idAdf 2656)', () => {
    const mods = [mod('22', 0, '92622425420'), mod('15', 3.5, '92622425420')];
    expect(deriveNumeroCompteProduit('92622425420', mods)).toBe('92622425420');
  });
  it('ADF vide → num du module CŒUR, PAS l\'EPP (idAdf 2408 : cœur ...368 vs EPP ...382)', () => {
    const mods = [mod('22', 0, '92622425382'), mod('3', 0, '92622425368'), mod('21', 0, '92622425382')];
    expect(deriveNumeroCompteProduit('', mods)).toBe('92622425368');
    expect(deriveNumeroCompteProduit(null, mods)).toBe('92622425368');
  });
  it('ADF vide, modules à num unique (composée CBCT 2895) → ce num', () => {
    const mods = [mod('22', 0, '92622425420'), mod('15', 3.5, '92622425420'), mod('21', 0, '92622425420')];
    expect(deriveNumeroCompteProduit('', mods)).toBe('92622425420');
  });
  it('aucun cœur avec num → repli sur 1er module portant un num', () => {
    expect(deriveNumeroCompteProduit('', [mod('22', 0, '999')])).toBe('999');
  });
  it('aucun num nulle part → null', () => {
    expect(deriveNumeroCompteProduit('', [mod('15', 3.5, '')])).toBeNull();
    expect(deriveNumeroCompteProduit('', [])).toBeNull();
  });
});
