import { EMPTY_COUNTS, type Counts, type SessionDoc } from '@/lib/firestore/sessions';

/**
 * Accès défensif aux compteurs : même si un doc mirror arrive sans `counts`
 * (backfill interrompu), le tri/filtre lit 0 partout au lieu de crasher.
 * `toSessionDoc` (lecture) garantit déjà `counts` ; ceci est la ceinture+bretelles.
 */
function countsOf(s: SessionDoc): Counts {
  return s.counts ?? EMPTY_COUNTS;
}

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
  todayParis: string; // "YYYY-MM-DD" (injecté → déterministe, cf. lib/time.ts)
}

export interface DerivedSessions {
  pageItems: SessionDoc[];
  total: number; // après filtres utilisateur
  cockpitTotal: number; // sessions "terminées" affichables (avant filtres utilisateur)
  from: number; // 1-indexé (0 si vide)
  to: number;
  page: number; // page effective (clampée)
  pageCount: number;
  etapes: string[]; // étapes distinctes (parmi les sessions affichables) pour le filtre
}

/** Étape "en échec" → exclue du cockpit (libellé normalisé contenant "echec"). */
export function isEchecEtape(etape: string): boolean {
  return normalizeText(etape).includes('echec');
}

/**
 * Session affichable dans le tableau cockpit = TERMINÉE : PAS en échec ET
 * `dateFin` (jour) <= aujourd'hui à Paris. Comparaison lexicographique sur
 * "YYYY-MM-DD" (dates ISO naïves) → aucun passage par UTC, zéro décalage de jour.
 */
export function isCockpitVisible(s: SessionDoc, todayParis: string): boolean {
  if (isEchecEtape(s.etape)) return false;
  return s.dateFin.slice(0, 10) <= todayParis;
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
    if (filters.hasRelances && countsOf(s).nonSignes <= 0) return false;
    if (!matchesSearch(s, filters.search)) return false;
    return true;
  });
}

/** Comparateur "urgence" : plus d'à-relancer d'abord, puis plus ancienne demande. */
function compareUrgence(a: SessionDoc, b: SessionDoc): number {
  const an = countsOf(a).nonSignes;
  const bn = countsOf(b).nonSignes;
  if (bn !== an) return bn - an;
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
      return countsOf(s).nonSignes;
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

export interface PageView<T> {
  pageItems: T[];
  total: number;
  from: number;
  to: number;
  page: number;
  pageCount: number;
}

/** Pagination générique (réutilisée par la vue « À relancer »). */
export function paginate<T>(items: readonly T[], page: number, pageSize: number): PageView<T> {
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
  const visible = sessions.filter((s) => isCockpitVisible(s, opts.todayParis));
  const filtered = applyFilters(visible, opts.filters);
  const sorted = sortSessions(filtered, opts.sort);
  const view = paginate(sorted, opts.page, opts.pageSize);
  return { ...view, cockpitTotal: visible.length, etapes: distinctEtapes(visible) };
}
