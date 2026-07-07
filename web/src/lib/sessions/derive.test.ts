import { describe, it, expect } from 'vitest';
import type { SessionDoc } from '@/lib/firestore/sessions';
import {
  applyFilters,
  deriveSessions,
  distinctEtapes,
  isCockpitVisible,
  isEchecEtape,
  matchesSearch,
  normalizeText,
  paginate,
  sortSessions,
} from './derive';

function make(over: Partial<SessionDoc> & { idAdf: string }): SessionDoc {
  return {
    idAdf: over.idAdf,
    numeroComplet: over.numeroComplet ?? `ADF_2026${over.idAdf.padStart(4, '0')}`,
    numeroSessionDpc: over.numeroSessionDpc ?? '26.001',
    numeroCompteProduit: over.numeroCompteProduit ?? null,
    intitule: over.intitule ?? 'Session test',
    dateDebut: over.dateDebut ?? '2026-01-01T00:00:00',
    dateFin: over.dateFin ?? '2026-02-01T00:00:00',
    idEtapeProcess: over.idEtapeProcess ?? '6',
    etape: over.etape ?? 'Réalisation',
    idCentre: over.idCentre ?? '1',
    type: over.type ?? 'inter',
    totalParticipants: over.totalParticipants ?? 0,
    format: over.format ?? 'Mixte',
    aCheval: over.aCheval ?? false,
    eppAmontConnecte: over.eppAmontConnecte ?? false,
    eppAvalConnecte: over.eppAvalConnecte ?? false,
    counts: over.counts ?? { envoyes: 0, signes: 0, nonSignes: 0, participantsConcernes: 0, participantsARelancer: 0 },
    oldestPendingSentDate: over.oldestPendingSentDate ?? null,
    lastSyncedAt: over.lastSyncedAt ?? '2026-06-01T00:00:00',
    source: over.source ?? 'dendreo',
  };
}

/** Session au `counts` ABSENT (backfill interrompu) — simule un doc mirror incomplet. */
function broken(idAdf: string, over: Partial<SessionDoc> = {}): SessionDoc {
  const s = make({ idAdf, ...over });
  return { ...s, counts: undefined as unknown as SessionDoc['counts'] };
}

describe('robustesse : session avec counts=undefined (doc mirror incomplet)', () => {
  it('sortSessions urgence : aucun throw, la session sans counts est traitée comme 0', () => {
    const withRelances = make({ idAdf: '1', counts: { envoyes: 3, signes: 0, nonSignes: 3, participantsConcernes: 3, participantsARelancer: 3 } });
    const incomplete = broken('2');
    expect(() => sortSessions([incomplete, withRelances], { key: 'urgence', dir: 'desc' })).not.toThrow();
    const sorted = sortSessions([incomplete, withRelances], { key: 'urgence', dir: 'desc' });
    expect(sorted.map((s) => s.idAdf)).toEqual(['1', '2']); // 3 à relancer d'abord, 0 (incomplet) ensuite
  });

  it('sortSessions par nonSignes : aucun throw', () => {
    expect(() => sortSessions([broken('a'), make({ idAdf: 'b' })], { key: 'nonSignes', dir: 'asc' })).not.toThrow();
  });

  it('applyFilters hasRelances : session sans counts = 0 relance → exclue, sans throw', () => {
    const rows = applyFilters([broken('a'), make({ idAdf: 'b', counts: { envoyes: 1, signes: 0, nonSignes: 1, participantsConcernes: 1, participantsARelancer: 1 } })], {
      search: '',
      etape: null,
      hasRelances: true,
    });
    expect(rows.map((s) => s.idAdf)).toEqual(['b']);
  });

  it('deriveSessions bout-en-bout : un doc incomplet ne crashe pas et n\'apparaît pas faussé', () => {
    const opts = {
      filters: { search: '', etape: null, hasRelances: false },
      sort: { key: 'urgence' as const, dir: 'desc' as const },
      page: 1,
      pageSize: 25,
      todayParis: '2026-06-11',
    };
    // dateFin passée → visible dans le cockpit ; counts absent → 0 partout, pas de throw.
    const incomplete = broken('x', { dateFin: '2026-02-01T00:00:00' });
    expect(() => deriveSessions([incomplete], opts)).not.toThrow();
    const d = deriveSessions([incomplete], opts);
    expect(d.pageItems).toHaveLength(1);
  });
});

describe('normalizeText', () => {
  it('minuscule + supprime accents', () => {
    expect(normalizeText('Réalisation ÉTÉ')).toBe('realisation ete');
  });
});

describe('matchesSearch', () => {
  const s = make({ idAdf: '1', numeroSessionDpc: '26.001', intitule: 'Prévention des risques', numeroCompteProduit: null });

  it('vide → match', () => {
    expect(matchesSearch(s, '  ')).toBe(true);
  });
  it('match sur N° session DPC', () => {
    expect(matchesSearch(s, '26.001')).toBe(true);
  });
  it('accent-insensible + multi-token (ET)', () => {
    expect(matchesSearch(s, 'prevention risques')).toBe(true);
    expect(matchesSearch(s, 'prevention absent')).toBe(false);
  });
  it('numeroCompteProduit null : ne matche pas et ne plante pas', () => {
    expect(matchesSearch(s, '92622626015')).toBe(false);
  });
  it('numeroCompteProduit présent : matche', () => {
    const c = make({ idAdf: '2', numeroCompteProduit: '92622626015' });
    expect(matchesSearch(c, '92622626015')).toBe(true);
  });
  it('numeroSessionDpc null : ne plante pas et matche le reste', () => {
    // make() coalesce null → défaut ; on force null par spread pour tester ce cas.
    const c = { ...make({ idAdf: '3', intitule: 'Formation continue' }), numeroSessionDpc: null };
    expect(matchesSearch(c, 'formation')).toBe(true);
    expect(matchesSearch(c, '26.001')).toBe(false);
  });
});

describe('applyFilters', () => {
  const list = [
    make({ idAdf: '1', etape: 'Réalisation', counts: { envoyes: 3, signes: 1, nonSignes: 2, participantsConcernes: 2, participantsARelancer: 2 } }),
    make({ idAdf: '2', etape: 'Clôturé', counts: { envoyes: 3, signes: 3, nonSignes: 0, participantsConcernes: 3, participantsARelancer: 0 } }),
  ];
  it('filtre étape', () => {
    expect(applyFilters(list, { search: '', etape: 'Clôturé', hasRelances: false }).map((s) => s.idAdf)).toEqual(['2']);
  });
  it('filtre "a des relances"', () => {
    expect(applyFilters(list, { search: '', etape: null, hasRelances: true }).map((s) => s.idAdf)).toEqual(['1']);
  });
});

describe('sortSessions — urgence (défaut)', () => {
  it('plus d\'à-relancer d\'abord, puis plus ancienne demande, null en bas', () => {
    const list = [
      make({ idAdf: 'A', counts: { envoyes: 1, signes: 0, nonSignes: 1, participantsConcernes: 1, participantsARelancer: 1 }, oldestPendingSentDate: '2026-05-01T00:00:00' }),
      make({ idAdf: 'B', counts: { envoyes: 3, signes: 0, nonSignes: 3, participantsConcernes: 3, participantsARelancer: 3 }, oldestPendingSentDate: '2026-04-01T00:00:00' }),
      make({ idAdf: 'C', counts: { envoyes: 1, signes: 0, nonSignes: 1, participantsConcernes: 1, participantsARelancer: 1 }, oldestPendingSentDate: '2026-01-01T00:00:00' }),
      make({ idAdf: 'D', counts: { envoyes: 5, signes: 5, nonSignes: 0, participantsConcernes: 5, participantsARelancer: 0 }, oldestPendingSentDate: null }),
    ];
    const out = sortSessions(list, { key: 'urgence', dir: 'desc' }).map((s) => s.idAdf);
    expect(out).toEqual(['B', 'C', 'A', 'D']); // B(3) puis pending=1 le plus vieux (C avant A), puis D(0)
  });
});

describe('sortSessions — colonne', () => {
  const list = [
    make({ idAdf: '1', totalParticipants: 4 }),
    make({ idAdf: '2', totalParticipants: 12 }),
    make({ idAdf: '3', totalParticipants: 4 }),
  ];
  it('asc + tie-break stable par numeroComplet', () => {
    expect(sortSessions(list, { key: 'totalParticipants', dir: 'asc' }).map((s) => s.idAdf)).toEqual(['1', '3', '2']);
  });
  it('desc', () => {
    expect(sortSessions(list, { key: 'totalParticipants', dir: 'desc' }).map((s) => s.idAdf)).toEqual(['2', '1', '3']);
  });
  it('colonne "nonSignes" (à relancer) desc', () => {
    const l = [
      make({ idAdf: '1', counts: { envoyes: 2, signes: 1, nonSignes: 1, participantsConcernes: 2, participantsARelancer: 1 } }),
      make({ idAdf: '2', counts: { envoyes: 5, signes: 0, nonSignes: 5, participantsConcernes: 5, participantsARelancer: 5 } }),
    ];
    expect(sortSessions(l, { key: 'nonSignes', dir: 'desc' }).map((s) => s.idAdf)).toEqual(['2', '1']);
  });
});

describe('paginate', () => {
  const list = Array.from({ length: 57 }, (_, i) => make({ idAdf: String(i + 1) }));
  it('compteur from/to/pageCount', () => {
    const p = paginate(list, 1, 25);
    expect([p.from, p.to, p.total, p.pageCount]).toEqual([1, 25, 57, 3]);
  });
  it('dernière page partielle', () => {
    const p = paginate(list, 3, 25);
    expect([p.from, p.to, p.pageItems.length]).toEqual([51, 57, 7]);
  });
  it('clampe une page hors borne', () => {
    expect(paginate(list, 99, 25).page).toBe(3);
  });
  it('liste vide → from 0', () => {
    const p = paginate([], 1, 25);
    expect([p.from, p.to, p.total, p.pageCount]).toEqual([0, 0, 0, 1]);
  });
});

describe('distinctEtapes', () => {
  it('unique + trié fr', () => {
    const list = [make({ idAdf: '1', etape: 'Réalisation' }), make({ idAdf: '2', etape: 'Clôturé' }), make({ idAdf: '3', etape: 'Réalisation' })];
    expect(distinctEtapes(list)).toEqual(['Clôturé', 'Réalisation']);
  });
});

describe('isEchecEtape', () => {
  it('détecte "échec" (casse/accent-insensible), pas "Réalisation"', () => {
    expect(isEchecEtape('Echec')).toBe(true);
    expect(isEchecEtape('En échec')).toBe(true);
    expect(isEchecEtape('Réalisation')).toBe(false);
  });
});

describe('isCockpitVisible — terminée (TZ Paris injectée)', () => {
  const today = '2026-07-03';
  it('finit hier → visible', () => {
    expect(isCockpitVisible(make({ idAdf: '1', dateFin: '2026-07-02T09:00:00' }), today)).toBe(true);
  });
  it("finit aujourd'hui → visible (même en soirée)", () => {
    expect(isCockpitVisible(make({ idAdf: '1', dateFin: '2026-07-03T23:00:00' }), today)).toBe(true);
  });
  it('finit demain → caché', () => {
    expect(isCockpitVisible(make({ idAdf: '1', dateFin: '2026-07-04T00:00:00' }), today)).toBe(false);
  });
  it('étape en échec → caché même si terminée', () => {
    expect(isCockpitVisible(make({ idAdf: '1', etape: 'Echec', dateFin: '2026-01-01T00:00:00' }), today)).toBe(false);
  });
  it('PREUVE : numeroComplet ADF_2024* mais session 2025 terminée → visible (année ≠ numéro, cas RAYEUR)', () => {
    // ADF_20240569 = année de CRÉATION 2024, mais dateDebut 2025-02 / dateFin 2025 : c'est une session 2025.
    const rayeur = make({
      idAdf: '3686',
      numeroComplet: 'ADF_20240569',
      numeroSessionDpc: '25.042',
      dateDebut: '2025-02-10T09:00:00',
      dateFin: '2025-02-14T17:00:00',
      etape: 'Réalisation',
    });
    expect(isCockpitVisible(rayeur, today)).toBe(true);
  });
});

describe('deriveSessions — intégration', () => {
  it('filtre → tri urgence → pagination + étapes', () => {
    const list = [
      make({ idAdf: '1', etape: 'Réalisation', counts: { envoyes: 2, signes: 0, nonSignes: 2, participantsConcernes: 2, participantsARelancer: 2 }, oldestPendingSentDate: '2026-03-01T00:00:00' }),
      make({ idAdf: '2', etape: 'Réalisation', counts: { envoyes: 5, signes: 0, nonSignes: 5, participantsConcernes: 5, participantsARelancer: 5 }, oldestPendingSentDate: '2026-02-01T00:00:00' }),
      make({ idAdf: '3', etape: 'Clôturé', counts: { envoyes: 4, signes: 4, nonSignes: 0, participantsConcernes: 4, participantsARelancer: 0 } }),
    ];
    const d = deriveSessions(list, {
      filters: { search: '', etape: 'Réalisation', hasRelances: true },
      sort: { key: 'urgence', dir: 'desc' },
      page: 1,
      pageSize: 25,
      todayParis: '2026-12-31',
    });
    expect(d.total).toBe(2);
    expect(d.pageItems.map((s) => s.idAdf)).toEqual(['2', '1']);
    expect(d.etapes).toEqual(['Clôturé', 'Réalisation']);
    expect([d.from, d.to]).toEqual([1, 2]);
  });

  it('cockpit : exclut sessions à venir + en échec, expose cockpitTotal', () => {
    const list = [
      make({ idAdf: 'past', etape: 'Réalisation', dateFin: '2026-07-01T00:00:00', counts: { envoyes: 1, signes: 0, nonSignes: 1, participantsConcernes: 1, participantsARelancer: 1 }, oldestPendingSentDate: '2026-06-01T00:00:00' }),
      make({ idAdf: 'today', etape: 'Réalisation', dateFin: '2026-07-03T23:00:00' }),
      make({ idAdf: 'future', etape: 'Réalisation', dateFin: '2026-07-10T00:00:00' }),
      make({ idAdf: 'echec', etape: 'Echec', dateFin: '2026-01-01T00:00:00' }),
    ];
    const d = deriveSessions(list, {
      filters: { search: '', etape: null, hasRelances: false },
      sort: { key: 'urgence', dir: 'desc' },
      page: 1,
      pageSize: 25,
      todayParis: '2026-07-03',
    });
    expect(d.cockpitTotal).toBe(2);
    expect(d.pageItems.map((s) => s.idAdf)).toEqual(['past', 'today']); // past a des relances → urgence en tête
    expect(d.etapes).toEqual(['Réalisation']); // "Echec" absent du filtre
  });
});
