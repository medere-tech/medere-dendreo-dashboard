'use client';

import type { ReactNode } from 'react';
import type { RelanceRow, RelanceSortDir } from '@/lib/sessions/relance';
import { EMPTY_DISPLAY, formatAgeDays, formatInstantParisFr, orDash } from '@/lib/format';

/**
 * Table desktop « À relancer » — une ligne par attestation. Tri sur « Envoyée le »
 * (ancienneté), plus vieux d'abord par défaut. LECTURE SEULE : « Ouvrir dans
 * Dendreo » (viewerUrl, _blank), jamais « Relancer ».
 */
export function RelanceTable({
  rows,
  sortDir,
  onToggleSort,
}: {
  rows: RelanceRow[];
  sortDir: RelanceSortDir;
  onToggleSort: () => void;
}) {
  return (
    <div className="hidden overflow-x-auto rounded-2xl border border-hairline bg-surface sm:block">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-hairline-soft bg-canvas text-left">
            <Th>Participant</Th>
            <Th>N° session DPC</Th>
            <Th className="min-w-[16rem]">Intitulé session</Th>
            <Th>Document</Th>
            <th scope="col" aria-sort={sortDir === 'asc' ? 'ascending' : 'descending'} className="whitespace-nowrap px-4 py-3 font-medium text-muted">
              <button
                type="button"
                onClick={onToggleSort}
                className="inline-flex items-center gap-1 text-ink transition hover:text-ink"
              >
                Envoyée le
                <span aria-hidden="true" className="text-xs text-faint">
                  {sortDir === 'asc' ? '▲' : '▼'}
                </span>
              </button>
            </th>
            <Th>Ancienneté</Th>
            <Th className="text-right">Action</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-hairline-soft transition-colors last:border-0 hover:bg-canvas">
              <td className="px-4 py-3 font-medium text-ink">{r.nom}</td>
              <td className="whitespace-nowrap px-4 py-3 tabular-nums text-muted">{orDash(r.numeroSessionDpc)}</td>
              <td className="px-4 py-3 text-ink">{r.sessionIntitule}</td>
              <td className="px-4 py-3 text-muted">{r.documentName}</td>
              <td className="whitespace-nowrap px-4 py-3 tabular-nums text-muted">{formatInstantParisFr(r.sentDate)}</td>
              <td className="whitespace-nowrap px-4 py-3 tabular-nums text-muted">{formatAgeDays(r.ageDays)}</td>
              <td className="whitespace-nowrap px-4 py-3 text-right">
                <OpenLink url={r.viewerUrl} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <th scope="col" className={`whitespace-nowrap px-4 py-3 font-medium text-muted ${className}`}>{children}</th>;
}

export function OpenLink({ url }: { url: string | null }) {
  if (!url) return <span className="text-xs text-faint">{EMPTY_DISPLAY}</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-block rounded-lg border border-hairline bg-surface px-2.5 py-1.5 text-xs font-medium text-ink transition hover:bg-canvas"
    >
      Ouvrir dans Dendreo
    </a>
  );
}
