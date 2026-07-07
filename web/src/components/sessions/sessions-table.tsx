'use client';

import type { SessionDoc, SignatureFilter } from '@/lib/firestore/sessions';
import type { SortKey, SortState } from '@/lib/sessions/derive';
import { formatDateFr, orDash } from '@/lib/format';
import { SignaturesBlock } from './signatures-block';
import { AChevalBadge, EppCheck, FormatPill, FormationLink, StorageLink } from './attributes';

interface Column {
  key: SortKey | null;
  label: string;
  align?: 'right' | 'center';
  title?: string; // tooltip d'en-tête (colonnes courtes)
  className?: string;
}

// Ordre validé (S5.2) : identité → Formation → Format → dates → EPP amont/aval → À cheval → Étape/Part./Signatures.
const COLUMNS: Column[] = [
  { key: 'numeroSessionDpc', label: 'N° session DPC' },
  { key: 'numeroCompteProduit', label: 'N° compte produit' },
  { key: 'intitule', label: 'Formation', className: 'min-w-[15rem]' },
  { key: null, label: 'Format' },
  { key: 'dateDebut', label: 'Début' },
  { key: 'dateFin', label: 'Fin' },
  { key: null, label: 'EPP amont', align: 'center', title: 'Module EPP amont avec heures connectées', className: 'w-16' },
  { key: null, label: 'EPP aval', align: 'center', title: 'Module EPP aval avec heures connectées', className: 'w-16' },
  { key: null, label: 'À cheval', title: 'Session sur deux années (début ≠ fin)' },
  { key: 'etape', label: 'Étape' },
  { key: 'totalParticipants', label: 'Part.', align: 'right' },
  { key: 'nonSignes', label: 'Signatures' },
];

interface Props {
  items: SessionDoc[];
  sort: SortState;
  onSort: (key: SortKey) => void;
  onOpenDrawer: (session: SessionDoc, filter: SignatureFilter) => void;
}

export function SessionsTable({ items, sort, onSort, onOpenDrawer }: Props) {
  return (
    <div className="hidden overflow-x-auto rounded-2xl border border-hairline bg-surface sm:block">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-hairline-soft bg-canvas text-left">
            {COLUMNS.map((col) => {
              const active = col.key !== null && sort.key === col.key;
              const ariaSort = active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
              return (
                <th
                  key={col.label}
                  scope="col"
                  aria-sort={col.key ? ariaSort : undefined}
                  title={col.title}
                  className={`whitespace-nowrap px-4 py-3 font-medium text-muted ${col.align === 'right' ? 'text-right' : ''} ${col.align === 'center' ? 'text-center' : ''} ${col.className ?? ''}`}
                >
                  {col.key ? (
                    <button
                      type="button"
                      onClick={() => onSort(col.key as SortKey)}
                      className={`inline-flex items-center gap-1 transition hover:text-ink ${active ? 'text-ink' : ''} ${col.align === 'right' ? 'flex-row-reverse' : ''}`}
                    >
                      {col.label}
                      <span aria-hidden="true" className="text-xs text-faint">
                        {active ? (sort.dir === 'asc' ? '▲' : '▼') : ''}
                      </span>
                    </button>
                  ) : (
                    col.label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {items.map((s) => (
            <tr key={s.idAdf} className="border-b border-hairline-soft transition-colors last:border-0 hover:bg-canvas">
              <td className="whitespace-nowrap px-4 py-3 font-medium tabular-nums text-ink">{orDash(s.numeroSessionDpc)}</td>
              <td className="whitespace-nowrap px-4 py-3 tabular-nums text-muted">{orDash(s.numeroCompteProduit)}</td>
              <td className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <FormationLink session={s} />
                  <StorageLink session={s} />
                </div>
              </td>
              <td className="whitespace-nowrap px-4 py-3"><FormatPill format={s.format} /></td>
              <td className="whitespace-nowrap px-4 py-3 tabular-nums text-muted">{formatDateFr(s.dateDebut)}</td>
              <td className="whitespace-nowrap px-4 py-3 tabular-nums text-muted">{formatDateFr(s.dateFin)}</td>
              <td className="px-4 py-3 text-center"><EppCheck checked={s.eppAmontConnecte} label="EPP amont connecté" /></td>
              <td className="px-4 py-3 text-center"><EppCheck checked={s.eppAvalConnecte} label="EPP aval connecté" /></td>
              <td className="whitespace-nowrap px-4 py-3"><AChevalBadge session={s} /></td>
              <td className="whitespace-nowrap px-4 py-3">
                <span className="rounded-md bg-canvas px-2 py-0.5 text-xs text-muted">{s.etape}</span>
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-muted">{s.totalParticipants}</td>
              <td className="whitespace-nowrap px-4 py-3">
                <SignaturesBlock session={s} onOpen={onOpenDrawer} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
