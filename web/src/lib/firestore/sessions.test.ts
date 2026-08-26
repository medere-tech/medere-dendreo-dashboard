import { describe, it, expect } from 'vitest';
import { EMPTY_COUNTS, signatureViewerHref, toSessionDoc, toSignatureDoc } from './sessions';

describe('toSessionDoc — normalisation défensive à la lecture', () => {
  it('counts absent → EMPTY_COUNTS (0 partout), pas de undefined', () => {
    const s = toSessionDoc({ idAdf: '2691', numeroComplet: 'ADF_1' });
    expect(s.counts).toEqual(EMPTY_COUNTS);
    expect(s.counts.nonSignes).toBe(0);
    // S18 : les sous-objets sont des OBJETS complets, jamais undefined.
    expect(s.counts.amontCoeur).toEqual({ signes: 0, total: 0 });
    expect(s.counts.aval).toEqual({ signes: 0, total: 0 });
  });

  it('counts PARTIEL → champs manquants comblés à 0', () => {
    const s = toSessionDoc({ idAdf: '1', numeroComplet: 'ADF_1', counts: { nonSignes: 5 } });
    expect(s.counts).toEqual({
      envoyes: 0, signes: 0, nonSignes: 5, participantsConcernes: 0, participantsARelancer: 0,
      amontCoeur: { signes: 0, total: 0 }, aval: { signes: 0, total: 0 },
    });
  });

  // --- S18 : les sous-objets par bloc SURVIVENT à la lecture -------------------
  it('counts.amontCoeur / counts.aval sont conservés (plus supprimés à la lecture)', () => {
    const s = toSessionDoc({
      idAdf: '3818', numeroComplet: 'ADF_3818',
      counts: {
        envoyes: 13, signes: 5, nonSignes: 8, participantsConcernes: 13, participantsARelancer: 8,
        amontCoeur: { signes: 3, total: 5 }, aval: { signes: 2, total: 8 },
      },
    });
    expect(s.counts.amontCoeur).toEqual({ signes: 3, total: 5 });
    expect(s.counts.aval).toEqual({ signes: 2, total: 8 });
  });

  it('sous-objet bloc PARTIEL ou non-objet → 0 comblé (jamais NaN, jamais undefined)', () => {
    const s = toSessionDoc({
      idAdf: '1', numeroComplet: 'ADF_1',
      counts: { amontCoeur: { signes: 2 }, aval: 'pas-un-objet' },
    });
    expect(s.counts.amontCoeur).toEqual({ signes: 2, total: 0 });
    expect(s.counts.aval).toEqual({ signes: 0, total: 0 });
  });

  it('facturableAnneeN : absent → false ; true conservé ; valeur non booléenne → false', () => {
    expect(toSessionDoc({ idAdf: '1', numeroComplet: 'ADF_1' }).facturableAnneeN).toBe(false);
    expect(toSessionDoc({ idAdf: '1', numeroComplet: 'ADF_1', facturableAnneeN: true }).facturableAnneeN).toBe(true);
    expect(toSessionDoc({ idAdf: '1', numeroComplet: 'ADF_1', facturableAnneeN: 'oui' }).facturableAnneeN).toBe(false);
  });

  it('numeroSessionDpc / numeroCompteProduit absents → null (jamais undefined)', () => {
    const s = toSessionDoc({ idAdf: '1', numeroComplet: 'ADF_1' });
    expect(s.numeroSessionDpc).toBeNull();
    expect(s.numeroCompteProduit).toBeNull();
    expect(s.oldestPendingSentDate).toBeNull();
  });

  it('champs string absents → chaîne vide (types respectés)', () => {
    const s = toSessionDoc({ idAdf: '1', numeroComplet: 'ADF_1' });
    expect(s.intitule).toBe('');
    expect(s.dateFin).toBe('');
    expect(s.totalParticipants).toBe(0);
  });

  it('datesSynchrones : absent → [] ; array de strings préservé ; non-string filtrés', () => {
    expect(toSessionDoc({ idAdf: '1', numeroComplet: 'ADF_1' }).datesSynchrones).toEqual([]);
    expect(toSessionDoc({ idAdf: '1', numeroComplet: 'ADF_1', datesSynchrones: ['2026-03-12', '2026-03-19'] }).datesSynchrones)
      .toEqual(['2026-03-12', '2026-03-19']);
    expect(toSessionDoc({ idAdf: '1', numeroComplet: 'ADF_1', datesSynchrones: 'oops' }).datesSynchrones).toEqual([]); // non-array → []
    expect(toSessionDoc({ idAdf: '1', numeroComplet: 'ADF_1', datesSynchrones: ['2026-03-12', 5, null] }).datesSynchrones).toEqual(['2026-03-12']);
  });

  it('doc complet → valeurs préservées', () => {
    const raw = {
      idAdf: '9', numeroComplet: 'ADF_9', numeroSessionDpc: '26.001', numeroCompteProduit: '92622626015',
      intitule: 'X', dateDebut: 'a', dateFin: 'b', idEtapeProcess: '6', etape: 'Réalisation',
      idCentre: '1', type: 'inter', totalParticipants: 4,
      counts: { envoyes: 4, signes: 1, nonSignes: 3, participantsConcernes: 4, participantsARelancer: 3 },
      oldestPendingSentDate: 'z', lastSyncedAt: 'l', source: 'dendreo',
    };
    expect(toSessionDoc(raw).counts.nonSignes).toBe(3);
    expect(toSessionDoc(raw).numeroCompteProduit).toBe('92622626015');
  });
});

describe('signatureViewerHref — lien = viewerUrl du doc, jamais reconstruit', () => {
  it('renvoie EXACTEMENT le viewerUrl stocké (aucune base/id ajoutée)', () => {
    const url = 'https://public.dendreo.com/AbC123/media/XyZ789';
    expect(signatureViewerHref({ viewerUrl: url })).toBe(url);
  });
  it('même valeur pour un doc pending ou signed (le statut ne change pas le lien)', () => {
    const url = 'https://public.dendreo.com/t/media/m';
    expect(signatureViewerHref(toSignatureDoc({ status: 'pending', viewerUrl: url }))).toBe(url);
    expect(signatureViewerHref(toSignatureDoc({ status: 'signed', viewerUrl: url }))).toBe(url);
  });
  it('absent / vide / null → null (pas de lien mort)', () => {
    expect(signatureViewerHref({ viewerUrl: null })).toBeNull();
    expect(signatureViewerHref({ viewerUrl: '' })).toBeNull();
    expect(signatureViewerHref({ viewerUrl: '   ' })).toBeNull();
  });
});

describe('toSignatureDoc — normalisation défensive', () => {
  it('status inconnu/absent → pending ; champs null-safe', () => {
    const d = toSignatureDoc({ idAdf: '1', idParticipant: 'p', doctypeId: '111' });
    expect(d.status).toBe('pending');
    expect(d.sentDate).toBeNull();
    expect(d.viewerUrl).toBeNull();
    expect(d.nom).toBe('');
  });

  it('status signed préservé', () => {
    expect(toSignatureDoc({ status: 'signed' }).status).toBe('signed');
  });
});
