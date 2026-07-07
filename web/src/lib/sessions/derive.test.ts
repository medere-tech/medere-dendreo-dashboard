import { describe, it, expect } from 'vitest';
import type { SessionDoc } from '@/lib/firestore/sessions';
import {
  applyFilters,
  datePresetRange,
  deriveSessions,
  distinctEtapes,
  hasActiveFilters,
  isCockpitVisible,
  isEchecEtape,
  isEnRetard,
  matchesSearch,
  NO_FILTERS,
  normalizeText,
  paginate,
  sortSessions,
  type SessionFilters,
} from './derive';

const TODAY = '2026-06-11';
/** Filtres = base "aucun filtre" + surcharge (évite de réécrire tous les champs). */
const F = (over: Partial<SessionFilters> = {}): SessionFilters => ({ ...NO_FILTERS, ...over });

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
    const rows = applyFilters(
      [broken('a'), make({ idAdf: 'b', counts: { envoyes: 1, signes: 0, nonSignes: 1, participantsConcernes: 1, participantsARelancer: 1 } })],
      F({ hasRelances: true }),
      TODAY,
    );
    expect(rows.map((s) => s.idAdf)).toEqual(['b']);
  });

  it('deriveSessions bout-en-bout : un doc incomplet ne crashe pas et n\'apparaît pas faussé', () => {
    const opts = {
      filters: F(),
      sort: { key: 'urgence' as const, dir: 'desc' as const },
      page: 1,
      pageSize: 25,
      todayParis: TODAY,
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
  it('matche sur le format (accent-insensible)', () => {
    expect(matchesSearch(make({ idAdf: '9', format: 'Classe virtuelle' }), 'classe virtuelle')).toBe(true);
    expect(matchesSearch(make({ idAdf: '9', format: 'Présentiel' }), 'presentiel')).toBe(true);
    expect(matchesSearch(make({ idAdf: '9', format: 'E-learning' }), 'mixte')).toBe(false);
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
    expect(applyFilters(list, F({ etape: 'Clôturé' }), TODAY).map((s) => s.idAdf)).toEqual(['2']);
  });
  it('filtre "a des relances"', () => {
    expect(applyFilters(list, F({ hasRelances: true }), TODAY).map((s) => s.idAdf)).toEqual(['1']);
  });
});

describe('applyFilters — filtres Ops S5.3', () => {
  it('plage dateFin : bornes INCLUSES (du/au)', () => {
    const list = [
      make({ idAdf: 'jun01', dateFin: '2026-06-01T00:00:00' }),
      make({ idAdf: 'jun15', dateFin: '2026-06-15T00:00:00' }),
      make({ idAdf: 'jun30', dateFin: '2026-06-30T23:59:59' }),
      make({ idAdf: 'jul01', dateFin: '2026-07-01T00:00:00' }),
    ];
    const r = applyFilters(list, F({ dateFinFrom: '2026-06-01', dateFinTo: '2026-06-30' }), TODAY);
    expect(r.map((s) => s.idAdf)).toEqual(['jun01', 'jun15', 'jun30']); // 01 et 30 inclus, 07-01 exclu
  });

  it('plage dateFin : borne "du" seule (>=)', () => {
    const list = [make({ idAdf: 'a', dateFin: '2026-05-31T00:00:00' }), make({ idAdf: 'b', dateFin: '2026-06-01T00:00:00' })];
    expect(applyFilters(list, F({ dateFinFrom: '2026-06-01' }), TODAY).map((s) => s.idAdf)).toEqual(['b']);
  });

  it('format multi : passe si ∈ sélection ; pré-backfill (format "") exclu si sélection posée', () => {
    const list = [
      make({ idAdf: 'p', format: 'Présentiel' }),
      make({ idAdf: 'cv', format: 'Classe virtuelle' }),
      make({ idAdf: 'm', format: 'Mixte' }),
      make({ idAdf: 'vide', format: '' }),
    ];
    expect(applyFilters(list, F({ formats: ['Présentiel', 'Classe virtuelle'] }), TODAY).map((s) => s.idAdf)).toEqual(['p', 'cv']);
    // aucune sélection = tous (y compris format vide pré-backfill)
    expect(applyFilters(list, F(), TODAY).map((s) => s.idAdf)).toEqual(['p', 'cv', 'm', 'vide']);
  });

  it('en retard > 30 j : compare le plus vieux pending au jour Paris', () => {
    const list = [
      make({ idAdf: 'vieux', oldestPendingSentDate: '2026-05-01T08:00:00.000000Z' }), // ~41 j avant le 11/06
      make({ idAdf: 'recent', oldestPendingSentDate: '2026-06-05T08:00:00.000000Z' }), // ~6 j
      make({ idAdf: 'sans', oldestPendingSentDate: null }),
    ];
    expect(applyFilters(list, F({ enRetard30: true }), TODAY).map((s) => s.idAdf)).toEqual(['vieux']);
  });

  it('à cheval + EPP connecté (amont OU aval)', () => {
    const list = [
      make({ idAdf: 'ch', aCheval: true }),
      make({ idAdf: 'nonch', aCheval: false }),
      make({ idAdf: 'epp', eppAmontConnecte: false, eppAvalConnecte: true }),
      make({ idAdf: 'noepp', eppAmontConnecte: false, eppAvalConnecte: false }),
    ];
    expect(applyFilters(list, F({ aCheval: true }), TODAY).map((s) => s.idAdf)).toEqual(['ch']);
    expect(applyFilters(list, F({ eppConnecte: true }), TODAY).map((s) => s.idAdf)).toEqual(['epp']);
  });

  it('combinaison ET : format + à cheval + a des relances', () => {
    const list = [
      make({ idAdf: 'ok', format: 'Mixte', aCheval: true, counts: { envoyes: 2, signes: 0, nonSignes: 2, participantsConcernes: 2, participantsARelancer: 2 } }),
      make({ idAdf: 'ko_format', format: 'Présentiel', aCheval: true, counts: { envoyes: 2, signes: 0, nonSignes: 2, participantsConcernes: 2, participantsARelancer: 2 } }),
      make({ idAdf: 'ko_norelance', format: 'Mixte', aCheval: true, counts: { envoyes: 2, signes: 2, nonSignes: 0, participantsConcernes: 2, participantsARelancer: 0 } }),
    ];
    expect(applyFilters(list, F({ formats: ['Mixte'], aCheval: true, hasRelances: true }), TODAY).map((s) => s.idAdf)).toEqual(['ok']);
  });
});

describe('isEnRetard / datePresetRange / hasActiveFilters', () => {
  it('isEnRetard : seuil strict > 30 j', () => {
    expect(isEnRetard(make({ idAdf: '1', oldestPendingSentDate: '2026-05-01T08:00:00.000000Z' }), TODAY)).toBe(true);
    expect(isEnRetard(make({ idAdf: '2', oldestPendingSentDate: '2026-06-05T08:00:00.000000Z' }), TODAY)).toBe(false);
    expect(isEnRetard(make({ idAdf: '3', oldestPendingSentDate: null }), TODAY)).toBe(false);
  });

  it('datePresetRange : ce mois / mois dernier (Paris, dernier jour correct)', () => {
    expect(datePresetRange('thisMonth', '2026-06-11')).toEqual({ from: '2026-06-01', to: '2026-06-30' });
    expect(datePresetRange('lastMonth', '2026-06-11')).toEqual({ from: '2026-05-01', to: '2026-05-31' });
    expect(datePresetRange('lastMonth', '2026-01-15')).toEqual({ from: '2025-12-01', to: '2025-12-31' }); // bascule d'année
    expect(datePresetRange('thisMonth', '2024-02-10')).toEqual({ from: '2024-02-01', to: '2024-02-29' }); // février bissextile
    expect(datePresetRange('year2025', TODAY)).toEqual({ from: '2025-01-01', to: '2025-12-31' });
  });

  it('hasActiveFilters', () => {
    expect(hasActiveFilters(NO_FILTERS)).toBe(false);
    expect(hasActiveFilters(F({ aCheval: true }))).toBe(true);
    expect(hasActiveFilters(F({ formats: ['Mixte'] }))).toBe(true);
    expect(hasActiveFilters(F({ search: '  ' }))).toBe(false); // espaces seuls = inactif
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
      filters: F({ etape: 'Réalisation', hasRelances: true }),
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
      filters: F(),
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
