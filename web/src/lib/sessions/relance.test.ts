import { describe, it, expect } from 'vitest';
import type { SessionDoc, SignatureDoc } from '@/lib/firestore/sessions';
import { buildRelanceRows, deriveRelance, filterRelance, relanceTotals, sortRelance } from './relance';

function sig(over: Partial<SignatureDoc> & { idParticipant: string; doctypeId: string }): SignatureDoc {
  return {
    idAdf: over.idAdf ?? 'S1',
    idParticipant: over.idParticipant,
    doctypeId: over.doctypeId,
    documentName: over.documentName ?? 'Attestation EPP amont 2026',
    nom: over.nom ?? 'AB',
    status: 'pending',
    signatureDate: null,
    sentDate: over.sentDate ?? '2026-06-01T08:00:00.000000Z',
    viewerUrl: over.viewerUrl ?? 'https://pro.dendreo.com/x/viewer',
    sessionNumeroComplet: over.sessionNumeroComplet ?? 'ADF_20260001',
    sessionIntitule: over.sessionIntitule ?? 'Intitulé (signature)',
    sessionDateDebut: over.sessionDateDebut ?? '2026-01-01T00:00:00',
    lastSyncedAt: '2026-06-15T00:00:00',
  };
}

function session(over: Partial<SessionDoc> & { idAdf: string }): SessionDoc {
  return {
    idAdf: over.idAdf,
    numeroComplet: over.numeroComplet ?? 'ADF_20260001',
    numeroSessionDpc: over.numeroSessionDpc ?? '26.001',
    numeroCompteProduit: null,
    intitule: over.intitule ?? 'Prévention des risques',
    dateDebut: '2026-01-01T00:00:00',
    dateFin: '2026-02-01T00:00:00',
    idEtapeProcess: over.idEtapeProcess ?? '6',
    etape: over.etape ?? 'Réalisation',
    idCentre: '1',
    type: 'inter',
    totalParticipants: 0,
    format: 'Mixte',
    aCheval: false,
    eppAmontConnecte: false,
    eppAvalConnecte: false,
    counts: { envoyes: 0, signes: 0, nonSignes: 0, participantsConcernes: 0, participantsARelancer: 0 },
    oldestPendingSentDate: null,
    lastSyncedAt: '2026-06-01T00:00:00',
    source: 'dendreo',
  };
}

function indexOf(sessions: SessionDoc[]): Map<string, SessionDoc> {
  return new Map(sessions.map((s) => [s.idAdf, s]));
}

const TODAY = '2026-06-11';

describe('robustesse : session jointe avec counts=undefined (doc mirror incomplet)', () => {
  it('deriveRelance ne crashe pas et affiche la ligne (relance ne dépend pas de counts)', () => {
    const pending = [sig({ idParticipant: 'p1', doctypeId: '165', idAdf: 'inc' })];
    const incomplete = { ...session({ idAdf: 'inc', numeroSessionDpc: '26.099' }), counts: undefined as unknown as SessionDoc['counts'] };
    const idx = new Map<string, SessionDoc>([['inc', incomplete]]);
    expect(() => deriveRelance(pending, idx, { search: '', sortDir: 'asc', page: 1, pageSize: 25, todayParis: TODAY })).not.toThrow();
    const d = deriveRelance(pending, idx, { search: '', sortDir: 'asc', page: 1, pageSize: 25, todayParis: TODAY });
    expect(d.pageItems).toHaveLength(1);
    expect(d.pageItems[0]!.numeroSessionDpc).toBe('26.099');
  });
});

describe('buildRelanceRows', () => {
  it('exclut les sessions en "Echec", joint numeroSessionDpc + intitulé', () => {
    const pending = [
      sig({ idParticipant: 'p1', doctypeId: '165', idAdf: 'ok' }),
      sig({ idParticipant: 'p2', doctypeId: '166', idAdf: 'ko' }),
    ];
    const idx = indexOf([
      session({ idAdf: 'ok', numeroSessionDpc: '26.010', intitule: 'Formation A' }),
      session({ idAdf: 'ko', etape: 'Echec', idEtapeProcess: '9' }),
    ]);
    const rows = buildRelanceRows(pending, idx, TODAY);
    expect(rows.map((r) => r.idAdf)).toEqual(['ok']); // 'ko' (Echec) exclue
    expect(rows[0]!.numeroSessionDpc).toBe('26.010');
    expect(rows[0]!.sessionIntitule).toBe('Formation A');
  });

  it('fail-open : session absente de la map → ligne affichée, numeroSessionDpc null', () => {
    const pending = [sig({ idParticipant: 'p1', doctypeId: '165', idAdf: 'orphan', sessionIntitule: 'Depuis signature' })];
    const rows = buildRelanceRows(pending, indexOf([]), TODAY);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.numeroSessionDpc).toBeNull();
    expect(rows[0]!.sessionIntitule).toBe('Depuis signature'); // fallback dénormalisé
  });

  it('ancienneté : jour Paris de sentDate → todayParis', () => {
    // 2026-06-01T22:30Z (été) = 2026-06-02 à Paris ; today 2026-06-11 → 9 j.
    const pending = [sig({ idParticipant: 'p1', doctypeId: '165', sentDate: '2026-06-01T22:30:00.000000Z' })];
    const rows = buildRelanceRows(pending, indexOf([session({ idAdf: 'S1' })]), TODAY);
    expect(rows[0]!.ageDays).toBe(9);
  });
});

describe('sortRelance — ancienneté', () => {
  const rows = buildRelanceRows(
    [
      sig({ idParticipant: 'a', doctypeId: '1', sentDate: '2026-05-10T08:00:00.000000Z' }),
      sig({ idParticipant: 'b', doctypeId: '1', sentDate: '2026-03-01T08:00:00.000000Z' }),
      sig({ idParticipant: 'c', doctypeId: '1', sentDate: '2026-04-15T08:00:00.000000Z' }),
    ],
    indexOf([session({ idAdf: 'S1' })]),
    TODAY,
  );
  it('asc = plus vieux d\'abord', () => {
    expect(sortRelance(rows, 'asc').map((r) => r.idParticipant)).toEqual(['b', 'c', 'a']);
  });
  it('desc = plus récent d\'abord', () => {
    expect(sortRelance(rows, 'desc').map((r) => r.idParticipant)).toEqual(['a', 'c', 'b']);
  });
});

describe('filterRelance', () => {
  const rows = buildRelanceRows(
    [
      sig({ idParticipant: 'a', doctypeId: '1', nom: 'Dupont', documentName: 'Attestation EPP amont' }),
      sig({ idParticipant: 'b', doctypeId: '1', nom: 'Martin', documentName: 'Attestation EPP aval' }),
    ],
    indexOf([session({ idAdf: 'S1', intitule: 'Prévention', numeroSessionDpc: '26.001' })]),
    TODAY,
  );
  it('match nom (accent-insensible)', () => {
    expect(filterRelance(rows, 'dupont').map((r) => r.nom)).toEqual(['Dupont']);
  });
  it('match document', () => {
    expect(filterRelance(rows, 'aval').map((r) => r.nom)).toEqual(['Martin']);
  });
  it('vide → tout', () => {
    expect(filterRelance(rows, '  ')).toHaveLength(2);
  });
});

describe('relanceTotals / deriveRelance', () => {
  it('grand total figé (participants distincts) NON affecté par la recherche', () => {
    const pending = [
      sig({ idParticipant: 'p1', doctypeId: '165', nom: 'Alice', sentDate: '2026-05-01T08:00:00.000000Z' }),
      sig({ idParticipant: 'p1', doctypeId: '166', nom: 'Alice', sentDate: '2026-04-01T08:00:00.000000Z' }), // 2e attestation, même personne
      sig({ idParticipant: 'p2', doctypeId: '165', nom: 'Bob', sentDate: '2026-03-01T08:00:00.000000Z' }),
    ];
    const idx = indexOf([session({ idAdf: 'S1' })]);
    expect(relanceTotals(buildRelanceRows(pending, idx, TODAY))).toEqual({ attestations: 3, participants: 2 });

    const d = deriveRelance(pending, idx, { search: 'alice', sortDir: 'asc', page: 1, pageSize: 25, todayParis: TODAY });
    expect(d.total).toBe(2); // filtré (pagination)
    expect(d.totals).toEqual({ attestations: 3, participants: 2 }); // total FIGÉ (avant recherche)
    expect(d.pageItems.map((r) => r.doctypeId)).toEqual(['166', '165']); // plus vieux d'abord
  });
});
