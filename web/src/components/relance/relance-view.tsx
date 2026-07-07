'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { usePendingSignatures } from '@/hooks/use-pending-signatures';
import { useSessionsIndex } from '@/hooks/use-sessions-index';
import { useParisToday } from '@/hooks/use-paris-today';
import { deriveRelance, type RelanceSortDir } from '@/lib/sessions/relance';
import { IconSearch } from '@/components/icons';
import { PaginationBar } from '@/components/sessions/toolbar';
import { SessionsSkeleton } from '@/components/sessions/skeleton';
import { ExportButton } from '@/components/sessions/export-button';
import { downloadCsv } from '@/lib/csv';
import { relanceCsvFilename, relanceToCsv } from '@/lib/sessions/export';
import { RelanceTable } from './relance-table';
import { RelanceCard } from './relance-card';

export function RelanceView() {
  const pendingState = usePendingSignatures();
  const indexState = useSessionsIndex();
  const todayParis = useParisToday();

  const [search, setSearch] = useState('');
  const [sortDir, setSortDir] = useState<RelanceSortDir>('asc'); // plus vieux d'abord
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // Raccourci "/" → focus recherche (sauf si déjà dans un champ).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement | null)?.isContentEditable) return;
      e.preventDefault();
      searchRef.current?.focus();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const derived = useMemo(
    () => deriveRelance(pendingState.pending, indexState.index, { search, sortDir, page, pageSize, todayParis }),
    [pendingState.pending, indexState.index, search, sortDir, page, pageSize, todayParis],
  );

  const loading = pendingState.loading || indexState.loading;
  const error = pendingState.error ?? indexState.error;

  function retry() {
    pendingState.retry();
    indexState.retry();
  }

  // Export CSV : exactement les lignes filtrées (recherche appliquée), toutes pages.
  function onExport() {
    if (derived.allRows.length === 0) return;
    downloadCsv(relanceCsvFilename(todayParis), relanceToCsv(derived.allRows));
  }

  if (loading) return <SessionsSkeleton />;

  if (error) {
    return (
      <div className="flex min-h-40 flex-col items-center justify-center rounded-2xl border border-hairline bg-surface px-6 py-12 text-center">
        <p className="text-sm font-medium text-ink">Impossible de charger les relances</p>
        <p className="mt-1 max-w-sm text-sm text-muted">Vérifie ta connexion, puis réessaie.</p>
        <button
          type="button"
          onClick={retry}
          className="mt-4 rounded-xl border border-hairline bg-surface px-4 py-2 text-sm font-medium text-ink transition hover:bg-canvas"
        >
          Réessayer
        </button>
      </div>
    );
  }

  return (
    <div>
      {/* En-tête : GRAND TOTAL figé (ne suit pas la recherche). */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          <span className="font-semibold tabular-nums text-ink">{derived.totals.attestations}</span> attestations à relancer{' '}
          · <span className="tabular-nums text-ink">{derived.totals.participants}</span> participants
        </p>

        <div className="flex items-center gap-2.5">
          <div className="relative w-full max-w-xs">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint">
              <IconSearch />
            </span>
            <input
              ref={searchRef}
              type="search"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Rechercher…  ( / )"
              aria-label="Rechercher une relance (nom, session, document)"
              className="w-full rounded-xl border border-hairline bg-surface py-2.5 pl-9 pr-3 text-sm text-ink placeholder:text-faint transition focus:border-ink"
            />
          </div>
          <ExportButton onExport={onExport} disabled={derived.total === 0} />
        </div>
      </div>

      {derived.totals.attestations === 0 ? (
        <EmptyState title="Aucune attestation à relancer" subtitle="Tout est signé. Rien à relancer pour le moment." />
      ) : derived.total === 0 ? (
        <EmptyState title="Aucun résultat" subtitle="Ajuste ta recherche." />
      ) : (
        <>
          <RelanceTable rows={derived.pageItems} sortDir={sortDir} onToggleSort={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))} />
          <div className="space-y-3 sm:hidden">
            {derived.pageItems.map((r) => (
              <RelanceCard key={r.id} row={r} />
            ))}
          </div>
          <PaginationBar
            from={derived.from}
            to={derived.to}
            total={derived.total}
            page={derived.page}
            pageCount={derived.pageCount}
            pageSize={pageSize}
            onPage={setPage}
            onPageSize={(n) => {
              setPageSize(n);
              setPage(1);
            }}
          />
        </>
      )}
    </div>
  );
}

function EmptyState({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center rounded-2xl border border-dashed border-hairline bg-surface px-6 py-12 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      <p className="mt-1 max-w-sm text-sm text-muted">{subtitle}</p>
    </div>
  );
}
