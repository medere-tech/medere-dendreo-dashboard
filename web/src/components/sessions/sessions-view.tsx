'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSessions } from '@/hooks/use-sessions';
import { useParisToday } from '@/hooks/use-paris-today';
import { deriveSessions, type SortKey, type SortState } from '@/lib/sessions/derive';
import type { SessionDoc, SignatureFilter } from '@/lib/firestore/sessions';
import { SessionsSkeleton } from './skeleton';
import { SessionsTable } from './sessions-table';
import { SessionCard } from './session-card';
import { SignatureDrawer } from './signature-drawer';
import { PaginationBar, Toolbar } from './toolbar';

const DEFAULT_SORT: SortState = { key: 'urgence', dir: 'desc' };
const NUMERIC_KEYS: SortKey[] = ['totalParticipants', 'nonSignes'];

interface DrawerState {
  session: SessionDoc;
  filter: SignatureFilter;
}

export function SessionsView() {
  const { sessions, loading, error, retry } = useSessions();

  const [search, setSearch] = useState('');
  const [etape, setEtape] = useState<string | null>(null);
  const [hasRelances, setHasRelances] = useState(false);
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

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
    () => deriveSessions(sessions, { filters: { search, etape, hasRelances }, sort, page, pageSize, todayParis }),
    [sessions, search, etape, hasRelances, sort, page, pageSize, todayParis],
  );

  function onSort(key: SortKey) {
    setSort((cur) =>
      cur.key === key
        ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: NUMERIC_KEYS.includes(key) ? 'desc' : 'asc' },
    );
    setPage(1);
  }

  const resetPageAnd =
    <T,>(fn: (v: T) => void) =>
    (v: T) => {
      fn(v);
      setPage(1);
    };

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
      <Toolbar
        searchRef={searchRef}
        search={search}
        onSearch={resetPageAnd(setSearch)}
        etape={etape}
        etapes={derived.etapes}
        onEtape={resetPageAnd(setEtape)}
        hasRelances={hasRelances}
        onHasRelances={resetPageAnd(setHasRelances)}
        sortKey={sort.key}
        onResetUrgence={() => {
          setSort(DEFAULT_SORT);
          setPage(1);
        }}
      />

      {sessions.length === 0 ? (
        <EmptyState title="Aucune session 2026" subtitle="Le miroir ne contient pas encore de session pour 2026." />
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
            onPageSize={resetPageAnd(setPageSize)}
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
