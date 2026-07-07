'use client';

/**
 * Error Boundary du groupe (dashboard) — Next.js App Router.
 * Filet de dernier recours : toute exception de rendu NON gérée dans une page
 * du dashboard (au lieu d'une page blanche) affiche cet écran sobre. Les erreurs
 * de données (Firestore) sont déjà gérées en amont dans les hooks/vues ; ceci
 * couvre le résiduel imprévu. `reset()` re-render le segment.
 */
export default function DashboardError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center px-6 py-12 text-center">
      <div className="flex max-w-sm flex-col items-center rounded-2xl border border-hairline bg-surface px-6 py-10">
        <p className="text-sm font-medium text-ink">Une erreur est survenue.</p>
        <p className="mt-1 text-sm text-muted">Réessaie.</p>
        <button
          type="button"
          onClick={reset}
          className="mt-5 rounded-xl border border-hairline bg-surface px-4 py-2 text-sm font-medium text-ink transition hover:bg-canvas"
        >
          Réessayer
        </button>
      </div>
    </div>
  );
}
