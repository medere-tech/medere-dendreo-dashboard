import type { SessionDoc } from '@/lib/firestore/sessions';

/**
 * Logique PURE du tableau Sessions : recherche / filtre / tri (urgence par
 * défaut) / pagination. Aucun accès réseau, aucun état React → testable seul.
 * Tout tourne en mémoire sur le working set → instantané (<50 ms).
 */

export type SortKey =
  | 'urgence'
  | 'numeroSessionDpc'
  | 'numeroCompteProduit'
  | 'intitule'
  | 'dateDebut'
  | 'dateFin'
  | 'etape'
  | 'totalParticipants'
  | 'nonSignes';

export type SortDir = 'asc' | 'desc';

export interface SortState {
  key: SortKey;
  dir: SortDir;
}

export interface SessionFilters {
  search: string;
  etape: string | null;
  hasRelances: boolean;
}

export interface DeriveOptions {
  filters: SessionFilters;
  sort: SortState;
  page: number;
  pageSize: number;
}

export interface DerivedSessions {
  pageItems: SessionDoc[];
  total: number; // après filtres
  from: number; // 1-indexé (0 si vide)
  to: number;
  page: number; // page effective (clampée)
  pageCount: number;
  etapes: string[]; // étapes distinctes (toutes sessions) pour le filtre
}

/** minuscules + suppression des accents, pour recherche/tri insensibles. */
export function normalizeText(v: string): string {
  return v.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Recherche multi-tokens (ET) sur tous les champs pertinents. `null` ignoré. */
export function matchesSearch(s: SessionDoc, rawQuery: string): boolean {
  const q = normalizeText(rawQuery).trim();
  if (!q) return true;
  const haystack = normalizeText(
    [s.numeroSessionDpc ?? '', s.numeroCompteProduit ?? '', s.numeroComplet, s.intitule, s.etape].join(' '),
  );
  return q.split(/\s+/).every((token) => haystack.includes(token));
}

export function applyFilters(sessions: readonly SessionDoc[], filters: SessionFilters): SessionDoc[] {
  return sessions.filter((s) => {
    if (filters.etape && s.etape !== filters.etape) return false;
    if (filters.hasRelances && s.counts.nonSignes <= 0) return false;
    if (!matchesSearch(s, filters.search)) return false;
    return true;
  });
}

/** Comparateur "urgence" : plus d'à-relancer d'abord, puis plus ancienne demande. */
function compareUrgence(a: SessionDoc, b: SessionDoc): number {
  if (b.counts.nonSignes !== a.counts.nonSignes) return b.counts.nonSignes - a.counts.nonSignes;
  const ao = a.oldestPendingSentDate;
  const bo = b.oldestPendingSentDate;
  if (ao !== bo) {
    if (ao === null) return 1; // sans date → en bas
    if (bo === null) return -1;
    return ao < bo ? -1 : 1; // ISO → lexicographique = chronologique (plus vieux d'abord)
  }
  return tieBreak(a, b);
}

function tieBreak(a: SessionDoc, b: SessionDoc): number {
  if (a.numeroComplet < b.numeroComplet) return -1;
  if (a.numeroComplet > b.numeroComplet) return 1;
  return 0;
}

function fieldValue(s: SessionDoc, key: Exclude<SortKey, 'urgence'>): string | number {
  switch (key) {
    case 'numeroSessionDpc':
      return s.numeroSessionDpc ?? '';
    case 'numeroCompteProduit':
      return s.numeroCompteProduit ?? '';
    case 'intitule':
      return normalizeText(s.intitule);
    case 'dateDebut':
      return s.dateDebut;
    case 'dateFin':
      return s.dateFin;
    case 'etape':
      return normalizeText(s.etape);
    case 'totalParticipants':
      return s.totalParticipants;
    case 'nonSignes':
      return s.counts.nonSignes;
  }
}

export function sortSessions(sessions: readonly SessionDoc[], sort: SortState): SessionDoc[] {
  const copy = [...sessions];
  if (sort.key === 'urgence') return copy.sort(compareUrgence);

  const dir = sort.dir === 'asc' ? 1 : -1;
  const key = sort.key;
  return copy.sort((a, b) => {
    const av = fieldValue(a, key);
    const bv = fieldValue(b, key);
    let c = 0;
    if (av < bv) c = -1;
    else if (av > bv) c = 1;
    c *= dir;
    return c !== 0 ? c : tieBreak(a, b);
  });
}

export function distinctEtapes(sessions: readonly SessionDoc[]): string[] {
  const set = new Set<string>();
  for (const s of sessions) if (s.etape) set.add(s.etape);
  return [...set].sort((a, b) => a.localeCompare(b, 'fr'));
}

export interface PageView {
  pageItems: SessionDoc[];
  total: number;
  from: number;
  to: number;
  page: number;
  pageCount: number;
}

export function paginate(items: readonly SessionDoc[], page: number, pageSize: number): PageView {
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const clamped = Math.min(Math.max(1, page), pageCount);
  const start = (clamped - 1) * pageSize;
  const pageItems = items.slice(start, start + pageSize);
  return {
    pageItems,
    total,
    from: total === 0 ? 0 : start + 1,
    to: Math.min(start + pageSize, total),
    page: clamped,
    pageCount,
  };
}

export function deriveSessions(sessions: readonly SessionDoc[], opts: DeriveOptions): DerivedSessions {
  const filtered = applyFilters(sessions, opts.filters);
  const sorted = sortSessions(filtered, opts.sort);
  const view = paginate(sorted, opts.page, opts.pageSize);
  return { ...view, etapes: distinctEtapes(sessions) };
}
