import type { SessionDoc, SignatureDoc } from '@/lib/firestore/sessions';
import { daysBetween, parisDayOfInstant } from '@/lib/time';
import { isEchecEtape, normalizeText, paginate, type PageView } from './derive';

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
  sentDate: string | null; // instant UTC-Z brut (tri)
  ageDays: number | null; // ancienneté en jours (jour Paris → todayParis)
  viewerUrl: string | null;
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
      sentDate: sig.sentDate,
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

/** Recherche multi-tokens (ET) sur nom / session / document. Accent-insensible. */
export function filterRelance(rows: readonly RelanceRow[], rawQuery: string): RelanceRow[] {
  const q = normalizeText(rawQuery).trim();
  if (!q) return rows.slice();
  const tokens = q.split(/\s+/);
  return rows.filter((r) => {
    const hay = normalizeText(
      [r.nom, r.numeroSessionDpc ?? '', r.sessionIntitule, r.sessionNumeroComplet, r.documentName].join(' '),
    );
    return tokens.every((t) => hay.includes(t));
  });
}

export interface DeriveRelanceOptions {
  search: string;
  sortDir: RelanceSortDir;
  page: number;
  pageSize: number;
  todayParis: string;
}

export interface DerivedRelance extends PageView<RelanceRow> {
  allRows: RelanceRow[]; // TOUTE la liste filtrée+triée (toutes pages) → export CSV
  totals: RelanceTotals; // GRAND TOTAL figé (ne suit PAS la recherche)
}

export function deriveRelance(
  pending: readonly SignatureDoc[],
  sessionsById: ReadonlyMap<string, SessionDoc>,
  opts: DeriveRelanceOptions,
): DerivedRelance {
  const all = buildRelanceRows(pending, sessionsById, opts.todayParis);
  const totals = relanceTotals(all); // figé, calculé avant la recherche
  const searched = filterRelance(all, opts.search);
  const sorted = sortRelance(searched, opts.sortDir);
  const view = paginate(sorted, opts.page, opts.pageSize);
  return { ...view, allRows: sorted, totals };
}
