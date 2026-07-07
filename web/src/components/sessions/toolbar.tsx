'use client';

import { IconChevronLeft, IconChevronRight } from '@/components/icons';

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
