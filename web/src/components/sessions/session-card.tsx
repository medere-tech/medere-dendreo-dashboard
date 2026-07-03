import type { SessionDoc, SignatureFilter } from '@/lib/firestore/sessions';
import { formatDateFr, orDash } from '@/lib/format';
import { SignaturesBlock } from './signatures-block';

/** Vue mobile : une carte empilée par session (mêmes données que la table). */
export function SessionCard({
  session: s,
  onOpenDrawer,
}: {
  session: SessionDoc;
  onOpenDrawer: (session: SessionDoc, filter: SignatureFilter) => void;
}) {
  return (
    <article className="rounded-2xl border border-hairline bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-ink">{s.intitule}</p>
          <p className="mt-0.5 text-xs tabular-nums text-muted">
            {orDash(s.numeroSessionDpc)} · {orDash(s.numeroCompteProduit)}
          </p>
        </div>
        <span className="shrink-0 rounded-md bg-canvas px-2 py-0.5 text-xs text-muted">{s.etape}</span>
      </div>

      <div className="mt-3 border-t border-hairline-soft pt-3">
        <p className="text-xs tabular-nums text-muted">
          {formatDateFr(s.dateDebut)} → {formatDateFr(s.dateFin)} · {s.totalParticipants} part.
        </p>
        <div className="mt-2">
          <SignaturesBlock session={s} onOpen={onOpenDrawer} />
        </div>
      </div>
    </article>
  );
}
