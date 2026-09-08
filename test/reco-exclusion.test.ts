// test/reco-exclusion.test.ts — exclusion du backfill (pur, aucun I/O, aucun mock).
// Chaque cas vaut 5 appels Dendreo : un faux positif fige une session vivante,
// un faux négatif ne coûte que des appels. Les défauts penchent donc vers "traiter".
import { describe, it, expect } from 'vitest';
import { ANNEE_ANCIENNE_MAX, estSessionExclue } from '../src/reco/exclusion';
import type { MiroirFacture } from '../src/reco/exclusion';
import { RECO_START_YEAR } from '../src/reco/years';

/** Entrée miroir lisible : montant, paiement facture unique, paiement facture 2. */
const miroir = (
  factureMontantHt: number | null,
  factureDatePaiement: string | null,
  facture2DatePaiement: string | null,
): MiroirFacture => ({ factureMontantHt, factureDatePaiement, facture2DatePaiement });

const normale = (dateDebut: string) => ({ aCheval: false, dateDebut });
const cheval = (dateDebut: string) => ({ aCheval: true, dateDebut });

// Millésimes hors règle B, pour isoler la règle A sans interférence.
const RECENTE = `${ANNEE_ANCIENNE_MAX + 1}-04-01`;
const RECENTE_CHEVAL = `${ANNEE_ANCIENNE_MAX + 1}-11-20`;

describe('règle A — session entièrement payée', () => {
  it('1) normale : montant > 0 + factureDatePaiement → exclue', () => {
    expect(estSessionExclue(normale(RECENTE), miroir(2400, '2026-03-10', null))).toBe('payee');
  });

  it('2) à cheval : montant > 0 + facture2DatePaiement → exclue', () => {
    expect(estSessionExclue(cheval(RECENTE_CHEVAL), miroir(2400, null, '2027-01-15'))).toBe('payee');
  });

  it('3) à cheval : facture 1 payée mais PAS la 2 → traitée (le dossier n\'est pas soldé)', () => {
    expect(estSessionExclue(cheval(RECENTE_CHEVAL), miroir(2400, '2026-03-10', null))).toBeNull();
  });

  it('4) pas de montant (null, 0, négatif) → traitée', () => {
    expect(estSessionExclue(normale(RECENTE), miroir(null, '2026-03-10', null))).toBeNull();
    expect(estSessionExclue(normale(RECENTE), miroir(0, '2026-03-10', null))).toBeNull();
    expect(estSessionExclue(normale(RECENTE), miroir(-10, '2026-03-10', null))).toBeNull();
  });

  it('5) pas de date de paiement (null, vide, espaces) → traitée', () => {
    expect(estSessionExclue(normale(RECENTE), miroir(2400, null, null))).toBeNull();
    expect(estSessionExclue(normale(RECENTE), miroir(2400, '', null))).toBeNull();
    expect(estSessionExclue(normale(RECENTE), miroir(2400, '   ', null))).toBeNull();
  });
});

describe('règle B — session normale ancienne', () => {
  it(`6) non à cheval, début ${ANNEE_ANCIENNE_MAX}, absente du miroir → exclue`, () => {
    expect(estSessionExclue(normale(`${ANNEE_ANCIENNE_MAX}-06-01`), undefined)).toBe('ancienne');
  });

  it(`7) non à cheval, début ${ANNEE_ANCIENNE_MAX + 1} → traitée (borne stricte)`, () => {
    expect(estSessionExclue(normale(`${ANNEE_ANCIENNE_MAX + 1}-01-05`), undefined)).toBeNull();
  });

  it('8) INVARIANT : la règle B ne touche JAMAIS une session à cheval', () => {
    // Une session à cheval 2025/2026 vit encore en 2026 : l'ancienneté ne doit
    // pas la figer. Seule sa facture 2 payée (règle A) peut l'exclure.
    expect(estSessionExclue(cheval(`${ANNEE_ANCIENNE_MAX}-11-20`), undefined)).toBeNull();
    expect(estSessionExclue(cheval(`${ANNEE_ANCIENNE_MAX - 1}-11-20`), undefined)).toBeNull();
    expect(estSessionExclue(cheval(`${ANNEE_ANCIENNE_MAX}-11-20`), miroir(2400, '2026-03-10', null))).toBeNull();
  });
});

describe('défauts sûrs — dans le doute, on TRAITE', () => {
  it('9) session absente du miroir (jamais synchronisée) → traitée, jamais "payée"', () => {
    expect(estSessionExclue(normale(RECENTE), undefined)).toBeNull();
    expect(estSessionExclue(cheval(RECENTE_CHEVAL), undefined)).toBeNull();
  });

  it('10) dateDebut vide ou illisible → règle B inapplicable (on ne devine pas l\'année)', () => {
    expect(estSessionExclue(normale(''), undefined)).toBeNull();
    expect(estSessionExclue(normale('(vide)'), undefined)).toBeNull();
    expect(estSessionExclue(normale('0000-00-00'), undefined)).toBeNull();
    expect(estSessionExclue(normale('1899-01-01'), undefined)).toBeNull();
    // ... mais une session vide ET payée reste exclue par A.
    expect(estSessionExclue(normale(''), miroir(2400, '2026-03-10', null))).toBe('payee');
  });

  it('12) champs miroir de type inattendu (doc mal formé) → jamais d\'exclusion par A', () => {
    const malForme = { factureMontantHt: '2400', factureDatePaiement: 42, facture2DatePaiement: {} };
    expect(estSessionExclue(normale(RECENTE), malForme as unknown as MiroirFacture)).toBeNull();
    expect(estSessionExclue(cheval(RECENTE_CHEVAL), malForme as unknown as MiroirFacture)).toBeNull();
  });
});

describe('cumul des règles & cohérence', () => {
  it('11) A ET B vraies → motif "payee" (A prioritaire, compteurs stables)', () => {
    expect(estSessionExclue(normale(`${ANNEE_ANCIENNE_MAX}-03-01`), miroir(2400, '2026-03-10', null)))
      .toBe('payee');
  });

  it('13) ANNEE_ANCIENNE_MAX suit RECO_START_YEAR (à remonter ensemble)', () => {
    expect(ANNEE_ANCIENNE_MAX).toBe(RECO_START_YEAR);
  });
});
