/** Skeletons du 1er chargement (jamais de spinner brut). */
export function SessionsSkeleton() {
  return (
    <div>
      {/* barre d'outils fantôme */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="h-10 w-full max-w-xs animate-pulse rounded-xl bg-hairline-soft" />
        <div className="h-10 w-40 animate-pulse rounded-xl bg-hairline-soft" />
        <div className="h-10 w-36 animate-pulse rounded-xl bg-hairline-soft" />
      </div>
      {/* table fantôme (desktop) */}
      <div className="hidden overflow-hidden rounded-2xl border border-hairline bg-surface sm:block">
        <div className="h-11 border-b border-hairline-soft bg-canvas" />
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 border-b border-hairline-soft px-4 py-3 last:border-0">
            <div className="h-4 w-16 animate-pulse rounded bg-hairline-soft" />
            <div className="h-4 w-24 animate-pulse rounded bg-hairline-soft" />
            <div className="h-4 flex-1 animate-pulse rounded bg-hairline-soft" />
            <div className="h-4 w-20 animate-pulse rounded bg-hairline-soft" />
            <div className="h-4 w-28 animate-pulse rounded bg-hairline-soft" />
          </div>
        ))}
      </div>
      {/* cartes fantômes (mobile) */}
      <div className="space-y-3 sm:hidden">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-28 animate-pulse rounded-2xl border border-hairline bg-surface" />
        ))}
      </div>
    </div>
  );
}
