import type { SessionDoc, SignatureDoc } from '@/lib/firestore/sessions';
import { daysBetween, parisDayOfInstant } from '@/lib/time';
import { EN_RETARD_SEUIL_JOURS, isEchecEtape, normalizeText, paginate, type PageView } from './derive';

/**
 * Logique PURE de la vue « À relancer » (ui-spec.md §4.2) : jointure
 * signatures pending × sessions, exclusion des sessions en « Echec », calcul
 * d'ancienneté (jour Paris), tri par ancienneté, recherche, pagination.
 * Aucun accès réseau, aucun état React → testable seule.
 *
 * UNE LIGNE PAR ATTESTATION (par document) — jamais regroupé par personne.
 */

export type RelanceSortDir = 'asc' | 'desc';

export interface RelanceRow {
  id: string; // clé stable : idParticipant_doctypeId
  idAdf: string;
  idParticipant: string;
  doctypeId: string;
  nom: string;
  documentName: string;
  numeroSessionDpc: string | null; // vient de la session (null si session absente → fail-open)
  sessionIntitule: string;
  sessionNumeroComplet: string;
  sessionDateDebut: string; // via jointure session (fallback doc signature) — filtre période
  sessionDateFin: string; // via jointure session uniquement ('' si session absente)
  sentDate: string | null; // instant UTC-Z brut (tri)
  sentDay: string | null; // jour Paris de l'envoi "YYYY-MM-DD" (filtre date d'envoi)
  ageDays: number | null; // ancienneté en jours (jour Paris → todayParis)
  viewerUrl: string | null;
}

/** Type de document d'une attestation (S7). Buckets prouvés (scan Dendreo) :
 *  EPP amont (doctype 165), EPP aval (166), sinon PI/formation continue (172/173/177). */
export type RelanceDocType = 'EPP amont' | 'EPP aval' | 'PI (formation continue)';
export const RELANCE_DOC_TYPES: readonly RelanceDocType[] = ['EPP amont', 'EPP aval', 'PI (formation continue)'];

/** Classe une attestation par son NOM (robuste aux variantes d'année/doctype). */
export function relanceDocType(documentName: string): RelanceDocType {
  const n = normalizeText(documentName);
  if (/epp.*amont|audit.*clinique.*amont/.test(n)) return 'EPP amont';
  if (/epp.*aval|audit.*clinique.*aval/.test(n)) return 'EPP aval';
  return 'PI (formation continue)'; // catch-all (100% du reste = "Attestation sur l'honneur PI")
}

export interface RelanceTotals {
  attestations: number;
  participants: number;
}

/**
 * Jointure + exclusion Echec + ancienneté. `sessionsById` = index de TOUTES les
 * sessions. Session en « Echec » → exclue. Session absente de la map → FAIL-OPEN
 * (on affiche la ligne, `numeroSessionDpc=null`) : cacher une relance est pire.
 */
export function buildRelanceRows(
  pending: readonly SignatureDoc[],
  sessionsById: ReadonlyMap<string, SessionDoc>,
  todayParis: string,
): RelanceRow[] {
  const rows: RelanceRow[] = [];
  for (const sig of pending) {
    const session = sessionsById.get(sig.idAdf);
    if (session && isEchecEtape(session.etape)) continue; // exclusion « Echec »
    const sentDay = parisDayOfInstant(sig.sentDate);
    rows.push({
      id: `${sig.idParticipant}_${sig.doctypeId}`,
      idAdf: sig.idAdf,
      idParticipant: sig.idParticipant,
      doctypeId: sig.doctypeId,
      nom: sig.nom,
      documentName: sig.documentName,
      numeroSessionDpc: session?.numeroSessionDpc ?? null,
      sessionIntitule: session?.intitule ?? sig.sessionIntitule,
      sessionNumeroComplet: session?.numeroComplet ?? sig.sessionNumeroComplet,
      sessionDateDebut: session?.dateDebut ?? sig.sessionDateDebut ?? '',
      sessionDateFin: session?.dateFin ?? '',
      sentDate: sig.sentDate,
      sentDay: sentDay || null,
      ageDays: sentDay ? daysBetween(sentDay, todayParis) : null,
      viewerUrl: sig.viewerUrl,
    });
  }
  return rows;
}

/** GRAND TOTAL figé (sur l'ensemble, avant recherche) : docs + participants distincts. */
export function relanceTotals(rows: readonly RelanceRow[]): RelanceTotals {
  const participants = new Set<string>();
  for (const r of rows) participants.add(r.idParticipant);
  return { attestations: rows.length, participants: participants.size };
}

function tieBreak(a: RelanceRow, b: RelanceRow): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Tri par ancienneté (`sentDate` instant). asc = plus vieux d'abord (défaut). null en bas. */
export function sortRelance(rows: readonly RelanceRow[], dir: RelanceSortDir): RelanceRow[] {
  const d = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (a.sentDate !== b.sentDate) {
      if (a.sentDate === null) return 1; // null toujours en bas
      if (b.sentDate === null) return -1;
      return (a.sentDate < b.sentDate ? -1 : 1) * d;
    }
    return tieBreak(a, b);
  });
}

/** Une ligne matche-t-elle une recherche multi-tokens (ET) ? `haystack` fourni. */
function matchesTokens(haystack: string, rawQuery: string): boolean {
  const q = normalizeText(rawQuery).trim();
  if (!q) return true;
  const hay = normalizeText(haystack);
  return q.split(/\s+/).every((t) => hay.includes(t));
}

/** Recherche globale (nom / session / document). Accent-insensible, multi-tokens. */
export function relanceMatchesSearch(r: RelanceRow, rawQuery: string): boolean {
  return matchesTokens([r.nom, r.numeroSessionDpc ?? '', r.sessionIntitule, r.sessionNumeroComplet, r.documentName].join(' '), rawQuery);
}

/** Recherche dédiée "session" (n° DPC / intitulé / n° complet). */
export function relanceMatchesSession(r: RelanceRow, rawQuery: string): boolean {
  return matchesTokens([r.numeroSessionDpc ?? '', r.sessionIntitule, r.sessionNumeroComplet].join(' '), rawQuery);
}

/** Recherche seule (compat) : filtre les lignes sur la recherche globale. */
export function filterRelance(rows: readonly RelanceRow[], rawQuery: string): RelanceRow[] {
  return rows.filter((r) => relanceMatchesSearch(r, rawQuery));
}

// --- Filtres S7 (combinés en ET, 100% mémoire) ------------------------------
export interface RelanceFilters {
  search: string; // recherche globale (existante)
  sessionQuery: string; // #1 recherche dédiée session (DPC + intitulé)
  sentFrom: string | null; // #2 date d'envoi — du (jour Paris "YYYY-MM-DD")
  sentTo: string | null; // #2 date d'envoi — au
  sessionFrom: string | null; // #3 période de session — du (chevauchement)
  sessionTo: string | null; // #3 période de session — au
  enRetard30: boolean; // #4 ancienneté > 30 j (sur ageDays)
  docTypes: string[]; // #5 multi-select type (RELANCE_DOC_TYPES)
}

export const NO_RELANCE_FILTERS: RelanceFilters = {
  search: '',
  sessionQuery: '',
  sentFrom: null,
  sentTo: null,
  sessionFrom: null,
  sessionTo: null,
  enRetard30: false,
  docTypes: [],
};

export function hasActiveRelanceFilters(f: RelanceFilters): boolean {
  return (
    f.search.trim() !== '' ||
    f.sessionQuery.trim() !== '' ||
    f.sentFrom !== null ||
    f.sentTo !== null ||
    f.sessionFrom !== null ||
    f.sessionTo !== null ||
    f.enRetard30 ||
    f.docTypes.length > 0
  );
}

export function applyRelanceFilters(rows: readonly RelanceRow[], filters: RelanceFilters): RelanceRow[] {
  return rows.filter((r) => {
    // #1 session (DPC / intitulé)
    if (filters.sessionQuery.trim() && !relanceMatchesSession(r, filters.sessionQuery)) return false;
    // #2 date d'envoi (jour Paris) — bornes incluses ; sans jour d'envoi → exclue si borne posée
    if (filters.sentFrom && (!r.sentDay || r.sentDay < filters.sentFrom)) return false;
    if (filters.sentTo && (!r.sentDay || r.sentDay > filters.sentTo)) return false;
    // #3 période de session (chevauchement : début ≤ au ET fin ≥ du)
    const sd = r.sessionDateDebut.slice(0, 10);
    const sf = r.sessionDateFin.slice(0, 10);
    if (filters.sessionFrom && (!sf || sf < filters.sessionFrom)) return false;
    if (filters.sessionTo && (!sd || sd > filters.sessionTo)) return false;
    // #4 en retard > seuil (sur ancienneté déjà calculée)
    if (filters.enRetard30 && !(r.ageDays !== null && r.ageDays > EN_RETARD_SEUIL_JOURS)) return false;
    // #5 type de document
    if (filters.docTypes.length > 0 && !filters.docTypes.includes(relanceDocType(r.documentName))) return false;
    // recherche globale
    if (!relanceMatchesSearch(r, filters.search)) return false;
    return true;
  });
}

export interface DeriveRelanceOptions {
  filters: RelanceFilters;
  sortDir: RelanceSortDir;
  page: number;
  pageSize: number;
  todayParis: string;
}

export interface DerivedRelance extends PageView<RelanceRow> {
  allRows: RelanceRow[]; // TOUTE la liste filtrée+triée (toutes pages) → export CSV
  totals: RelanceTotals; // GRAND TOTAL figé (avant filtres) → état "tout est signé"
  filteredTotals: RelanceTotals; // compteur DYNAMIQUE (reflète les filtres)
}

export function deriveRelance(
  pending: readonly SignatureDoc[],
  sessionsById: ReadonlyMap<string, SessionDoc>,
  opts: DeriveRelanceOptions,
): DerivedRelance {
  const all = buildRelanceRows(pending, sessionsById, opts.todayParis);
  const totals = relanceTotals(all); // figé (avant filtres)
  const filtered = applyRelanceFilters(all, opts.filters);
  const filteredTotals = relanceTotals(filtered);
  const sorted = sortRelance(filtered, opts.sortDir);
  const view = paginate(sorted, opts.page, opts.pageSize);
  return { ...view, allRows: sorted, totals, filteredTotals };
}
