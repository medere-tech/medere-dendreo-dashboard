// test/reco-exclusion.test.ts — exclusion du backfill (pur, aucun I/O, aucun mock).
// Chaque cas vaut 5 appels Dendreo : un faux positif fige une session vivante,
// un faux négatif ne coûte que des appels. Les défauts penchent donc vers "traiter".
import { describe, it, expect } from 'vitest';
import { ANNEE_ANCIENNE_MAX, FENETRE_PAIEMENT_RECENT_JOURS, estSessionExclue } from '../src/reco/exclusion';
import type { MiroirFacture } from '../src/reco/exclusion';
import { RECO_START_YEAR } from '../src/reco/years';

/** Jour de référence FIGÉ → tests déterministes. */
const TODAY = '2026-10-06';

/** Jour "AAAA-MM-JJ" situé `n` jours AVANT TODAY (n < 0 → dans le futur). Calendrier pur, sans fuseau. */
const ilYa = (n: number): string => {
  const t = Date.UTC(2026, 9, 6) - n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
};

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
const ANCIEN_PAIEMENT = ilYa(100); // > 90 j → règle A active

describe('ilYa (outil de test)', () => {
  it('calcule les jours calendaires sans fuseau', () => {
    expect(ilYa(0)).toBe('2026-10-06');
    expect(ilYa(90)).toBe('2026-07-08');
    expect(ilYa(-1)).toBe('2026-10-07');
  });
});

describe('règle A — session entièrement payée (paiement ANCIEN)', () => {
  it('1) normale : montant > 0 + factureDatePaiement ancien → exclue', () => {
    expect(estSessionExclue(normale(RECENTE), miroir(2400, ANCIEN_PAIEMENT, null), TODAY)).toBe('payee');
  });

  it('2) à cheval : montant > 0 + facture2DatePaiement ancien → exclue', () => {
    expect(estSessionExclue(cheval(RECENTE_CHEVAL), miroir(2400, null, ANCIEN_PAIEMENT), TODAY)).toBe('payee');
  });

  it('3) à cheval : facture 1 payée mais PAS la 2 → traitée (le dossier n\'est pas soldé)', () => {
    expect(estSessionExclue(cheval(RECENTE_CHEVAL), miroir(2400, ANCIEN_PAIEMENT, null), TODAY)).toBeNull();
  });

  it('4) pas de montant (null, 0, négatif) → traitée (non payée → jamais A)', () => {
    expect(estSessionExclue(normale(RECENTE), miroir(null, ANCIEN_PAIEMENT, null), TODAY)).toBeNull();
    expect(estSessionExclue(normale(RECENTE), miroir(0, ANCIEN_PAIEMENT, null), TODAY)).toBeNull();
    expect(estSessionExclue(normale(RECENTE), miroir(-10, ANCIEN_PAIEMENT, null), TODAY)).toBeNull();
  });

  it('5) pas de date de paiement (null, vide, espaces) → traitée', () => {
    expect(estSessionExclue(normale(RECENTE), miroir(2400, null, null), TODAY)).toBeNull();
    expect(estSessionExclue(normale(RECENTE), miroir(2400, '', null), TODAY)).toBeNull();
    expect(estSessionExclue(normale(RECENTE), miroir(2400, '   ', null), TODAY)).toBeNull();
  });
});

describe(`règle A assouplie — payée RÉCEMMENT (≤ ${FENETRE_PAIEMENT_RECENT_JOURS} j) → reste dans le cron`, () => {
  it('fenêtre = 90 jours', () => {
    expect(FENETRE_PAIEMENT_RECENT_JOURS).toBe(90);
  });

  it('payée il y a 100 jours → exclue A', () => {
    expect(estSessionExclue(normale(RECENTE), miroir(2400, ilYa(100), null), TODAY)).toBe('payee');
  });

  it('payée il y a 30 jours → PAS exclue (traitée)', () => {
    expect(estSessionExclue(normale(RECENTE), miroir(2400, ilYa(30), null), TODAY)).toBeNull();
  });

  it('borne : 90 jours pile → gardée ; 91 jours → exclue', () => {
    expect(estSessionExclue(normale(RECENTE), miroir(2400, ilYa(90), null), TODAY)).toBeNull();
    expect(estSessionExclue(normale(RECENTE), miroir(2400, ilYa(91), null), TODAY)).toBe('payee');
  });

  it('payée aujourd\'hui (0 j) → gardée', () => {
    expect(estSessionExclue(normale(RECENTE), miroir(2400, ilYa(0), null), TODAY)).toBeNull();
  });

  it('date de paiement FUTURE → pas exclue A (date douteuse : on garde)', () => {
    expect(estSessionExclue(normale(RECENTE), miroir(2400, ilYa(-1), null), TODAY)).toBeNull();
    expect(estSessionExclue(normale(RECENTE), miroir(2400, '2027-01-15', null), TODAY)).toBeNull();
  });

  it('date de paiement ILLISIBLE → pas exclue A', () => {
    expect(estSessionExclue(normale(RECENTE), miroir(2400, 'pas une date', null), TODAY)).toBeNull();
    expect(estSessionExclue(normale(RECENTE), miroir(2400, '0000-00-00', null), TODAY)).toBeNull(); // date zéro MySQL
    expect(estSessionExclue(normale(RECENTE), miroir(2400, '2026-02-31', null), TODAY)).toBeNull(); // jour inexistant
  });

  it('today invalide → aucun paiement « ancien » → A inactive (défaut sûr)', () => {
    expect(estSessionExclue(normale(RECENTE), miroir(2400, ANCIEN_PAIEMENT, null), '')).toBeNull();
    expect(estSessionExclue(normale(RECENTE), miroir(2400, ANCIEN_PAIEMENT, null), 'n/a')).toBeNull();
  });

  it('accepte une date de paiement avec heure (slice 0,10)', () => {
    expect(estSessionExclue(normale(RECENTE), miroir(2400, `${ilYa(100)} 10:00:00`, null), TODAY)).toBe('payee');
    expect(estSessionExclue(normale(RECENTE), miroir(2400, `${ilYa(10)}T08:00:00`, null), TODAY)).toBeNull();
  });

  it(`payée récemment MAIS ancienne (non cheval, début ${ANNEE_ANCIENNE_MAX}) → exclue par B, pas par A`, () => {
    expect(estSessionExclue(normale(`${ANNEE_ANCIENNE_MAX}-03-01`), miroir(2400, ilYa(30), null), TODAY)).toBe('ancienne');
  });

  it('à cheval, facture 2 payée récemment → gardée', () => {
    expect(estSessionExclue(cheval(RECENTE_CHEVAL), miroir(2400, null, ilYa(30)), TODAY)).toBeNull();
  });

  it('à cheval, facture 2 payée il y a 100 j → exclue A', () => {
    expect(estSessionExclue(cheval(RECENTE_CHEVAL), miroir(2400, null, ilYa(100)), TODAY)).toBe('payee');
  });

  it('à cheval : c\'est la date de la FACTURE 2 qui compte, pas la facture 1', () => {
    // facture 1 payée il y a longtemps, facture 2 récente → gardée
    expect(estSessionExclue(cheval(RECENTE_CHEVAL), miroir(2400, ilYa(300), ilYa(10)), TODAY)).toBeNull();
  });
});

describe('règle B — session normale ancienne (INCHANGÉE)', () => {
  it(`6) non à cheval, début ${ANNEE_ANCIENNE_MAX}, absente du miroir → exclue`, () => {
    expect(estSessionExclue(normale(`${ANNEE_ANCIENNE_MAX}-06-01`), undefined, TODAY)).toBe('ancienne');
  });

  it(`7) non à cheval, début ${ANNEE_ANCIENNE_MAX + 1} → traitée (borne stricte)`, () => {
    expect(estSessionExclue(normale(`${ANNEE_ANCIENNE_MAX + 1}-01-05`), undefined, TODAY)).toBeNull();
  });

  it('8) INVARIANT : la règle B ne touche JAMAIS une session à cheval', () => {
    // Une session à cheval 2025/2026 vit encore en 2026 : l'ancienneté ne doit
    // pas la figer. Seule sa facture 2 payée (règle A) peut l'exclure.
    expect(estSessionExclue(cheval(`${ANNEE_ANCIENNE_MAX}-11-20`), undefined, TODAY)).toBeNull();
    expect(estSessionExclue(cheval(`${ANNEE_ANCIENNE_MAX - 1}-11-20`), undefined, TODAY)).toBeNull();
    expect(estSessionExclue(cheval(`${ANNEE_ANCIENNE_MAX}-11-20`), miroir(2400, ANCIEN_PAIEMENT, null), TODAY)).toBeNull();
  });
});

describe('défauts sûrs — dans le doute, on TRAITE', () => {
  it('9) session absente du miroir (jamais synchronisée) → traitée, jamais "payée"', () => {
    expect(estSessionExclue(normale(RECENTE), undefined, TODAY)).toBeNull();
    expect(estSessionExclue(cheval(RECENTE_CHEVAL), undefined, TODAY)).toBeNull();
  });

  it('10) dateDebut vide ou illisible → règle B inapplicable (on ne devine pas l\'année)', () => {
    expect(estSessionExclue(normale(''), undefined, TODAY)).toBeNull();
    expect(estSessionExclue(normale('(vide)'), undefined, TODAY)).toBeNull();
    expect(estSessionExclue(normale('0000-00-00'), undefined, TODAY)).toBeNull();
    expect(estSessionExclue(normale('1899-01-01'), undefined, TODAY)).toBeNull();
    // ... mais une session vide ET payée (anciennement) reste exclue par A.
    expect(estSessionExclue(normale(''), miroir(2400, ANCIEN_PAIEMENT, null), TODAY)).toBe('payee');
  });

  it('12) champs miroir de type inattendu (doc mal formé) → jamais d\'exclusion par A', () => {
    const malForme = { factureMontantHt: '2400', factureDatePaiement: 42, facture2DatePaiement: {} };
    expect(estSessionExclue(normale(RECENTE), malForme as unknown as MiroirFacture, TODAY)).toBeNull();
    expect(estSessionExclue(cheval(RECENTE_CHEVAL), malForme as unknown as MiroirFacture, TODAY)).toBeNull();
  });
});

describe('cumul des règles & cohérence', () => {
  it('11) A ET B vraies → motif "payee" (A prioritaire, compteurs stables)', () => {
    expect(estSessionExclue(normale(`${ANNEE_ANCIENNE_MAX}-03-01`), miroir(2400, ANCIEN_PAIEMENT, null), TODAY))
      .toBe('payee');
  });

  it('13) ANNEE_ANCIENNE_MAX suit RECO_START_YEAR (à remonter ensemble)', () => {
    expect(ANNEE_ANCIENNE_MAX).toBe(RECO_START_YEAR);
  });
});
