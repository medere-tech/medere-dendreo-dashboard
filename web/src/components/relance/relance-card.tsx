import type { RelanceRow } from '@/lib/sessions/relance';
import { formatAgeDays, formatInstantParisFr, orDash } from '@/lib/format';
import { OpenLink } from './relance-table';

/** Vue mobile : une carte empilée par attestation (mêmes données que la table). */
export function RelanceCard({ row: r }: { row: RelanceRow }) {
  return (
    <article className="rounded-2xl border border-hairline bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-ink">{r.nom}</p>
          <p className="mt-0.5 truncate text-xs text-muted">{r.sessionIntitule}</p>
          <p className="mt-0.5 text-xs tabular-nums text-faint">
            {orDash(r.numeroSessionDpc)} · {r.documentName}
          </p>
        </div>
        <span className="shrink-0 rounded-md bg-canvas px-2 py-0.5 text-xs tabular-nums text-muted">
          {formatAgeDays(r.ageDays)}
        </span>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3 border-t border-hairline-soft pt-3">
        <p className="text-xs tabular-nums text-muted">Envoyée le {formatInstantParisFr(r.sentDate)}</p>
        <OpenLink url={r.viewerUrl} />
      </div>
    </article>
  );
}
