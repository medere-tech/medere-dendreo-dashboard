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

describe('aggregateFacturesAndpc — S13.3 : dépôt (TOUTES) vs paiement (PAYÉES)', () => {
  it('cas réel session 3246 : payée + déposée non payée → dateEnvoi = dépôt le plus ancien, montant/paiement sur la payée', () => {
    // FA-2026-0766 payée (envoi 03/07, HT 1111.50, paie 20/07)
    // + FA-2026-0794 DÉPOSÉE non payée (envoi 13/07, HT 4056.50) → compte pour dateEnvoi seulement.
    const r = aggregateFacturesAndpc([
      fac(ANDPC_ID, 1111.5, '2026-07-03', '2026-07-20'), // FA-2026-0766 (payée)
      fac(ANDPC_ID, 4056.5, '2026-07-13', null),         // FA-2026-0794 (déposée, non payée)
    ]);
    expect(r).toEqual({ montantHt: 1111.5, dateEnvoi: '2026-07-03', datePaiement: '2026-07-20' });
  });

  it('facture NON payée déposée AVANT la payée → dateEnvoi = celle de la NON payée', () => {
    const r = aggregateFacturesAndpc([
      fac(ANDPC_ID, 1111.5, '2026-07-13', '2026-07-20'), // payée, déposée le 13
      fac(ANDPC_ID, 4056.5, '2026-07-03', null),         // NON payée, déposée le 03 → gagne
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

  it('1 facture PAYÉE seule → les 3 champs remplis', () => {
    const r = aggregateFacturesAndpc([fac(ANDPC_ID, 1111.5, '2026-07-03', '2026-07-20')]);
    expect(r).toEqual({ montantHt: 1111.5, dateEnvoi: '2026-07-03', datePaiement: '2026-07-20' });
  });

  it('1 facture DÉPOSÉE non payée seule → dateEnvoi remplie, montantHt et datePaiement null', () => {
    const r = aggregateFacturesAndpc([fac(ANDPC_ID, 4056.5, '2026-07-13', null)]);
    expect(r).toEqual({ montantHt: null, dateEnvoi: '2026-07-13', datePaiement: null });
  });

  it('plusieurs factures déposées, AUCUNE payée → dateEnvoi = la plus ancienne, montant/paiement null', () => {
    const r = aggregateFacturesAndpc([
      fac(ANDPC_ID, 1111.5, '2026-07-03', null),
      fac(ANDPC_ID, 4056.5, '2026-07-13', null),
    ]);
    expect(r).toEqual({ montantHt: null, dateEnvoi: '2026-07-03', datePaiement: null });
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
    expect(r).toEqual({ montantHt: null, dateEnvoi: null, datePaiement: null });
  });

  it('0 facture ANDPC → les 3 champs null (liste vide ou seulement non-360)', () => {
    expect(aggregateFacturesAndpc([])).toEqual({ montantHt: null, dateEnvoi: null, datePaiement: null });
    expect(aggregateFacturesAndpc([fac('449369', 300, '2026-01-01', '2026-01-10')]))
      .toEqual({ montantHt: null, dateEnvoi: null, datePaiement: null });
  });

  it('ne filtre RIEN d\'autre que id_opca=360 (avoirs non traités), y compris pour la date de dépôt', () => {
    const r = aggregateFacturesAndpc([
      fac(ANDPC_ID, 500, '2026-02-01', '2026-02-10'), // 360 payée → comptée
      fac('2669', 999, '2026-01-01', '2026-01-10'),   // autre financeur → exclu (même pour dateEnvoi)
    ]);
    expect(r).toEqual({ montantHt: 500, dateEnvoi: '2026-02-01', datePaiement: '2026-02-10' });
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
    { id_opca: ANDPC_ID, date_envoi: '2026-05-11 00:00:00', montant_total_ht: '800.00', date_paiement: '2026-05-20 00:00:00', date_emission: '2026-05-11 00:00:00' },
  ];
  const LAPS = [
    // ANDPC + commercial 48 (réel S13.0) + a suivi jusqu'au bout (S14)
    { id_participant: 'p1', id_entreprise: 'e1', commercial_id: '48', presence: 'OUI', first_lam_inscrit_id: '6020' },
    // particulier, PAS de commercial_id, commencé mais pas fini (S14)
    { id_participant: 'p2', id_entreprise: 'e2', presence: 'INC.', first_lam_inscrit_id: '6056' },
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
    // S13.1 : commercial_id extrait des MÊMES laps (coût 0). p2 sans commercial_id → absent.
    expect(r.commercialIdByParticipant.get('p1')).toBe('48');
    expect(r.commercialIdByParticipant.has('p2')).toBe(false);
    // S14 : assiduité/inscription extraites des MÊMES laps (coût 0).
    expect(r.parcoursByParticipant.get('p1')).toEqual({ assidu: true, inscrit: true });
    expect(r.parcoursByParticipant.get('p2')).toEqual({ assidu: false, inscrit: true }); // 'INC.' → exclu de l'onglet
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
    expect(r.commercialIdByParticipant.size).toBe(0); // laps KO → aucun commercial_id (commercial=null)
    expect(r.parcoursByParticipant.size).toBe(0); // S14 : laps KO → assidu/inscrit null (jamais false)
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
