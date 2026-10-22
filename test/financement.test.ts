// test/financement.test.ts — Fonctions PURES d'enrichissement financements/factures (S11.1).
// Cas RÉELS (recons S11.0a→g) : financement mixte, participant sans financement, 0/≥2 factures.

import { describe, it, expect, vi } from 'vitest';
import { DendreoClient } from '../src/dendreo/client';
import {
  ANDPC_ID,
  parseMontant,
  toParisDay,
  sumMontantAndpc,
  aggregateFacturesAndpc,
  splitFacturesAcheval,
  detectIncoherencesFactures,
  buildFinanceurByParticipant,
  buildCommercialIdByParticipant,
  buildParcoursByParticipant,
  enrichFinancement,
  loadCommerciauxReferentiel,
  __resetCommerciauxReferentiel,
  type FinancementLine,
  type FactureLine,
  type LapLink,
} from '../src/dendreo/financement';

const fin = (idFinance: string, idFinanceur: string, type: string, montant: number): FinancementLine =>
  ({ idFinance, idFinanceur, type, montant });
const fac = (
  idOpca: string,
  montantHt: number | null,
  dateEnvoi: string | null,
  datePaiement: string | null,
  dateEmission: string | null = null,
  idFacture = '', // S15 : départage du tri quand deux factures partagent la date d'émission
  idParent: string | null = null, // avoir → id_facture de la facture annulée
  montantTotalPaiements: number | null = null, // montant encaissé (montant_total_paiements)
): FactureLine => ({ idFacture, idOpca, montantHt, dateEnvoi, datePaiement, dateEmission, idParent, montantTotalPaiements });

describe('parseMontant / toParisDay', () => {
  it('parseMontant gère virgule décimale, chaîne Dendreo et vide', () => {
    expect(parseMontant('560,5000')).toBe(560.5);
    expect(parseMontant('16929.00')).toBe(16929);
    expect(parseMontant('')).toBe(0);
    expect(parseMontant(null)).toBe(0);
  });

  it('toParisDay tronque au jour, sans conversion UTC ; vide → null', () => {
    expect(toParisDay('2026-05-11 00:00:00')).toBe('2026-05-11');
    expect(toParisDay('2026-06-12 23:59:59')).toBe('2026-06-12'); // pas de bascule de jour (aucun UTC)
    expect(toParisDay('')).toBeNull();
    expect(toParisDay(null)).toBeNull();
  });
});

describe('sumMontantAndpc', () => {
  it('somme UNIQUEMENT les lignes id_financeur=360 (session mixte ANDPC + particulier)', () => {
    const lines = [
      fin('e1', ANDPC_ID, 'opca', 560.5),
      fin('e2', ANDPC_ID, 'opca', 684),
      fin('e3', '449369', 'particulier', 297), // hors ANDPC → ignoré
    ];
    expect(sumMontantAndpc(lines)).toBe(1244.5);
  });

  it('aucune ligne ANDPC → null', () => {
    expect(sumMontantAndpc([fin('e1', '449369', 'particulier', 297)])).toBeNull();
    expect(sumMontantAndpc([])).toBeNull();
  });
});

describe('aggregateFacturesAndpc — S13.3 : dépôt (TOUTES) vs paiement (PAYÉES)', () => {
  it('cas réel session 3246 : payée + déposée non payée → dateEnvoi = dépôt le plus ancien, montant/paiement sur la payée', () => {
    // FA-2026-0766 payée (envoi 03/07, HT 1111.50, paie 20/07)
    // + FA-2026-0794 DÉPOSÉE non payée (envoi 13/07, HT 4056.50) → compte pour dateEnvoi seulement.
    const r = aggregateFacturesAndpc([
      fac(ANDPC_ID, 1111.5, '2026-07-03', '2026-07-20'), // FA-2026-0766 (payée)
      fac(ANDPC_ID, 4056.5, '2026-07-13', null),         // FA-2026-0794 (déposée, non payée)
    ]);
    expect(r).toEqual({ montantHt: 1111.5, dateEnvoi: '2026-07-03', datePaiement: '2026-07-20', montantDepose: 5168 });
  });

  it('facture NON payée déposée AVANT la payée → dateEnvoi = celle de la NON payée', () => {
    const r = aggregateFacturesAndpc([
      fac(ANDPC_ID, 1111.5, '2026-07-13', '2026-07-20'), // payée, déposée le 13
      fac(ANDPC_ID, 4056.5, '2026-07-03', null),         // NON payée, déposée le 03 → gagne
    ]);
    expect(r).toEqual({ montantHt: 1111.5, dateEnvoi: '2026-07-03', datePaiement: '2026-07-20', montantDepose: 5168 });
  });

  it('2 factures PAYÉES → somme des deux HT + paiement le plus récent + envoi le plus ancien', () => {
    const r = aggregateFacturesAndpc([
      fac(ANDPC_ID, 4056.5, '2026-06-12', '2026-06-25'),
      fac(ANDPC_ID, 1111.5, '2026-06-01', '2026-06-20'),
    ]);
    expect(r).toEqual({ montantHt: 5168, dateEnvoi: '2026-06-01', datePaiement: '2026-06-25', montantDepose: 5168 });
  });

  it('1 facture PAYÉE seule → les 3 champs remplis', () => {
    const r = aggregateFacturesAndpc([fac(ANDPC_ID, 1111.5, '2026-07-03', '2026-07-20')]);
    expect(r).toEqual({ montantHt: 1111.5, dateEnvoi: '2026-07-03', datePaiement: '2026-07-20', montantDepose: 1111.5 });
  });

  it('1 facture DÉPOSÉE non payée seule → dateEnvoi remplie, montantHt et datePaiement null', () => {
    const r = aggregateFacturesAndpc([fac(ANDPC_ID, 4056.5, '2026-07-13', null)]);
    expect(r).toEqual({ montantHt: null, dateEnvoi: '2026-07-13', datePaiement: null, montantDepose: 4056.5 });
  });

  it('plusieurs factures déposées, AUCUNE payée → dateEnvoi = la plus ancienne, montant/paiement null', () => {
    const r = aggregateFacturesAndpc([
      fac(ANDPC_ID, 1111.5, '2026-07-03', null),
      fac(ANDPC_ID, 4056.5, '2026-07-13', null),
    ]);
    expect(r).toEqual({ montantHt: null, dateEnvoi: '2026-07-03', datePaiement: null, montantDepose: 5168 });
  });

  it('date_envoi : une facture sans date_envoi + une avec → celle qui existe', () => {
    const r = aggregateFacturesAndpc([
      fac(ANDPC_ID, 100, null, '2026-04-01'),         // payée, sans date_envoi
      fac(ANDPC_ID, 200, '2026-03-03', '2026-04-02'), // payée, avec date_envoi
    ]);
    expect(r.dateEnvoi).toBe('2026-03-03');
  });

  it('factures ANDPC existantes mais AUCUNE date_envoi → dateEnvoi null', () => {
    const r = aggregateFacturesAndpc([fac(ANDPC_ID, 4056.5, null, null)]);
    expect(r).toEqual({ montantHt: null, dateEnvoi: null, datePaiement: null, montantDepose: null });
  });

  it('0 facture ANDPC → les 3 champs null (liste vide ou seulement non-360)', () => {
    expect(aggregateFacturesAndpc([])).toEqual({ montantHt: null, dateEnvoi: null, datePaiement: null, montantDepose: null });
    expect(aggregateFacturesAndpc([fac('449369', 300, '2026-01-01', '2026-01-10')]))
      .toEqual({ montantHt: null, dateEnvoi: null, datePaiement: null, montantDepose: null });
  });

  it('ne filtre RIEN d\'autre que id_opca=360 (avoirs non traités), y compris pour la date de dépôt', () => {
    const r = aggregateFacturesAndpc([
      fac(ANDPC_ID, 500, '2026-02-01', '2026-02-10'), // 360 payée → comptée
      fac('2669', 999, '2026-01-01', '2026-01-10'),   // autre financeur → exclu (même pour dateEnvoi)
    ]);
    expect(r).toEqual({ montantHt: 500, dateEnvoi: '2026-02-01', datePaiement: '2026-02-10', montantDepose: 500 });
  });
});

describe('aggregateFacturesAndpc — montantDepose : déposées (date_envoi) vs payées', () => {
  it('2 ANDPC déposées, une payée une non → déposé = somme des 2, payé = la payée seule (asymétrie voulue)', () => {
    const r = aggregateFacturesAndpc([
      fac(ANDPC_ID, 1111.5, '2026-07-03', '2026-07-20'), // déposée + payée
      fac(ANDPC_ID, 4056.5, '2026-07-13', null),         // déposée, NON payée
    ]);
    expect(r.montantDepose).toBe(5168);
    expect(r.montantHt).toBe(1111.5);
  });

  it('cas 3328 : ANDPC payée SANS date_envoi → hors déposé, dans payé (déposé < payé possible)', () => {
    const r = aggregateFacturesAndpc([
      fac(ANDPC_ID, 16837.2, null, '2025-12-22'),       // payée, jamais "déposée" au sens date_envoi
      fac(ANDPC_ID, 4542.2, '2026-07-29', '2026-08-10'), // déposée + payée
    ]);
    expect(r.montantDepose).toBe(4542.2);
    expect(r.montantHt).toBe(21379.4);
    expect(r.montantDepose!).toBeLessThan(r.montantHt!);
  });

  it('aucune facture ANDPC → montantDepose null', () => {
    expect(aggregateFacturesAndpc([]).montantDepose).toBeNull();
    expect(aggregateFacturesAndpc([fac('449369', 300, '2026-01-01', null)]).montantDepose).toBeNull();
  });

  it('facture NON-ANDPC (id_opca ≠ 360) avec date_envoi → ignorée', () => {
    const r = aggregateFacturesAndpc([
      fac(ANDPC_ID, 500, '2026-02-01', null),
      fac('2669', 999, '2026-01-01', null), // autre financeur, déposée → exclue
    ]);
    expect(r.montantDepose).toBe(500);
  });

  it('date_envoi vide ("") traitée comme absente ; montant null ignoré', () => {
    const r = aggregateFacturesAndpc([
      fac(ANDPC_ID, 700, '', null),             // "" → non déposée
      fac(ANDPC_ID, null, '2026-03-01', null),  // déposée sans montant → ignorée dans la somme
      fac(ANDPC_ID, 300, '2026-03-02', null),
    ]);
    expect(r.montantDepose).toBe(300);
  });

  // --- Avoirs : règle LIÉE {facture, avoir} via id_parent ------------------------
  // Un avoir (HT < 0) n'est soustrait QUE si sa parente (idFacture === avoir.idParent)
  // est une « comptée positive » (HT > 0 ET date_envoi). Recon 200 sessions : 17/17.
  /** Avoir : id propre + id_parent → parente ; sans date_envoi (cas réel). */
  const avoir = (idFacture: string, montantHt: number, idParent: string | null, datePaiement: string | null = null) =>
    fac(ANDPC_ID, montantHt, null, datePaiement, null, idFacture, idParent);

  it('cas réel 3636 : retoquée (comptée) + avoir qui la pointe + refaite → avoir soustrait → 5700', () => {
    const r = aggregateFacturesAndpc([
      fac(ANDPC_ID, 5852, '2026-03-02', null, null, '4848'),          // 1re demande, RETOQUÉE (comptée)
      avoir('4901', -5852, '4848', '2026-03-20'),                       // AVOIR → parente 4848 comptée
      fac(ANDPC_ID, 5700, '2026-03-25', '2026-04-15', null, '4950'),   // demande refaite, payée
    ]);
    expect(r.montantDepose).toBe(5700); // et non 11552
  });

  it("cas 2948 : avoir dont la parente n'a PAS de date_envoi → avoir IGNORÉ → 12502 (pas −532)", () => {
    const r = aggregateFacturesAndpc([
      fac(ANDPC_ID, 13034, null, null, null, '3100'),                  // parente SANS date_envoi → non comptée
      avoir('3101', -13034, '3100'),                                    // → ignoré (sinon retranche un montant jamais ajouté)
      fac(ANDPC_ID, 12502, '2026-02-10', '2026-03-01', null, '3102'),  // seule comptée positive
    ]);
    expect(r.montantDepose).toBe(12502);
  });

  it('cas 2460 : parente sans date_envoi, AUCUNE autre comptée → null (pas −6042)', () => {
    const r = aggregateFacturesAndpc([
      fac(ANDPC_ID, 6042, null, null, null, '2200'),
      avoir('2201', -6042, '2200'),
    ]);
    expect(r.montantDepose).toBeNull();
  });

  it('avoir dont la parente A une date_envoi → soustrait (annulation correcte)', () => {
    const r = aggregateFacturesAndpc([
      fac(ANDPC_ID, 1000, '2026-02-01', null, null, 'A'),
      avoir('B', -400, 'A'),                                           // avoir partiel sur A comptée
      fac(ANDPC_ID, 250, '2026-02-15', null, null, 'C'),
    ]);
    expect(r.montantDepose).toBe(850); // 1000 − 400 + 250
  });

  it("annulation totale d'une comptée seule → 0 (pas null : il y a bien une comptée positive)", () => {
    const r = aggregateFacturesAndpc([fac(ANDPC_ID, 1000, '2026-02-01', null, null, 'A'), avoir('B', -1000, 'A')]);
    expect(r.montantDepose).toBe(0);
  });

  it('avoir SANS id_parent, ou pointant une facture absente → ignoré', () => {
    const r = aggregateFacturesAndpc([
      fac(ANDPC_ID, 500, '2026-02-01', null, null, 'A'),
      avoir('B', -500, null),
      avoir('C', -500, 'ZZZ'),
    ]);
    expect(r.montantDepose).toBe(500);
  });

  it("facture POSITIVE sans date_envoi, pas d'avoir → exclue (null)", () => {
    expect(aggregateFacturesAndpc([fac(ANDPC_ID, 2000, null, null)]).montantDepose).toBeNull();
  });

  it("non-régression 3164 (à cheval) : 2 positives déposées, pas d'avoir → 10687.50", () => {
    const r = aggregateFacturesAndpc([
      fac(ANDPC_ID, 6982.5, '2026-05-04', null),
      fac(ANDPC_ID, 3705, '2026-05-18', null),
    ]);
    expect(r.montantDepose).toBe(10687.5);
  });

  it('non-régression 3818 : 1 positive déposée → 7695', () => {
    expect(aggregateFacturesAndpc([fac(ANDPC_ID, 7695, '2026-06-10', null)]).montantDepose).toBe(7695);
  });

  it("montantHt (payé) INCHANGÉ par la règle liée : l'avoir payé reste dans le payé", () => {
    const r = aggregateFacturesAndpc([
      fac(ANDPC_ID, 5852, '2026-03-02', '2026-03-10', null, '4848'),
      avoir('4901', -5852, '4848', '2026-03-20'),
      fac(ANDPC_ID, 5700, '2026-03-25', '2026-04-15', null, '4950'),
    ]);
    expect(r.montantHt).toBe(5700); // 5852 − 5852 + 5700 : calcul payé historique
  });
});

// --- S15 : FACTURE 1 / FACTURE 2 des sessions À CHEVAL -----------------------
// Cas RÉELS (recon 3246 + 3328) : le tri par date_emission croissante rattache la
// position 1 au budget de l'année de DÉBUT, la position 2 à celui de l'année de FIN.
describe('splitFacturesAcheval — S15', () => {
  const VIDE = {
    facture1DateEnvoi: null, facture1DatePaiement: null, facture1MontantPaye: null,
    facture2DateEnvoi: null, facture2DatePaiement: null, facture2MontantPaye: null,
  };

  it('cas réel 3246 (début 2025-07 → fin 2026-05) : F1 payée, F2 déposée non payée', () => {
    // FA-2026-0766 (id 4594) émise le 03/07 = budget 2025 ; FA-2026-0794 (id 4622)
    // émise le 13/07 = budget 2026. Les DEUX sont émises en 2026 : c'est bien l'ORDRE
    // qui discrimine, jamais l'année d'émission.
    const factures = [
      fac(ANDPC_ID, 1111.5, '2026-07-03', '2026-07-20', '2026-07-03', '4594', null, 1111.5),
      fac(ANDPC_ID, 4056.5, '2026-07-13', null, '2026-07-13', '4622', null, 0),
    ];
    expect(splitFacturesAcheval(factures, true)).toEqual({
      facture1DateEnvoi: '2026-07-03', facture1DatePaiement: '2026-07-20', facture1MontantPaye: 1111.5,
      facture2DateEnvoi: '2026-07-13', facture2DatePaiement: null, facture2MontantPaye: null,
    });
  });

  it('l\'ordre d\'arrivée de Dendreo n\'influe PAS (le tri fait foi)', () => {
    const desordre = [
      fac(ANDPC_ID, 4056.5, '2026-07-13', null, '2026-07-13', '4622'),
      fac(ANDPC_ID, 1111.5, '2026-07-03', '2026-07-20', '2026-07-03', '4594'),
    ];
    expect(splitFacturesAcheval(desordre, true).facture1DateEnvoi).toBe('2026-07-03');
  });

  it('cas réel 3328 (début 2025-12 → fin 2026-03) : F1 payée SANS date_envoi, F2 envoyée non payée', () => {
    // FA-2025-1133 (id 3771) émise 10/12/2025, date_envoi VIDE, payée le 22/12/2025 ;
    // FA-2026-0851 (id 4679) émise+envoyée le 29/07/2026, non payée.
    const factures = [
      fac(ANDPC_ID, 16837.2, null, '2025-12-22', '2025-12-10', '3771', null, 16837.2),
      fac(ANDPC_ID, 4542.2, '2026-07-29', null, '2026-07-29', '4679', null, 0),
    ];
    expect(splitFacturesAcheval(factures, true)).toEqual({
      facture1DateEnvoi: null, facture1DatePaiement: '2025-12-22', facture1MontantPaye: 16837.2,
      facture2DateEnvoi: '2026-07-29', facture2DatePaiement: null, facture2MontantPaye: null,
    });
  });

  it('session NON à cheval → les 4 champs null, MÊME avec 2 factures ANDPC', () => {
    const factures = [
      fac(ANDPC_ID, 1111.5, '2026-07-03', '2026-07-20', '2026-07-03', '4594'),
      fac(ANDPC_ID, 4056.5, '2026-07-13', null, '2026-07-13', '4622'),
    ];
    expect(splitFacturesAcheval(factures, false)).toEqual(VIDE);
  });

  it('à cheval avec UNE SEULE facture ANDPC → F1 remplie, F2 null (on n\'invente pas)', () => {
    const r = splitFacturesAcheval([fac(ANDPC_ID, 1111.5, '2026-07-03', '2026-07-20', '2026-07-03', '4594', null, 1111.5)], true);
    expect(r).toEqual({
      facture1DateEnvoi: '2026-07-03', facture1DatePaiement: '2026-07-20', facture1MontantPaye: 1111.5,
      facture2DateEnvoi: null, facture2DatePaiement: null, facture2MontantPaye: null,
    });
  });

  it('à cheval sans AUCUNE facture ANDPC → 4 null (liste vide, ou seulement non-360)', () => {
    expect(splitFacturesAcheval([], true)).toEqual(VIDE);
    expect(splitFacturesAcheval([fac('449369', 300, '2026-01-01', '2026-01-10', '2026-01-01', '1')], true)).toEqual(VIDE);
  });

  it('les factures non-ANDPC ne prennent JAMAIS une position (filtrées avant le tri)', () => {
    const factures = [
      fac('2669', 999, '2025-01-01', '2025-01-10', '2025-01-01', '1'), // autre financeur, la plus ancienne
      fac(ANDPC_ID, 1111.5, '2026-07-03', '2026-07-20', '2026-07-03', '4594'),
      fac(ANDPC_ID, 4056.5, '2026-07-13', null, '2026-07-13', '4622'),
    ];
    expect(splitFacturesAcheval(factures, true).facture1DateEnvoi).toBe('2026-07-03');
  });

  it('même date_emission → départage par id_facture CROISSANT (numérique, pas lexicographique)', () => {
    const factures = [
      fac(ANDPC_ID, 200, '2026-03-02', null, '2026-03-01', '1000'),
      fac(ANDPC_ID, 100, '2026-03-01', null, '2026-03-01', '999'), // 999 < 1000 → Facture 1
    ];
    const r = splitFacturesAcheval(factures, true);
    expect(r.facture1DateEnvoi).toBe('2026-03-01');
    expect(r.facture2DateEnvoi).toBe('2026-03-02');
  });

  it('facture SANS date_emission → reléguée en dernier (jamais promue Facture 1)', () => {
    const factures = [
      fac(ANDPC_ID, 100, '2026-01-05', null, null, '9000'), // pas d'émission → passe 2e
      fac(ANDPC_ID, 200, '2026-02-10', null, '2026-02-10', '9001'),
    ];
    const r = splitFacturesAcheval(factures, true);
    expect(r.facture1DateEnvoi).toBe('2026-02-10');
    expect(r.facture2DateEnvoi).toBe('2026-01-05');
  });

  it('> 2 factures ANDPC → seules les 2 plus anciennes alimentent les colonnes', () => {
    const factures = [
      fac(ANDPC_ID, 100, '2026-01-01', null, '2026-01-01', '1'),
      fac(ANDPC_ID, 200, '2026-02-01', null, '2026-02-01', '2'),
      fac(ANDPC_ID, 300, '2026-03-01', null, '2026-03-01', '3'), // ignorée par le split
    ];
    const r = splitFacturesAcheval(factures, true);
    expect(r.facture1DateEnvoi).toBe('2026-01-01');
    expect(r.facture2DateEnvoi).toBe('2026-02-01');
  });

  it('date vide ("") traitée comme absente (jamais affichée comme une date)', () => {
    const r = splitFacturesAcheval([fac(ANDPC_ID, 100, '', '', '2026-01-01', '1')], true);
    expect(r.facture1DateEnvoi).toBeNull();
    expect(r.facture1DatePaiement).toBeNull();
  });

  it('n\'altère PAS l\'agrégat existant (montant payé inchangé, cf. S13.3)', () => {
    const factures = [
      fac(ANDPC_ID, 1111.5, '2026-07-03', '2026-07-20', '2026-07-03', '4594'),
      fac(ANDPC_ID, 4056.5, '2026-07-13', null, '2026-07-13', '4622'),
    ];
    splitFacturesAcheval(factures, true);
    expect(aggregateFacturesAndpc(factures)).toEqual({
      montantHt: 1111.5, dateEnvoi: '2026-07-03', datePaiement: '2026-07-20', montantDepose: 5168,
    });
  });
});

// --- Règle C : avoirs et factures ENTIÈREMENT annulées hors slots + montants payés --
// Schémas RÉELS (recon-montants-f1-f2 + recon-paiements, 724 sessions 2025-2026) :
// une facture annulée et son avoir sont datés du même jour, montant_total_paiements = 0
// (compensation Dendreo, sans encaissement) ; les vivantes ont paiements == HT.
describe('splitFacturesAcheval — règle C (vivantes) + montants payés', () => {
  /** Facture ANDPC : (id, HT, émission, envoi, paiement, encaissé, id_parent). */
  const f = (
    idFacture: string, montantHt: number, dateEmission: string, dateEnvoi: string | null,
    datePaiement: string | null, montantTotalPaiements: number | null, idParent: string | null = null,
  ) => fac(ANDPC_ID, montantHt, dateEnvoi, datePaiement, dateEmission, idFacture, idParent, montantTotalPaiements);
  const VIDE_C = {
    facture1DateEnvoi: null, facture1DatePaiement: null, facture1MontantPaye: null,
    facture2DateEnvoi: null, facture2DatePaiement: null, facture2MontantPaye: null,
  };

  it('schéma 3306 : F1 retoquée + avoir + F1 refaite + F2 → F1 = refaite, F2 = vraie F2', () => {
    const r = splitFacturesAcheval([
      f('4503', 4123, '2026-06-10', '2026-06-10', '2026-06-18', 0),           // retoquée, annulée par 4541
      f('4541', -4123, '2026-06-18', null, '2026-06-18', 0, '4503'),          // avoir total
      f('4542', 3885.5, '2026-06-18', '2026-06-18', '2026-06-29', 3885.5),    // F1 refaite
      f('4788', 1729, '2026-09-04', '2026-09-04', '2026-09-17', 1729),        // vraie F2
    ], true);
    expect(r).toEqual({
      facture1DateEnvoi: '2026-06-18', facture1DatePaiement: '2026-06-29', facture1MontantPaye: 3885.5,
      facture2DateEnvoi: '2026-09-04', facture2DatePaiement: '2026-09-17', facture2MontantPaye: 1729,
    });
  });

  it('schéma 3248 : trois factures annulées chacune par un avoir + une vivante → F1 = vivante, F2 = null', () => {
    const annulees = [
      f('4779', 2840.5, '2026-09-03', '2026-09-04', '2026-09-08', 0),
      f('4803', -2840.5, '2026-09-08', null, '2026-09-08', 0, '4779'),
      f('4804', 2840.5, '2026-09-08', '2026-09-08', '2026-09-14', 0),
      f('4837', -2840.5, '2026-09-14', null, '2026-09-14', 0, '4804'),
      f('4838', 2840.5, '2026-09-14', null, '2026-10-08', 0),
      f('5021', -2840.5, '2026-10-08', null, '2026-10-08', 0, '4838'),
    ];
    // Réel : la vivante 5022 n'est ni envoyée ni payée → F1 vide, et SURTOUT pas les dates
    // de 4779 (ancienne règle : F1 = 4779 envoi 04/09 paiement 08/09, F2 = l'avoir 4803).
    expect(splitFacturesAcheval([...annulees, f('5022', 2840.5, '2026-10-08', null, null, 0)], true)).toEqual(VIDE_C);
    // Même schéma, 5022 envoyée + payée : ce sont SES dates/montant qui sortent en F1.
    expect(splitFacturesAcheval([...annulees, f('5022', 2840.5, '2026-10-08', '2026-10-09', '2026-10-20', 2840.5)], true))
      .toEqual({ ...VIDE_C, facture1DateEnvoi: '2026-10-09', facture1DatePaiement: '2026-10-20', facture1MontantPaye: 2840.5 });
  });

  it('schéma 2905 : avoir sur UNE seule des factures → elle sort, les 2 autres font F1/F2', () => {
    const r = splitFacturesAcheval([
      f('3265', 2244, '2025-09-17', null, '2025-10-23', 2244),
      f('4545', 171.6, '2026-06-19', null, '2026-06-19', 0),                  // annulée par 4546
      f('4546', -171.6, '2026-06-19', null, '2026-06-19', 0, '4545'),
      f('4547', 858, '2026-06-19', '2026-07-08', '2026-07-20', 858),
    ], true);
    expect(r).toEqual({
      facture1DateEnvoi: null, facture1DatePaiement: '2025-10-23', facture1MontantPaye: 2244,
      facture2DateEnvoi: '2026-07-08', facture2DatePaiement: '2026-07-20', facture2MontantPaye: 858,
    });
  });

  it('facture à 0 € DATÉE → montant payé 0 (reflet fidèle de Dendreo, pas null)', () => {
    const r = splitFacturesAcheval([f('4597', 0, '2026-07-03', null, '2026-07-03', 0)], true);
    expect(r.facture1DatePaiement).toBe('2026-07-03');
    expect(r.facture1MontantPaye).toBe(0);
  });

  it('facture NON payée (ni date, ni encaissement) → montant null, date null', () => {
    const r = splitFacturesAcheval([f('1', 1000, '2026-03-01', '2026-03-02', null, 0)], true);
    expect(r.facture1DateEnvoi).toBe('2026-03-02');
    expect(r.facture1DatePaiement).toBeNull();
    expect(r.facture1MontantPaye).toBeNull();
  });

  it('montant_total_paiements ABSENT (champ vide) → montant null même si datée (on ne devine pas)', () => {
    const r = splitFacturesAcheval([f('1', 1000, '2026-03-01', null, '2026-03-10', null)], true);
    expect(r.facture1DatePaiement).toBe('2026-03-10');
    expect(r.facture1MontantPaye).toBeNull();
  });

  it('avoir PARTIEL → la parente reste VIVANTE, montant = encaissé brut (aucun net inventé) + signalement', () => {
    const factures = [
      f('A', 1000, '2026-02-01', '2026-02-01', '2026-02-20', 1000),
      f('B', -400, '2026-02-10', null, '2026-02-10', 0, 'A'),                 // partiel : −400 ≠ −1000
      f('C', 500, '2026-03-01', '2026-03-01', null, 0),
    ];
    const r = splitFacturesAcheval(factures, true);
    expect(r.facture1DatePaiement).toBe('2026-02-20'); // A reste F1
    expect(r.facture1MontantPaye).toBe(1000); // PAS 600 : aucun calcul de net
    expect(r.facture2DateEnvoi).toBe('2026-03-01'); // l'avoir B ne prend jamais de slot
    expect(detectIncoherencesFactures(factures)).toEqual([
      { idFacture: 'A', motif: 'avoir partiel : Σ avoirs -400 (B) ≠ −HT -1000' },
    ]);
  });

  it('encaissement SANS date_paiement → montant affiché + signalement', () => {
    const factures = [f('1', 345, '2026-05-01', null, null, 345)];
    expect(splitFacturesAcheval(factures, true)).toMatchObject({ facture1DatePaiement: null, facture1MontantPaye: 345 });
    expect(detectIncoherencesFactures(factures)).toEqual([{ idFacture: '1', motif: 'encaissement 345 sans date_paiement' }]);
  });

  it('session NON à cheval → les 4 dates et les 2 montants null, même avec des factures payées', () => {
    const r = splitFacturesAcheval([
      f('1', 1000, '2026-01-01', '2026-01-02', '2026-01-10', 1000),
      f('2', 500, '2026-02-01', '2026-02-02', '2026-02-10', 500),
    ], false);
    expect(r).toEqual(VIDE_C);
  });

  it('seulement des factures annulées + leurs avoirs → 6 null (aucune vivante)', () => {
    expect(splitFacturesAcheval([
      f('1', 1000, '2026-01-01', null, '2026-01-10', 0),
      f('2', -1000, '2026-01-10', null, '2026-01-10', 0, '1'),
    ], true)).toEqual(VIDE_C);
  });

  it("une facture à 0 € SANS avoir n'est pas « annulée » : elle reste vivante", () => {
    const r = splitFacturesAcheval([f('1', 0, '2026-01-01', null, '2026-01-05', 0), f('2', 800, '2026-02-01', null, null, 0)], true);
    expect(r.facture1DatePaiement).toBe('2026-01-05');
    expect(r.facture1MontantPaye).toBe(0);
  });

  it("annulation par PLUSIEURS avoirs dont la somme == −HT → annulée (sortie des slots)", () => {
    const r = splitFacturesAcheval([
      f('1', 1000, '2026-01-01', null, '2026-01-10', 0),
      f('2', -600, '2026-01-10', null, '2026-01-10', 0, '1'),
      f('3', -400, '2026-01-10', null, '2026-01-10', 0, '1'),
      f('4', 750, '2026-02-01', '2026-02-01', '2026-02-15', 750),
    ], true);
    expect(r.facture1MontantPaye).toBe(750);
    expect(r.facture2DateEnvoi).toBeNull();
  });
});

describe('detectIncoherencesFactures — log seul, aucune correction', () => {
  const f = (
    idFacture: string, montantHt: number, datePaiement: string | null,
    montantTotalPaiements: number | null, idParent: string | null = null, idOpca = ANDPC_ID,
  ) => fac(idOpca, montantHt, null, datePaiement, '2026-01-01', idFacture, idParent, montantTotalPaiements);

  it('paires « facture entièrement annulée + avoir » (compensation) → NORMALES, rien signalé', () => {
    expect(detectIncoherencesFactures([
      f('4503', 4123, '2026-06-18', 0),
      f('4541', -4123, '2026-06-18', 0, '4503'),
      f('4542', 3885.5, '2026-06-29', 3885.5),
    ])).toEqual([]);
  });

  it('facture vivante DATÉE sans encaissement (paiements 0, HT ≠ 0) → signalée', () => {
    expect(detectIncoherencesFactures([f('9', 500, '2026-03-01', 0)])).toEqual([
      { idFacture: '9', motif: 'datée 2026-03-01 sans encaissement (montant_total_paiements 0, HT 500)' },
    ]);
  });

  it('facture à 0 € datée sans encaissement → NON signalée (0 payé sur 0 dû)', () => {
    expect(detectIncoherencesFactures([f('4597', 0, '2026-07-03', 0)])).toEqual([]);
  });

  it('cas réel 3864 : avoir 4430 sans date_paiement ET encaissé → 2 signalements', () => {
    expect(detectIncoherencesFactures([
      f('4429', 345, '2026-05-29', 345),
      f('4430', -345, null, 345, '4429'),
    ])).toEqual([
      { idFacture: '4430', motif: 'avoir sans date_paiement (parente 4429)' },
      { idFacture: '4430', motif: 'encaissement 345 sans date_paiement' },
    ]);
  });

  it('avoir orphelin : id_parent vide → signalé', () => {
    expect(detectIncoherencesFactures([f('1', 500, '2026-03-01', 500), f('2', -500, '2026-03-05', 0, null)])).toEqual([
      { idFacture: '2', motif: 'avoir orphelin : id_parent vide' },
    ]);
  });

  it('avoir orphelin : parente introuvable parmi les ANDPC (absente, ou facture NON-ANDPC) → signalé', () => {
    expect(detectIncoherencesFactures([
      f('1', 500, '2026-03-01', 500),
      f('2', -500, '2026-03-05', 0, 'ZZZ'),          // parente absente de la session
      f('3', 999, '2026-03-01', 999, null, '2669'),  // facture d'un autre financeur
      f('4', -999, '2026-03-05', 0, '3'),            // avoir ANDPC qui la cite → orphelin côté ANDPC
    ])).toEqual([
      { idFacture: '2', motif: 'avoir orphelin : parente ZZZ introuvable parmi les factures ANDPC' },
      { idFacture: '4', motif: 'avoir orphelin : parente 3 introuvable parmi les factures ANDPC' },
    ]);
  });

  it('avoir orphelin ET sans date_paiement → les 2 signalements', () => {
    expect(detectIncoherencesFactures([f('2', -500, null, 0, null)])).toEqual([
      { idFacture: '2', motif: 'avoir orphelin : id_parent vide' },
      { idFacture: '2', motif: 'avoir sans date_paiement (parente vide)' },
    ]);
  });

  it('montant_total_paiements absent (null) → jamais signalé (on ne sait pas)', () => {
    expect(detectIncoherencesFactures([f('1', 500, '2026-03-01', null), f('2', 500, null, null)])).toEqual([]);
  });

  it('factures NON-ANDPC ignorées', () => {
    expect(detectIncoherencesFactures([f('1', 500, '2026-03-01', 0, null, '2669')])).toEqual([]);
  });
});

describe('buildFinanceurByParticipant (chaîne idParticipant → id_entreprise → financeur)', () => {
  const laps: LapLink[] = [
    { idParticipant: 'p1', idEntreprise: 'e1', commercialId: '', presence: 'OUI', firstLamInscritId: '6020' }, // ANDPC
    { idParticipant: 'p2', idEntreprise: 'e2', commercialId: '', presence: 'OUI', firstLamInscritId: '6020' }, // particulier
    { idParticipant: 'p3', idEntreprise: 'e3', commercialId: '', presence: 'OUI', firstLamInscritId: '6020' }, // aucun financement
  ];
  const lines: FinancementLine[] = [
    fin('e1', ANDPC_ID, 'opca', 500),
    fin('e2', '449369', 'particulier', 300),
  ];

  it('true=ANDPC | false=autre financeur | null=aucun financement', () => {
    const m = buildFinanceurByParticipant(laps, lines);
    expect(m.get('p1')).toBe(true);
    expect(m.get('p2')).toBe(false);
    expect(m.get('p3')).toBeNull();
  });

  it('participant mixte (ANDPC + particulier sur la même entreprise) → true (ANDPC prime)', () => {
    const mixed = [...lines, fin('e1', '449369', 'particulier', 100)];
    const m = buildFinanceurByParticipant(laps, mixed);
    expect(m.get('p1')).toBe(true);
  });
});

// --- RÉSILIENCE I/O : un échec de lecture ne perd JAMAIS la session ----------
describe('enrichFinancement — résilience (échec d\'une lecture)', () => {
  // Réponses par endpoint ; `fail` = ensemble d'endpoints qui renvoient 500.
  const FINANCEMENTS = [
    { id_finance: 'e1', id_financeur: ANDPC_ID, type: 'opca', montant_finance: '500.00' },
    { id_finance: 'e2', id_financeur: '449369', type: 'particulier', montant_finance: '300.00' },
  ];
  const FACTURES = [
    { id_facture: '700', id_opca: ANDPC_ID, date_envoi: '2026-05-11 00:00:00', montant_total_ht: '800.00', date_paiement: '2026-05-20 00:00:00', date_emission: '2026-05-11 00:00:00', montant_total_paiements: '800.00' },
  ];
  const LAPS = [
    // ANDPC + commercial 48 (réel S13.0) + a suivi jusqu'au bout (S14)
    { id_participant: 'p1', id_entreprise: 'e1', commercial_id: '48', presence: 'OUI', first_lam_inscrit_id: '6020' },
    // particulier, PAS de commercial_id, commencé mais pas fini (S14)
    { id_participant: 'p2', id_entreprise: 'e2', presence: 'INC.', first_lam_inscrit_id: '6056' },
  ];
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  function makeClient(fail: Set<string>, factures: unknown[] = FACTURES): DendreoClient {
    const fetchImpl = vi.fn(async (url: string) => {
      const hit = (res: string) => url.includes(res);
      if (hit('financements.php')) return fail.has('financements') ? new Response('err', { status: 500 }) : json(FINANCEMENTS);
      if (hit('factures.php')) return fail.has('factures') ? new Response('err', { status: 500 }) : json(factures);
      if (hit('laps.php')) return fail.has('laps') ? new Response('err', { status: 500 }) : json(LAPS);
      return json([]);
    });
    return new DendreoClient({ baseUrl: 'https://x/api', apiKey: 'SECRET', fetchImpl, sleep: async () => {} });
  }

  it('tout OK, session NON à cheval → valeurs remplies, les 6 champs S15 null', async () => {
    const r = await enrichFinancement('A1', makeClient(new Set()), false);
    expect(r.session).toEqual({
      financeurAndpc: true, montantAndpc: 500, factureDateEnvoi: '2026-05-11', factureMontantHt: 800, factureDatePaiement: '2026-05-20', factureMontantDepose: 800,
      facture1DateEnvoi: null, facture1DatePaiement: null, facture1MontantPaye: null,
      facture2DateEnvoi: null, facture2DatePaiement: null, facture2MontantPaye: null,
    });
    expect(r.incoherencesFactures).toEqual([]);
    expect(r.financeurByParticipant.get('p1')).toBe(true);
    expect(r.financeurByParticipant.get('p2')).toBe(false);
    // S13.1 : commercial_id extrait des MÊMES laps (coût 0). p2 sans commercial_id → absent.
    expect(r.commercialIdByParticipant.get('p1')).toBe('48');
    expect(r.commercialIdByParticipant.has('p2')).toBe(false);
    // S14 : assiduité/inscription extraites des MÊMES laps (coût 0).
    expect(r.parcoursByParticipant.get('p1')).toEqual({ assidu: true, inscrit: true });
    expect(r.parcoursByParticipant.get('p2')).toEqual({ assidu: false, inscrit: true }); // 'INC.' → exclu de l'onglet
  });

  it('échec factures.php → champs facture null, le RESTE intact', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await enrichFinancement('A2', makeClient(new Set(['factures'])), true); // même à cheval
    expect(r.session).toEqual({
      financeurAndpc: true, montantAndpc: 500, factureDateEnvoi: null, factureMontantHt: null, factureDatePaiement: null, factureMontantDepose: null,
      // S15 : lecture factures KO → les 6 champs null, la session n'est JAMAIS perdue.
      facture1DateEnvoi: null, facture1DatePaiement: null, facture1MontantPaye: null,
      facture2DateEnvoi: null, facture2DatePaiement: null, facture2MontantPaye: null,
    });
    expect(r.financeurByParticipant.get('p1')).toBe(true); // classification préservée
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('à cheval : montant_total_paiements lu dans la MÊME réponse factures.php → facture1MontantPaye', async () => {
    const r = await enrichFinancement('A5', makeClient(new Set()), true);
    expect(r.session).toMatchObject({ facture1DatePaiement: '2026-05-20', facture1MontantPaye: 800, facture2MontantPaye: null });
  });

  it('incohérence facture → console.warn avec idAdf + id_facture, valeurs NON corrigées', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await enrichFinancement('3864', makeClient(new Set(), [
      { id_facture: '4429', id_opca: ANDPC_ID, montant_total_ht: '345.00', date_paiement: '2026-05-29 00:00:00', date_emission: '2026-05-01 00:00:00', montant_total_paiements: '345.00' },
      { id_facture: '4430', id_opca: ANDPC_ID, montant_total_ht: '-345.00', date_paiement: '', date_emission: '2026-06-01 00:00:00', montant_total_paiements: '345.00', id_parent: '4429' },
    ]), false);
    expect(r.incoherencesFactures.map((i) => i.idFacture)).toEqual(['4430', '4430']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('idAdf=3864 id_facture=4430'));
    expect(r.session.factureMontantHt).toBe(345); // agrégat INCHANGÉ (aucune correction)
    warn.mockRestore();
  });

  it('échec laps.php → session intacte, map financeur VIDE (pending → null)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await enrichFinancement('A3', makeClient(new Set(['laps'])), false);
    expect(r.session.financeurAndpc).toBe(true);
    expect(r.session.montantAndpc).toBe(500);
    expect(r.session.factureMontantHt).toBe(800);
    expect(r.financeurByParticipant.size).toBe(0); // aucun lien → chaque pending sera null côté mapper
    expect(r.commercialIdByParticipant.size).toBe(0); // laps KO → aucun commercial_id (commercial=null)
    expect(r.parcoursByParticipant.size).toBe(0); // S14 : laps KO → assidu/inscrit null (jamais false)
    warn.mockRestore();
  });

  it('échec financements.php → financeurAndpc false + montant null, factures OK, participants null', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await enrichFinancement('A4', makeClient(new Set(['financements'])), false);
    expect(r.session.financeurAndpc).toBe(false);
    expect(r.session.montantAndpc).toBeNull();
    expect(r.session.factureMontantHt).toBe(800); // factures lues malgré tout
    expect(r.financeurByParticipant.get('p1')).toBeNull(); // laps OK mais aucune ligne de financement
    expect(r.financeurByParticipant.get('p2')).toBeNull();
    warn.mockRestore();
  });
});

// --- S13.1 : commercial par personne ----------------------------------------
describe('buildCommercialIdByParticipant (idParticipant → commercial_id, depuis les laps déjà lus)', () => {
  it('mappe le commercial_id présent, IGNORE l\'inscription sans commercial_id', () => {
    const laps: LapLink[] = [
      { idParticipant: 'p1', idEntreprise: 'e1', commercialId: '48', presence: 'OUI', firstLamInscritId: '6020' },
      { idParticipant: 'p2', idEntreprise: 'e2', commercialId: '', presence: 'OUI', firstLamInscritId: '6020' }, // absent → non mappé
    ];
    const m = buildCommercialIdByParticipant(laps);
    expect(m.get('p1')).toBe('48');
    expect(m.has('p2')).toBe(false); // → commercial null côté mapper
  });
});

// --- S14 : assiduité + désinscription par personne ---------------------------
// Valeurs PROUVÉES sur cas réels (scripts/recon-desinscrit-decode.mjs) :
//   IKOUEBE/3095 désinscrite → presence 'NON' + first_lam_inscrit_id ''
//   JACON+CADIER/3129 pas finis → presence 'INC.' (26,92 % / 31,41 %), first_lam '6056'
describe('buildParcoursByParticipant (S14 : idParticipant → { assidu, inscrit })', () => {
  const lap = (idParticipant: string, presence: string, firstLamInscritId: string): LapLink =>
    ({ idParticipant, idEntreprise: 'e1', commercialId: '', presence, firstLamInscritId });

  it("presence 'OUI' → assidu true (a suivi jusqu'au bout)", () => {
    expect(buildParcoursByParticipant([lap('p1', 'OUI', '6020')]).get('p1')).toEqual({ assidu: true, inscrit: true });
  });

  it("presence 'INC.' → assidu FALSE (commencé, pas fini) — cas JACON/CADIER", () => {
    expect(buildParcoursByParticipant([lap('p1', 'INC.', '6056')]).get('p1')).toEqual({ assidu: false, inscrit: true });
  });

  it("presence 'NON' → assidu FALSE (no-show)", () => {
    expect(buildParcoursByParticipant([lap('p1', 'NON', '6020')]).get('p1')).toEqual({ assidu: false, inscrit: true });
  });

  it('first_lam_inscrit_id VIDE → inscrit false (DÉSINSCRIT) — cas IKOUEBE', () => {
    expect(buildParcoursByParticipant([lap('p1', 'NON', '')]).get('p1')).toEqual({ assidu: false, inscrit: false });
  });

  it('first_lam_inscrit_id rempli → inscrit true', () => {
    expect(buildParcoursByParticipant([lap('p1', 'INC.', '6056')]).get('p1')!.inscrit).toBe(true);
  });

  it('participant ABSENT des laps → aucune entrée (le mapper écrira null/null, jamais false)', () => {
    const m = buildParcoursByParticipant([lap('p1', 'OUI', '6020')]);
    expect(m.has('p9')).toBe(false);
    expect(m.get('p9')).toBeUndefined();
  });

  it('tolère espaces et casse sur presence ; lap sans idParticipant ignoré', () => {
    const m = buildParcoursByParticipant([lap('p1', ' oui ', ' 6020 '), lap('', 'OUI', '6020')]);
    expect(m.get('p1')).toEqual({ assidu: true, inscrit: true });
    expect(m.size).toBe(1);
  });
});

describe('loadCommerciauxReferentiel (S13.1) — administrateurs.php → Map<id, "Prénom NOM">', () => {
  const ADMINS = [
    { id_administrateur: '48', prenom: 'Guercif', nom: 'Kaoufer' }, // réel S13.0 (note de Loane sur la 3117)
    { id_administrateur: '12', prenom: 'Jordan', nom: 'Martel' },
  ];
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
  const clientWith = (impl: (url: string) => Promise<Response>): DendreoClient =>
    new DendreoClient({ baseUrl: 'https://x/api', apiKey: 'SECRET', fetchImpl: impl, sleep: async () => {} });

  it('commercial_id=48 → "Prénom NOM" = "Guercif Kaoufer" ; id inconnu → undefined (→ null côté mapper)', async () => {
    __resetCommerciauxReferentiel();
    const ref = await loadCommerciauxReferentiel(clientWith(async () => json(ADMINS)));
    expect(ref.get('48')).toBe('Guercif Kaoufer');
    expect(ref.get('999')).toBeUndefined(); // id inconnu du référentiel → mapper renverra null
  });

  it('administrateurs.php KO → Map VIDE (résilient, commercial=null), warn émis', async () => {
    __resetCommerciauxReferentiel();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ref = await loadCommerciauxReferentiel(clientWith(async () => new Response('err', { status: 500 })));
    expect(ref.size).toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('cache module : un 2e appel ne relit PAS administrateurs.php', async () => {
    __resetCommerciauxReferentiel();
    const impl = vi.fn(async () => json(ADMINS));
    await loadCommerciauxReferentiel(clientWith(impl));
    await loadCommerciauxReferentiel(clientWith(impl));
    expect(impl).toHaveBeenCalledTimes(1); // 2e appel servi par le cache
  });
});
