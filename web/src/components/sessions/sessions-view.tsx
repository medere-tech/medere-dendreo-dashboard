'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSessions } from '@/hooks/use-sessions';
import { useParisToday } from '@/hooks/use-paris-today';
import { deriveSessions, NO_FILTERS, type SessionFilters, type SortKey, type SortState } from '@/lib/sessions/derive';
import type { SessionDoc, SignatureFilter } from '@/lib/firestore/sessions';
import { SessionsSkeleton } from './skeleton';
import { SessionsTable } from './sessions-table';
import { SessionCard } from './session-card';
import { SignatureDrawer } from './signature-drawer';
import { FiltersBar } from './filters-bar';
import { PaginationBar } from './toolbar';
import { downloadCsv } from '@/lib/csv';
import { sessionsCsvFilename, sessionsToCsv } from '@/lib/sessions/export';

const DEFAULT_SORT: SortState = { key: 'urgence', dir: 'desc' };
const NUMERIC_KEYS: SortKey[] = ['totalParticipants', 'nonSignes'];

interface DrawerState {
  session: SessionDoc;
  filter: SignatureFilter;
}

export function SessionsView() {
  const { sessions, loading, error, retry } = useSessions();

  const [filters, setFilters] = useState<SessionFilters>(NO_FILTERS);
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // Toute mise à jour de filtre ramène à la page 1 (résultats recadrés).
  const patchFilters = (patch: Partial<SessionFilters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  };
  const resetFilters = () => {
    setFilters(NO_FILTERS);
    setPage(1);
  };

  const openDrawer = (session: SessionDoc, filter: SignatureFilter) => setDrawer({ session, filter });

  const todayParis = useParisToday();

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
    () => deriveSessions(sessions, { filters, sort, page, pageSize, todayParis }),
    [sessions, filters, sort, page, pageSize, todayParis],
  );

  // Export CSV : EXACTEMENT les lignes filtrées affichées (toutes pages), pas la base.
  function onExport() {
    if (derived.allItems.length === 0) return;
    downloadCsv(sessionsCsvFilename(todayParis), sessionsToCsv(derived.allItems));
  }

  function onSort(key: SortKey) {
    setSort((cur) =>
      cur.key === key
        ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: NUMERIC_KEYS.includes(key) ? 'desc' : 'asc' },
    );
    setPage(1);
  }

  if (loading) return <SessionsSkeleton />;

  if (error) {
    return (
      <div className="flex min-h-40 flex-col items-center justify-center rounded-2xl border border-hairline bg-surface px-6 py-12 text-center">
        <p className="text-sm font-medium text-ink">Impossible de charger les sessions</p>
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
    <>
      <div>
      <FiltersBar
        searchRef={searchRef}
        filters={filters}
        onPatch={patchFilters}
        onReset={resetFilters}
        etapes={derived.etapes}
        todayParis={todayParis}
        total={derived.total}
        relanceTotal={derived.relanceTotal}
        sortKey={sort.key}
        onResetUrgence={() => {
          setSort(DEFAULT_SORT);
          setPage(1);
        }}
        onExport={onExport}
      />

      {sessions.length === 0 ? (
        <EmptyState title="Aucune session" subtitle="Le miroir ne contient pas encore de session 2025–2026." />
      ) : derived.cockpitTotal === 0 ? (
        <EmptyState
          title="Aucune session terminée"
          subtitle="Les sessions à venir et les sessions en échec ne sont pas affichées ici."
        />
      ) : derived.total === 0 ? (
        <EmptyState title="Aucun résultat" subtitle="Ajuste ta recherche ou tes filtres." />
      ) : (
        <>
          <SessionsTable items={derived.pageItems} sort={sort} onSort={onSort} onOpenDrawer={openDrawer} />
          <div className="space-y-3 sm:hidden">
            {derived.pageItems.map((s) => (
              <SessionCard key={s.idAdf} session={s} onOpenDrawer={openDrawer} />
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

      {drawer && (
        <SignatureDrawer session={drawer.session} filter={drawer.filter} onClose={() => setDrawer(null)} />
      )}
    </>
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
