import { describe, it, expect } from 'vitest';
import type { SessionDoc } from '@/lib/firestore/sessions';
import type { RelanceRow } from './relance';
import { suiviSignaturesUrl } from '@/lib/dendreo';
import { EMPTY_DISPLAY } from '@/lib/format';
import {
  RELANCE_CSV_HEADERS,
  SESSIONS_CSV_HEADERS,
  SESSIONS_SHEET_HEADERS,
  attestationManquante,
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
  signaturesSummary,
} from './export';

const counts = (envoyes: number, signes: number) => ({
  envoyes,
  signes,
  nonSignes: envoyes - signes,
  participantsConcernes: envoyes,
  participantsARelancer: envoyes - signes,
});

function session(over: Partial<SessionDoc> = {}): SessionDoc {
  return {
    idAdf: '1', numeroComplet: 'ADF_1', numeroSessionDpc: '26.001', numeroCompteProduit: '92622525478',
    intitule: 'Prévention', dateDebut: '2026-01-09T00:00:00', dateFin: '2026-02-20T23:59:59',
    idEtapeProcess: '6', etape: 'Réalisation', idCentre: '1', type: 'inter', totalParticipants: 4,
    format: 'Mixte', aCheval: false, eppAmontConnecte: false, eppAvalConnecte: false, eligibleDpc: true, aEpp: true,
    financeurAndpc: false, montantAndpc: null, factureDateEnvoi: null, factureMontantHt: null, factureDatePaiement: null,
    counts: { envoyes: 3, signes: 1, nonSignes: 2, participantsConcernes: 3, participantsARelancer: 2 },
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
    expect(signaturesSummary({ envoyes: 0, signes: 0, nonSignes: 0, participantsConcernes: 0, participantsARelancer: 0 })).toBe(EMPTY_DISPLAY);
    expect(signaturesSummary({ envoyes: 3, signes: 3, nonSignes: 0, participantsConcernes: 3, participantsARelancer: 0 })).toBe('Tous ont signé');
    expect(signaturesSummary({ envoyes: 3, signes: 1, nonSignes: 2, participantsConcernes: 3, participantsARelancer: 2 })).toBe('2 à relancer');
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

  it('entêtes sheet = idAdf + CSV + "À relancer (noms)" + les 2 colonnes S11.2 EN FIN', () => {
    expect(SESSIONS_SHEET_HEADERS).toEqual([
      'idAdf', ...SESSIONS_CSV_HEADERS, 'À relancer (noms)', 'Montant session', 'Hors DPC (nb)',
    ]);
    expect(SESSIONS_SHEET_HEADERS[0]).toBe('idAdf');
    expect(SESSIONS_SHEET_HEADERS.at(-2)).toBe('Montant session');
    expect(SESSIONS_SHEET_HEADERS.at(-1)).toBe('Hors DPC (nb)');
  });

  it('AUCUN en-tête dupliqué dans la variante sheet (protège l\'Apps Script)', () => {
    expect(new Set(SESSIONS_SHEET_HEADERS).size).toBe(SESSIONS_SHEET_HEADERS.length);
  });

  it("le CSV cockpit N'A PAS la colonne noms (propre au format sheet)", () => {
    expect(SESSIONS_CSV_HEADERS).not.toContain('À relancer (noms)');
    expect(sessionToCsvRow(session({}))).toHaveLength(SESSIONS_CSV_HEADERS.length);
  });

  it('sessionToSheetRow : idAdf en 1re col., partie CSV == sessionToCsvRow (zéro logique dupliquée)', () => {
    const s = session({ idAdf: '2656', aCheval: true, eppAmontConnecte: true });
    const row = sessionToSheetRow(s, ['Hugo CASTAN']);
    expect(row[0]).toBe('2656'); // clé de correspondance
    expect(row).toHaveLength(SESSIONS_SHEET_HEADERS.length); // = 1 + 19 + 1 + 2
    // Réutilisation : la tranche CSV (après idAdf) == la ligne CSV telle quelle.
    expect(row.slice(1, 1 + CSV_LEN)).toEqual(sessionToCsvRow(s));
    expect(row.at(-3)).toBe('Hugo CASTAN'); // À relancer (noms)
  });

  it('sessionToSheetRow : colonnes S11.2 en fin — Montant session (virgule FR) + Hors DPC (nb)', () => {
    const s = session({ idAdf: '2656', montantAndpc: 5168 });
    const row = sessionToSheetRow(s, ['Hugo CASTAN'], 3);
    expect(row.at(-2)).toBe('5168,00'); // Montant session ← montantAndpc
    expect(row.at(-1)).toBe('3'); // Hors DPC (nb)
  });

  it('sessionToSheetRow : montantAndpc null → EMPTY_DISPLAY ; horsDpc 0 → EMPTY_DISPLAY', () => {
    const row = sessionToSheetRow(session({ idAdf: '1', montantAndpc: null }), ['X'], 0);
    expect(row.at(-2)).toBe(EMPTY_DISPLAY); // Montant session
    expect(row.at(-1)).toBe(EMPTY_DISPLAY); // Hors DPC (nb) = 0
  });

  it('sessionToSheetRow : idAdf vide reste en 1re colonne (pas de crash, cohérent CSV)', () => {
    const s = session({ idAdf: '' });
    const row = sessionToSheetRow(s);
    expect(row[0]).toBe('');
    expect(row.slice(1, 1 + CSV_LEN)).toEqual(sessionToCsvRow(s));
  });

  it('sessionToSheetRow sans noms → EMPTY_DISPLAY dans la colonne noms (jamais "")', () => {
    expect(sessionToSheetRow(session({ idAdf: '1' })).at(-3)).toBe(EMPTY_DISPLAY);
    expect(sessionToSheetRow(session({ idAdf: '1' }), []).at(-3)).toBe(EMPTY_DISPLAY);
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

describe('noms de fichiers horodatés', () => {
  it('cockpit & à relancer', () => {
    expect(sessionsCsvFilename('2026-07-07')).toBe('medere-sessions-2026-07-07.csv');
    expect(relanceCsvFilename('2026-07-07')).toBe('medere-a-relancer-2026-07-07.csv');
  });
});
