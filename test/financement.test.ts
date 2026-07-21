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
  buildFinanceurByParticipant,
  enrichFinancement,
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
): FactureLine => ({ idOpca, montantHt, dateEnvoi, datePaiement, dateEmission });

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

describe('aggregateFacturesAndpc — PAYÉES uniquement (date_paiement non vide)', () => {
  it('cas réel ADF_20250430 : une payée + une non payée → seule la payée compte', () => {
    // FA-2026-0766 payée (HT 1111.50) + FA-2026-0794 NON payée (HT 4056.50, ignorée).
    const r = aggregateFacturesAndpc([
      fac(ANDPC_ID, 1111.5, '2026-07-03', '2026-07-20'), // FA-2026-0766 (payée)
      fac(ANDPC_ID, 4056.5, '2026-07-13', null),         // FA-2026-0794 (non payée → ignorée)
    ]);
    expect(r).toEqual({ montantHt: 1111.5, dateEnvoi: '2026-07-03', datePaiement: '2026-07-20' });
  });

  it('2 factures PAYÉES → somme des deux HT + paiement le plus récent + envoi le plus ancien', () => {
    const r = aggregateFacturesAndpc([
      fac(ANDPC_ID, 4056.5, '2026-06-12', '2026-06-25'),
      fac(ANDPC_ID, 1111.5, '2026-06-01', '2026-06-20'),
    ]);
    expect(r).toEqual({ montantHt: 5168, dateEnvoi: '2026-06-01', datePaiement: '2026-06-25' });
  });

  it('0 facture PAYÉE (des factures existent mais aucune payée) → 3 null', () => {
    const r = aggregateFacturesAndpc([
      fac(ANDPC_ID, 1111.5, '2026-07-03', null),
      fac(ANDPC_ID, 4056.5, '2026-07-13', null),
    ]);
    expect(r).toEqual({ montantHt: null, dateEnvoi: null, datePaiement: null });
  });

  it('date_envoi (parmi les payées) : une envoi vide + une remplie → celle qui existe', () => {
    const r = aggregateFacturesAndpc([
      fac(ANDPC_ID, 100, null, '2026-04-01'),        // payée, sans date_envoi
      fac(ANDPC_ID, 200, '2026-03-03', '2026-04-02'), // payée, avec date_envoi
    ]);
    expect(r.dateEnvoi).toBe('2026-03-03');
  });

  it('0 facture ANDPC → les 3 champs null (liste vide ou seulement non-360)', () => {
    expect(aggregateFacturesAndpc([])).toEqual({ montantHt: null, dateEnvoi: null, datePaiement: null });
    expect(aggregateFacturesAndpc([fac('449369', 300, '2026-01-01', '2026-01-10')]))
      .toEqual({ montantHt: null, dateEnvoi: null, datePaiement: null });
  });

  it('ne filtre RIEN d\'autre que id_opca=360 (avoirs non traités), mais exige le paiement', () => {
    const r = aggregateFacturesAndpc([
      fac(ANDPC_ID, 500, '2026-01-01', '2026-01-10'), // 360 payée → comptée
      fac('2669', 999, '2026-01-01', '2026-01-10'),   // autre financeur → exclu
    ]);
    expect(r.montantHt).toBe(500);
  });
});

describe('buildFinanceurByParticipant (chaîne idParticipant → id_entreprise → financeur)', () => {
  const laps: LapLink[] = [
    { idParticipant: 'p1', idEntreprise: 'e1' }, // ANDPC
    { idParticipant: 'p2', idEntreprise: 'e2' }, // particulier
    { idParticipant: 'p3', idEntreprise: 'e3' }, // aucun financement
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
    { id_opca: ANDPC_ID, date_envoi: '2026-05-11 00:00:00', montant_total_ht: '800.00', date_paiement: '2026-05-20 00:00:00', date_emission: '2026-05-11 00:00:00' },
  ];
  const LAPS = [
    { id_participant: 'p1', id_entreprise: 'e1' }, // ANDPC
    { id_participant: 'p2', id_entreprise: 'e2' }, // particulier
  ];
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  function makeClient(fail: Set<string>): DendreoClient {
    const fetchImpl = vi.fn(async (url: string) => {
      const hit = (res: string) => url.includes(res);
      if (hit('financements.php')) return fail.has('financements') ? new Response('err', { status: 500 }) : json(FINANCEMENTS);
      if (hit('factures.php')) return fail.has('factures') ? new Response('err', { status: 500 }) : json(FACTURES);
      if (hit('laps.php')) return fail.has('laps') ? new Response('err', { status: 500 }) : json(LAPS);
      return json([]);
    });
    return new DendreoClient({ baseUrl: 'https://x/api', apiKey: 'SECRET', fetchImpl, sleep: async () => {} });
  }

  it('tout OK → toutes les valeurs remplies (référence)', async () => {
    const r = await enrichFinancement('A1', makeClient(new Set()));
    expect(r.session).toEqual({
      financeurAndpc: true, montantAndpc: 500, factureDateEnvoi: '2026-05-11', factureMontantHt: 800, factureDatePaiement: '2026-05-20',
    });
    expect(r.financeurByParticipant.get('p1')).toBe(true);
    expect(r.financeurByParticipant.get('p2')).toBe(false);
  });

  it('échec factures.php → champs facture null, le RESTE intact', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await enrichFinancement('A2', makeClient(new Set(['factures'])));
    expect(r.session).toEqual({
      financeurAndpc: true, montantAndpc: 500, factureDateEnvoi: null, factureMontantHt: null, factureDatePaiement: null,
    });
    expect(r.financeurByParticipant.get('p1')).toBe(true); // classification préservée
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('échec laps.php → session intacte, map financeur VIDE (pending → null)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await enrichFinancement('A3', makeClient(new Set(['laps'])));
    expect(r.session.financeurAndpc).toBe(true);
    expect(r.session.montantAndpc).toBe(500);
    expect(r.session.factureMontantHt).toBe(800);
    expect(r.financeurByParticipant.size).toBe(0); // aucun lien → chaque pending sera null côté mapper
    warn.mockRestore();
  });

  it('échec financements.php → financeurAndpc false + montant null, factures OK, participants null', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await enrichFinancement('A4', makeClient(new Set(['financements'])));
    expect(r.session.financeurAndpc).toBe(false);
    expect(r.session.montantAndpc).toBeNull();
    expect(r.session.factureMontantHt).toBe(800); // factures lues malgré tout
    expect(r.financeurByParticipant.get('p1')).toBeNull(); // laps OK mais aucune ligne de financement
    expect(r.financeurByParticipant.get('p2')).toBeNull();
    warn.mockRestore();
  });
});
