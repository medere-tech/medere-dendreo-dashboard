'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { usePendingSignatures } from '@/hooks/use-pending-signatures';
import { useSessionsIndex } from '@/hooks/use-sessions-index';
import { useParisToday } from '@/hooks/use-paris-today';
import { deriveRelance, NO_RELANCE_FILTERS, type RelanceFilters, type RelanceSortDir } from '@/lib/sessions/relance';
import { PaginationBar } from '@/components/sessions/toolbar';
import { SessionsSkeleton } from '@/components/sessions/skeleton';
import { downloadCsv } from '@/lib/csv';
import { relanceCsvFilename, relanceToCsv } from '@/lib/sessions/export';
import { RelanceFiltersBar } from './relance-filters-bar';
import { RelanceTable } from './relance-table';
import { RelanceCard } from './relance-card';

export function RelanceView() {
  const pendingState = usePendingSignatures();
  const indexState = useSessionsIndex();
  const todayParis = useParisToday();

  const [filters, setFilters] = useState<RelanceFilters>(NO_RELANCE_FILTERS);
  const [sortDir, setSortDir] = useState<RelanceSortDir>('asc'); // plus vieux d'abord
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const patchFilters = (patch: Partial<RelanceFilters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  };
  const resetFilters = () => {
    setFilters(NO_RELANCE_FILTERS);
    setPage(1);
  };

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
    () => deriveRelance(pendingState.pending, indexState.index, { filters, sortDir, page, pageSize, todayParis }),
    [pendingState.pending, indexState.index, filters, sortDir, page, pageSize, todayParis],
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
      <RelanceFiltersBar
        searchRef={searchRef}
        filters={filters}
        onPatch={patchFilters}
        onReset={resetFilters}
        todayParis={todayParis}
        attestations={derived.filteredTotals.attestations}
        participants={derived.filteredTotals.participants}
        onExport={onExport}
        exportDisabled={derived.allRows.length === 0}
      />

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
