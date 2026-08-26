import { describe, it, expect } from 'vitest';
import { EMPTY_COUNTS, type SessionDoc } from '@/lib/firestore/sessions';
import type { RelanceRow } from './relance';
import { suiviSignaturesUrl } from '@/lib/dendreo';
import { EMPTY_DISPLAY } from '@/lib/format';
import {
  RELANCE_CSV_HEADERS,
  SESSIONS_CSV_HEADERS,
  SESSIONS_SHEET_HEADERS,
  SESSIONS_SHEET_HEADERS_CHEVAL2026,
  attestationManquante,
  blocDisplay,
  ddmmyy,
  ddmmyyFromInstant,
  eppCoNc,
  relanceCsvFilename,
  relanceNomsCell,
  relanceToCsv,
  relanceToCsvRow,
  sessionsCsvFilename,
  sessionsToCsv,
  sessionToCsvRow,
  sessionToSheetRow,
  sessionToSheetRowCheval2026,
  signaturesSummary,
} from './export';

const counts = (envoyes: number, signes: number) => ({
  envoyes,
  signes,
  nonSignes: envoyes - signes,
  participantsConcernes: envoyes,
  participantsARelancer: envoyes - signes,
  // S18 : neutres ici — ces cas testent signaturesSummary/attestationManquante, qui ne
  // lisent que envoyes/signes/nonSignes. Les blocs ont leur propre describe plus bas.
  amontCoeur: { signes: 0, total: 0 },
  aval: { signes: 0, total: 0 },
});

function session(over: Partial<SessionDoc> = {}): SessionDoc {
  return {
    idAdf: '1', numeroComplet: 'ADF_1', numeroSessionDpc: '26.001', numeroCompteProduit: '92622525478',
    intitule: 'Prévention', dateDebut: '2026-01-09T00:00:00', dateFin: '2026-02-20T23:59:59',
    idEtapeProcess: '6', etape: 'Réalisation', idCentre: '1', type: 'inter', totalParticipants: 4,
    format: 'Mixte', aCheval: false, facturableAnneeN: false, eppAmontConnecte: false, eppAvalConnecte: false, eligibleDpc: true, aEpp: true,
    datesSynchrones: [],
    financeurAndpc: false, montantAndpc: null, factureDateEnvoi: null, factureMontantHt: null, factureDatePaiement: null,
    facture1DateEnvoi: null, facture1DatePaiement: null, facture2DateEnvoi: null, facture2DatePaiement: null,
    counts: {
      envoyes: 3, signes: 1, nonSignes: 2, participantsConcernes: 3, participantsARelancer: 2,
      amontCoeur: { signes: 0, total: 0 }, aval: { signes: 0, total: 0 },
    },
    oldestPendingSentDate: null, lastSyncedAt: '', source: 'dendreo',
    ...over,
  };
}
function relance(over: Partial<RelanceRow> = {}): RelanceRow {
  return {
    id: 'p1_165', idAdf: '1', idParticipant: 'p1', doctypeId: '165', nom: 'Jean Dupont',
    documentName: 'Attestation EPP amont 2026', numeroSessionDpc: '26.001', sessionIntitule: 'Prévention',
    sessionNumeroComplet: 'ADF_1', sessionDateDebut: '2026-01-01T00:00:00', sessionDateFin: '2026-02-20T00:00:00',
    sentDate: '2026-06-01T08:00:00.000000Z', sentDay: '2026-06-01', ageDays: 40,
    viewerUrl: 'https://public.dendreo.com/t/media/m', ...over,
  };
}

describe('helpers de mapping', () => {
  it('ddmmyy : ISO naïf → JJ/MM/AA ; vide → ""', () => {
    expect(ddmmyy('2026-01-09T00:00:00')).toBe('09/01/26');
    expect(ddmmyy('')).toBe('');
    expect(ddmmyy(null)).toBe('');
  });
  it('ddmmyyFromInstant : instant Z → jour Paris JJ/MM/AA', () => {
    expect(ddmmyyFromInstant('2026-06-01T08:00:00.000000Z')).toBe('01/06/26');
    expect(ddmmyyFromInstant(null)).toBe('');
  });
  it('eppCoNc : EMPTY_DISPLAY si pas d\'EPP, sinon {amont}/{aval}', () => {
    expect(eppCoNc({ aEpp: false, eppAmontConnecte: false, eppAvalConnecte: false })).toBe(EMPTY_DISPLAY);
    expect(eppCoNc({ aEpp: false, eppAmontConnecte: true, eppAvalConnecte: true })).toBe(EMPTY_DISPLAY); // aEpp prime
    expect(eppCoNc({ aEpp: true, eppAmontConnecte: true, eppAvalConnecte: true })).toBe('CO/CO');
    expect(eppCoNc({ aEpp: true, eppAmontConnecte: false, eppAvalConnecte: true })).toBe('NC/CO');
    expect(eppCoNc({ aEpp: true, eppAmontConnecte: true, eppAvalConnecte: false })).toBe('CO/NC');
    expect(eppCoNc({ aEpp: true, eppAmontConnecte: false, eppAvalConnecte: false })).toBe('NC/NC');
  });
  it('signaturesSummary : 0 envoyé / tous signés / à relancer', () => {
    expect(signaturesSummary({ ...EMPTY_COUNTS, envoyes: 0, signes: 0, nonSignes: 0, participantsConcernes: 0, participantsARelancer: 0 })).toBe(EMPTY_DISPLAY);
    expect(signaturesSummary({ ...EMPTY_COUNTS, envoyes: 3, signes: 3, nonSignes: 0, participantsConcernes: 3, participantsARelancer: 0 })).toBe('Tous ont signé');
    expect(signaturesSummary({ ...EMPTY_COUNTS, envoyes: 3, signes: 1, nonSignes: 2, participantsConcernes: 3, participantsARelancer: 2 })).toBe('2 à relancer');
  });
  it('attestationManquante : 0 envoyé → EMPTY_DISPLAY / tout signé → "Signature complète" / 2 sur 30 → "2/30"', () => {
    expect(attestationManquante(counts(0, 0))).toBe(EMPTY_DISPLAY);
    expect(attestationManquante(counts(30, 30))).toBe('Signature complète');
    expect(attestationManquante(counts(30, 28))).toBe('2/30');
  });
});

describe('COCKPIT — colonnes & mapping', () => {
  it('entêtes = ordre EXACT du Sheet Ops (18 colonnes)', () => {
    expect(SESSIONS_CSV_HEADERS).toEqual([
      'DPC', 'Intitulé', 'N° CP', 'Session', 'Organisation', 'Début', 'Fin', 'EPP CO/NC', 'Cheval?',
      'Date de dépôt', 'Montant €', 'Date de paiement', 'Signatures', 'Commentaire', 'Relance',
      'Attestation manquante', 'Dendreo', 'Dossier', 'Lien stockage',
    ]);
  });

  it('sessionToCsvRow : DPC TRUE/FALSE, dates JJ/MM/AA, EPP, cheval, signatures, colonnes Ops vides, lien stockage', () => {
    const row = sessionToCsvRow(session({ idAdf: '2656', aCheval: true, eppAmontConnecte: true }));
    expect(row).toHaveLength(SESSIONS_CSV_HEADERS.length); // 19
    expect(row[0]).toBe('TRUE'); // DPC = eligibleDpc (true par défaut de la factory)
    expect(row[1]).toBe('Prévention'); // Intitulé
    expect(row[2]).toBe('92622525478'); // N° CP
    expect(row[3]).toBe('26.001'); // Session
    expect(row[4]).toBe('Mixte'); // Organisation
    expect(row[5]).toBe('09/01/26'); // Début
    expect(row[6]).toBe('20/02/26'); // Fin
    expect(row[7]).toBe('CO/NC'); // EPP CO/NC
    expect(row[8]).toBe('✅'); // Cheval?
    expect(row[12]).toBe('2 à relancer'); // Signatures
    expect(row[15]).toBe('2/3'); // Attestation manquante (nonSignes/envoyes)
    // S11.2 : colonnes facture (9,10,11) désormais AUTO → EMPTY_DISPLAY ici (facture null par défaut).
    expect([row[9], row[10], row[11]]).toEqual([EMPTY_DISPLAY, EMPTY_DISPLAY, EMPTY_DISPLAY]);
    // colonnes Ops encore vraiment vides : Commentaire, Relance, Dendreo, Dossier.
    expect([row[13], row[14], row[16], row[17]]).toEqual(['', '', '', '']);
    // Lien stockage (dernière colonne) = suiviSignaturesUrl, jamais reconstruit à la main
    expect(row[18]).toBe(suiviSignaturesUrl('2656'));
    expect(row[18]).toBe('https://pro.dendreo.com/nes_formation/formations/2656/suivi-signatures');
  });

  it('Lien stockage vide si idAdf absent', () => {
    expect(sessionToCsvRow(session({ idAdf: '' }))[18]).toBe('');
  });

  it('Lien stockage : URL non "quotée" (pas de ; " ou saut de ligne) dans le CSV', () => {
    const csv = sessionsToCsv([session({ idAdf: '2656' })]);
    // l'URL apparaît telle quelle, sans guillemets parasites
    expect(csv).toContain(';https://pro.dendreo.com/nes_formation/formations/2656/suivi-signatures');
    expect(csv).not.toContain('"https://');
  });

  it('valeurs nulles → cellules vides (pas de crash)', () => {
    const row = sessionToCsvRow(session({ numeroCompteProduit: null, numeroSessionDpc: null, format: '' }));
    expect(row[2]).toBe('');
    expect(row[3]).toBe('');
    expect(row[4]).toBe('');
  });

  it('S11.2 : colonnes facture AUTO remplies (Date de dépôt / Montant € / Date de paiement)', () => {
    const row = sessionToCsvRow(session({
      factureDateEnvoi: '2026-07-03', factureMontantHt: 1111.5, factureDatePaiement: '2026-07-20',
    }));
    expect(row[9]).toBe('03/07/26'); // Date de dépôt ← factureDateEnvoi
    expect(row[10]).toBe('1111,50'); // Montant € ← factureMontantHt (virgule FR, 2 décimales)
    expect(row[11]).toBe('20/07/26'); // Date de paiement ← factureDatePaiement
  });

  it('S11.2 : montant entier → 2 décimales virgule ; facture null → EMPTY_DISPLAY', () => {
    expect(sessionToCsvRow(session({ factureMontantHt: 16929 }))[10]).toBe('16929,00');
    const nul = sessionToCsvRow(session({ factureMontantHt: null, factureDateEnvoi: null, factureDatePaiement: null }));
    expect([nul[9], nul[10], nul[11]]).toEqual([EMPTY_DISPLAY, EMPTY_DISPLAY, EMPTY_DISPLAY]);
  });

  it('DPC=FALSE si non éligible ; EPP=EMPTY_DISPLAY si pas d\'EPP', () => {
    const row = sessionToCsvRow(session({ eligibleDpc: false, aEpp: false, eppAmontConnecte: true }));
    expect(row[0]).toBe('FALSE'); // DPC
    expect(row[7]).toBe(EMPTY_DISPLAY); // EPP CO/NC — pas d'EPP
  });

  it('sessionsToCsv : exporte EXACTEMENT les lignes fournies (entête + N lignes)', () => {
    const csv = sessionsToCsv([session({ idAdf: 'a' }), session({ idAdf: 'b' })]);
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(3); // 1 entête + 2 lignes filtrées
    expect(lines[0]!.startsWith('DPC;Intitulé;')).toBe(true);
  });
});

describe('COCKPIT — variante "sheet" (idAdf + réutilisation du CSV)', () => {
  const CSV_LEN = SESSIONS_CSV_HEADERS.length; // 19
  /** Lit une cellule PAR SON EN-TÊTE : ajouter une colonne en fin ne casse plus les tests. */
  const col = (row: readonly string[], header: string): string | undefined =>
    row[SESSIONS_SHEET_HEADERS.indexOf(header as (typeof SESSIONS_SHEET_HEADERS)[number])];

  it('entêtes sheet = idAdf + CSV + "À relancer (noms)" + S11.2 + "Dates synchrones" + facture 1/2 EN FIN', () => {
    expect(SESSIONS_SHEET_HEADERS).toEqual([
      'idAdf', ...SESSIONS_CSV_HEADERS, 'À relancer (noms)', 'Montant session', 'Hors DPC (nb)', 'Dates synchrones',
      'Facture 1 - envoi', 'Facture 1 - paiement', 'Facture 2 - envoi', 'Facture 2 - paiement',
    ]);
    expect(SESSIONS_SHEET_HEADERS[0]).toBe('idAdf');
    // S15 : les 4 nouvelles sont EN FIN → aucun index de colonne existante ne bouge.
    expect(SESSIONS_SHEET_HEADERS.slice(-4)).toEqual([
      'Facture 1 - envoi', 'Facture 1 - paiement', 'Facture 2 - envoi', 'Facture 2 - paiement',
    ]);
    expect(SESSIONS_SHEET_HEADERS.at(-5)).toBe('Dates synchrones'); // inchangée de position relative
  });

  it('AUCUN en-tête dupliqué dans la variante sheet (protège l\'Apps Script)', () => {
    expect(new Set(SESSIONS_SHEET_HEADERS).size).toBe(SESSIONS_SHEET_HEADERS.length);
  });

  it("le CSV cockpit N'A PAS les colonnes propres au format sheet (noms, Dates synchrones)", () => {
    expect(SESSIONS_CSV_HEADERS).not.toContain('À relancer (noms)');
    expect(SESSIONS_CSV_HEADERS).not.toContain('Dates synchrones'); // S12.2 : cockpit CSV inchangé
    expect(sessionToCsvRow(session({}))).toHaveLength(SESSIONS_CSV_HEADERS.length);
  });

  it('sessionToSheetRow : idAdf en 1re col., partie CSV == sessionToCsvRow (zéro logique dupliquée)', () => {
    const s = session({ idAdf: '2656', aCheval: true, eppAmontConnecte: true });
    const row = sessionToSheetRow(s, ['Hugo CASTAN']);
    expect(row[0]).toBe('2656'); // clé de correspondance
    expect(row).toHaveLength(SESSIONS_SHEET_HEADERS.length); // = 1 + 19 + 1 + 3 + 4 (S15)
    // Réutilisation : la tranche CSV (après idAdf) == la ligne CSV telle quelle.
    expect(row.slice(1, 1 + CSV_LEN)).toEqual(sessionToCsvRow(s));
    expect(col(row, 'À relancer (noms)')).toBe('Hugo CASTAN');
  });

  it('sessionToSheetRow : colonnes S11.2 en fin — Montant session (virgule FR) + Hors DPC (nb)', () => {
    const s = session({ idAdf: '2656', montantAndpc: 5168 });
    const row = sessionToSheetRow(s, ['Hugo CASTAN'], 3);
    expect(col(row, 'Montant session')).toBe('5168,00'); // ← montantAndpc
    expect(col(row, 'Hors DPC (nb)')).toBe('3');
  });

  it('sessionToSheetRow : montantAndpc null → EMPTY_DISPLAY ; horsDpc 0 → EMPTY_DISPLAY', () => {
    const row = sessionToSheetRow(session({ idAdf: '1', montantAndpc: null }), ['X'], 0);
    expect(col(row, 'Montant session')).toBe(EMPTY_DISPLAY);
    expect(col(row, 'Hors DPC (nb)')).toBe(EMPTY_DISPLAY); // 0
  });

  it('sessionToSheetRow : "Dates synchrones" (JJ/MM/AA, ", ", [] → "-")', () => {
    // mixte, 1 date → "15/06/26"
    expect(col(sessionToSheetRow(session({ idAdf: '1', format: 'Mixte', datesSynchrones: ['2026-06-15'] })), 'Dates synchrones')).toBe('15/06/26');
    // CV, 2 dates → jointes ", " dans l'ordre source (déjà trié à la source)
    expect(col(sessionToSheetRow(session({ idAdf: '2', format: 'Classe virtuelle', datesSynchrones: ['2026-06-05', '2026-09-05'] })), 'Dates synchrones')).toBe('05/06/26, 05/09/26');
    // [] (session hors CV/Mixte, filtré à la source) → EMPTY_DISPLAY
    expect(col(sessionToSheetRow(session({ idAdf: '3', format: 'Présentiel', datesSynchrones: [] })), 'Dates synchrones')).toBe(EMPTY_DISPLAY);
  });

  // --- S15 : 4 colonnes facture 1/2 (sessions à cheval) ----------------------
  it('sessionToSheetRow : cas réel 3246 — F1 envoi+paiement, F2 envoi seul (impayée)', () => {
    const row = sessionToSheetRow(session({
      idAdf: '3246', aCheval: true,
      facture1DateEnvoi: '2026-07-03', facture1DatePaiement: '2026-07-20',
      facture2DateEnvoi: '2026-07-13', facture2DatePaiement: null,
    }));
    expect(row.slice(-4)).toEqual(['03/07/26', '20/07/26', '13/07/26', EMPTY_DISPLAY]);
  });

  it('sessionToSheetRow : cas réel 3328 — F1 payée SANS date d\'envoi, F2 envoyée non payée', () => {
    const row = sessionToSheetRow(session({
      idAdf: '3328', aCheval: true,
      facture1DateEnvoi: null, facture1DatePaiement: '2025-12-22',
      facture2DateEnvoi: '2026-07-29', facture2DatePaiement: null,
    }));
    expect(col(row, 'Facture 1 - envoi')).toBe(EMPTY_DISPLAY); // date_envoi vide côté Dendreo
    expect(col(row, 'Facture 1 - paiement')).toBe('22/12/25');
    expect(col(row, 'Facture 2 - envoi')).toBe('29/07/26');
    expect(col(row, 'Facture 2 - paiement')).toBe(EMPTY_DISPLAY);
  });

  it('sessionToSheetRow : session NON à cheval → les 4 colonnes S15 à "-"', () => {
    const row = sessionToSheetRow(session({ idAdf: '1', aCheval: false }));
    expect(row.slice(-4)).toEqual([EMPTY_DISPLAY, EMPTY_DISPLAY, EMPTY_DISPLAY, EMPTY_DISPLAY]);
  });

  it('sessionToSheetRow : idAdf vide reste en 1re colonne (pas de crash, cohérent CSV)', () => {
    const s = session({ idAdf: '' });
    const row = sessionToSheetRow(s);
    expect(row[0]).toBe('');
    expect(row.slice(1, 1 + CSV_LEN)).toEqual(sessionToCsvRow(s));
  });

  it('sessionToSheetRow sans noms → EMPTY_DISPLAY dans la colonne noms (jamais "")', () => {
    expect(sessionToSheetRow(session({ idAdf: '1' })).at(-4)).toBe(EMPTY_DISPLAY);
    expect(sessionToSheetRow(session({ idAdf: '1' }), []).at(-4)).toBe(EMPTY_DISPLAY);
  });
});

describe('COCKPIT sheet — cellule "À relancer (noms)" (relanceNomsCell)', () => {
  it('aucun nom → EMPTY_DISPLAY ("-"), jamais chaîne vide', () => {
    expect(relanceNomsCell([])).toBe(EMPTY_DISPLAY);
    expect(relanceNomsCell([])).not.toBe('');
  });

  it('tri alphabétique + jointure par ", " (format "Prénom NOM" tel que stocké)', () => {
    expect(relanceNomsCell(['Sami TIGRE', 'Hugo CASTAN', 'Mireille Pierrette REA'])).toBe(
      'Hugo CASTAN, Mireille Pierrette REA, Sami TIGRE',
    );
  });

  it('tri accents-insensible (locale fr) : "Émile" se range à "E", pas après "Z"', () => {
    expect(relanceNomsCell(['Zoé MARTIN', 'Émile DURAND', 'Alain BERNARD'])).toBe(
      'Alain BERNARD, Émile DURAND, Zoé MARTIN',
    );
  });

  it('ne mute pas le tableau reçu (copie avant tri)', () => {
    const noms = ['Sami TIGRE', 'Hugo CASTAN'];
    relanceNomsCell(noms);
    expect(noms).toEqual(['Sami TIGRE', 'Hugo CASTAN']); // ordre d'origine préservé
  });

  it('un seul nom → le nom seul, sans séparateur', () => {
    expect(relanceNomsCell(['Hugo CASTAN'])).toBe('Hugo CASTAN');
  });
});

describe('À RELANCER — colonnes & mapping', () => {
  it('entêtes attendus', () => {
    expect(RELANCE_CSV_HEADERS).toEqual([
      'Participant', 'N° session DPC', 'Intitulé', 'Document', 'Envoyée le', 'Ancienneté (jours)', 'Lien Dendreo',
    ]);
  });
  it('relanceToCsvRow : mapping + ageDays null → "" + lien viewerUrl', () => {
    expect(relanceToCsvRow(relance())).toEqual([
      'Jean Dupont', '26.001', 'Prévention', 'Attestation EPP amont 2026', '01/06/26', '40', 'https://public.dendreo.com/t/media/m',
    ]);
    expect(relanceToCsvRow(relance({ ageDays: null, numeroSessionDpc: null, viewerUrl: null }))[5]).toBe('');
    expect(relanceToCsvRow(relance({ ageDays: null, numeroSessionDpc: null, viewerUrl: null }))[1]).toBe('');
    expect(relanceToCsvRow(relance({ ageDays: null, numeroSessionDpc: null, viewerUrl: null }))[6]).toBe('');
  });
  it('relanceToCsv : entête + lignes', () => {
    expect(relanceToCsv([relance()]).split('\r\n')).toHaveLength(2);
  });
});

// --- S18 : onglet "Sessions à cheval 2026 - Auto" ----------------------------
describe('ONGLET à cheval 2026 — 3 colonnes de bloc (S18)', () => {
  const withBlocs = (amontCoeur: { signes: number; total: number }, aval: { signes: number; total: number }, facturable = false) =>
    session({
      facturableAnneeN: facturable,
      counts: { envoyes: 13, signes: 5, nonSignes: 8, participantsConcernes: 13, participantsARelancer: 8, amontCoeur, aval },
    });

  it('en-têtes = les 28 EXISTANTES + 3 en FIN (aucun index existant ne bouge)', () => {
    expect(SESSIONS_SHEET_HEADERS_CHEVAL2026).toHaveLength(SESSIONS_SHEET_HEADERS.length + 3);
    // le préfixe est STRICTEMENT SESSIONS_SHEET_HEADERS, dans le même ordre
    expect(SESSIONS_SHEET_HEADERS_CHEVAL2026.slice(0, SESSIONS_SHEET_HEADERS.length)).toEqual([...SESSIONS_SHEET_HEADERS]);
    expect(SESSIONS_SHEET_HEADERS_CHEVAL2026.slice(-3)).toEqual(['Amont+cœur signés', 'Aval signés', 'Facturable année N']);
  });

  it('AUCUN en-tête dupliqué (protège l\'Apps Script)', () => {
    expect(new Set(SESSIONS_SHEET_HEADERS_CHEVAL2026).size).toBe(SESSIONS_SHEET_HEADERS_CHEVAL2026.length);
  });

  it('blocDisplay : "signés/total" ; total 0 → "-" (jamais "0/0")', () => {
    expect(blocDisplay({ signes: 3, total: 5 })).toBe('3/5');
    expect(blocDisplay({ signes: 0, total: 8 })).toBe('0/8'); // 0 signé sur 8 : information RÉELLE
    expect(blocDisplay({ signes: 0, total: 0 })).toBe(EMPTY_DISPLAY); // bloc absent → on ne sait pas
    expect(blocDisplay(undefined)).toBe(EMPTY_DISPLAY); // doc pré-S18 non normalisé
  });

  it('sessionToSheetRowCheval2026 : préfixe == sessionToSheetRow (zéro logique dupliquée)', () => {
    const s = withBlocs({ signes: 3, total: 5 }, { signes: 0, total: 8 });
    const base = sessionToSheetRow(s, ['Jean Dupont'], 2);
    const row = sessionToSheetRowCheval2026(s, ['Jean Dupont'], 2);
    expect(row.slice(0, base.length)).toEqual(base);
    expect(row).toHaveLength(SESSIONS_SHEET_HEADERS_CHEVAL2026.length);
  });

  it('les 3 cellules : amont 3/5, aval 0/8, facturable ❌ puis ✅', () => {
    const col = (row: readonly string[], header: string): string | undefined =>
      row[SESSIONS_SHEET_HEADERS_CHEVAL2026.indexOf(header as (typeof SESSIONS_SHEET_HEADERS_CHEVAL2026)[number])];

    const nonFacturable = sessionToSheetRowCheval2026(withBlocs({ signes: 3, total: 5 }, { signes: 0, total: 8 }, false));
    expect(col(nonFacturable, 'Amont+cœur signés')).toBe('3/5');
    expect(col(nonFacturable, 'Aval signés')).toBe('0/8');
    expect(col(nonFacturable, 'Facturable année N')).toBe('❌');

    const facturable = sessionToSheetRowCheval2026(withBlocs({ signes: 5, total: 5 }, { signes: 0, total: 0 }, true));
    expect(col(facturable, 'Amont+cœur signés')).toBe('5/5');
    expect(col(facturable, 'Aval signés')).toBe(EMPTY_DISPLAY); // aucun module aval → "-"
    expect(col(facturable, 'Facturable année N')).toBe('✅');
  });

  it('les DEUX "X/Y" de l\'onglet ont des sens INVERSES — vérifié sur la même ligne', () => {
    // counts : 13 envoyées, 5 signées → 8 manquantes ; bloc amont+cœur : 3 signées sur 5.
    const row = sessionToSheetRowCheval2026(withBlocs({ signes: 3, total: 5 }, { signes: 2, total: 8 }));
    const at = (header: string) =>
      row[SESSIONS_SHEET_HEADERS_CHEVAL2026.indexOf(header as (typeof SESSIONS_SHEET_HEADERS_CHEVAL2026)[number])];
    expect(at('Attestation manquante')).toBe('8/13'); // manquantes / envoyées
    expect(at('Amont+cœur signés')).toBe('3/5'); // signées / total
  });

  it('session SANS counts (doc partiel) → les 3 colonnes restent lisibles', () => {
    const s = { ...session(), counts: undefined } as unknown as SessionDoc;
    const row = sessionToSheetRowCheval2026(s);
    expect(row.slice(-3)).toEqual([EMPTY_DISPLAY, EMPTY_DISPLAY, '❌']);
  });
});

describe('noms de fichiers horodatés', () => {
  it('cockpit & à relancer', () => {
    expect(sessionsCsvFilename('2026-07-07')).toBe('medere-sessions-2026-07-07.csv');
    expect(relanceCsvFilename('2026-07-07')).toBe('medere-a-relancer-2026-07-07.csv');
  });
});
