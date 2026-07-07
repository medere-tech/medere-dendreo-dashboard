import { describe, it, expect } from 'vitest';
import { EMPTY_COUNTS, toSessionDoc, toSignatureDoc } from './sessions';

describe('toSessionDoc — normalisation défensive à la lecture', () => {
  it('counts absent → EMPTY_COUNTS (0 partout), pas de undefined', () => {
    const s = toSessionDoc({ idAdf: '2691', numeroComplet: 'ADF_1' });
    expect(s.counts).toEqual(EMPTY_COUNTS);
    expect(s.counts.nonSignes).toBe(0);
  });

  it('counts PARTIEL → champs manquants comblés à 0', () => {
    const s = toSessionDoc({ idAdf: '1', numeroComplet: 'ADF_1', counts: { nonSignes: 5 } });
    expect(s.counts).toEqual({ envoyes: 0, signes: 0, nonSignes: 5, participantsConcernes: 0, participantsARelancer: 0 });
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
