'use client';

import type { RefObject } from 'react';
import { IconChevronLeft, IconChevronRight, IconSearch } from '@/components/icons';
import type { SortKey } from '@/lib/sessions/derive';

const SORT_LABELS: Record<SortKey, string> = {
  urgence: 'Urgence',
  numeroSessionDpc: 'N° session DPC',
  numeroCompteProduit: 'N° compte produit',
  intitule: 'Intitulé',
  dateDebut: 'Début',
  dateFin: 'Fin',
  etape: 'Étape',
  totalParticipants: 'Participants',
  nonSignes: 'À relancer',
};

interface ToolbarProps {
  searchRef: RefObject<HTMLInputElement | null>;
  search: string;
  onSearch: (v: string) => void;
  etape: string | null;
  etapes: string[];
  onEtape: (v: string | null) => void;
  hasRelances: boolean;
  onHasRelances: (v: boolean) => void;
  sortKey: SortKey;
  onResetUrgence: () => void;
}

export function Toolbar({
  searchRef,
  search,
  onSearch,
  etape,
  etapes,
  onEtape,
  hasRelances,
  onHasRelances,
  sortKey,
  onResetUrgence,
}: ToolbarProps) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2.5">
      <div className="relative w-full max-w-xs">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint">
          <IconSearch />
        </span>
        <input
          ref={searchRef}
          type="search"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Rechercher…  ( / )"
          aria-label="Rechercher une session"
          className="w-full rounded-xl border border-hairline bg-surface py-2.5 pl-9 pr-3 text-sm text-ink placeholder:text-faint transition focus:border-ink"
        />
      </div>

      <select
        value={etape ?? ''}
        onChange={(e) => onEtape(e.target.value || null)}
        aria-label="Filtrer par étape"
        className="rounded-xl border border-hairline bg-surface px-3 py-2.5 text-sm text-ink transition focus:border-ink"
      >
        <option value="">Toutes les étapes</option>
        {etapes.map((e) => (
          <option key={e} value={e}>
            {e}
          </option>
        ))}
      </select>

      <button
        type="button"
        onClick={() => onHasRelances(!hasRelances)}
        aria-pressed={hasRelances}
        className={`rounded-xl border px-3 py-2.5 text-sm transition ${
          hasRelances
            ? 'border-ink bg-ink text-surface'
            : 'border-hairline bg-surface text-muted hover:text-ink'
        }`}
      >
        À relancer uniquement
      </button>

      <div className="ml-auto text-xs text-faint">
        {sortKey === 'urgence' ? (
          <span>Tri : urgence (défaut)</span>
        ) : (
          <button
            type="button"
            onClick={onResetUrgence}
            className="rounded-lg border border-hairline bg-surface px-2.5 py-1.5 text-muted transition hover:text-ink"
          >
            Tri : {SORT_LABELS[sortKey]} · ↺ urgence
          </button>
        )}
      </div>
    </div>
  );
}

interface PaginationBarProps {
  from: number;
  to: number;
  total: number;
  page: number;
  pageCount: number;
  pageSize: number;
  onPage: (p: number) => void;
  onPageSize: (n: number) => void;
}

const PAGE_SIZES = [25, 50, 100];

export function PaginationBar({ from, to, total, page, pageCount, pageSize, onPage, onPageSize }: PaginationBarProps) {
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted">
      <div className="tabular-nums">
        {total === 0 ? 'Aucun résultat' : <>{from}–{to} sur {total}</>}
      </div>

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-xs">
          <span className="text-faint">Par page</span>
          <select
            value={pageSize}
            onChange={(e) => onPageSize(Number(e.target.value))}
            aria-label="Nombre de lignes par page"
            className="rounded-lg border border-hairline bg-surface px-2 py-1.5 text-sm text-ink transition focus:border-ink"
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onPage(page - 1)}
            disabled={page <= 1}
            aria-label="Page précédente"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-hairline bg-surface text-muted transition hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            <IconChevronLeft />
          </button>
          <span className="min-w-[5.5rem] text-center text-xs tabular-nums text-muted">
            page {page} / {pageCount}
          </span>
          <button
            type="button"
            onClick={() => onPage(page + 1)}
            disabled={page >= pageCount}
            aria-label="Page suivante"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-hairline bg-surface text-muted transition hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            <IconChevronRight />
          </button>
        </div>
      </div>
    </div>
  );
}
