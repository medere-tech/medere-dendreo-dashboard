'use client';

import { useState, type ReactNode, type RefObject } from 'react';
import { IconSearch } from '@/components/icons';
import { ExportButton } from '@/components/sessions/export-button';
import { datePresetRange, type DatePreset } from '@/lib/sessions/derive';
import {
  hasActiveRelanceFilters,
  RELANCE_DOC_TYPES,
  type RelanceFilters,
} from '@/lib/sessions/relance';
import { formatDateFr } from '@/lib/format';

const DATE_PRESETS: { key: DatePreset; label: string }[] = [
  { key: 'thisMonth', label: 'Ce mois' },
  { key: 'lastMonth', label: 'Mois dernier' },
  { key: 'year2025', label: '2025' },
  { key: 'year2026', label: '2026' },
];

interface Props {
  searchRef: RefObject<HTMLInputElement | null>;
  filters: RelanceFilters;
  onPatch: (patch: Partial<RelanceFilters>) => void;
  onReset: () => void;
  todayParis: string;
  attestations: number; // filteredTotals — compteur dynamique
  participants: number;
  onExport: () => void;
  exportDisabled: boolean;
}

/** Nb de filtres "avancés" actifs (panneau) → pastille du bouton Filtres. */
function panelCount(f: RelanceFilters): number {
  return (
    (f.sessionQuery.trim() ? 1 : 0) +
    (f.sentFrom || f.sentTo ? 1 : 0) +
    (f.sessionFrom || f.sessionTo ? 1 : 0) +
    (f.enRetard30 ? 1 : 0) +
    (f.docTypes.length > 0 ? 1 : 0)
  );
}

export function RelanceFiltersBar({
  searchRef,
  filters,
  onPatch,
  onReset,
  todayParis,
  attestations,
  participants,
  onExport,
  exportDisabled,
}: Props) {
  const [open, setOpen] = useState(false);
  const nAdvanced = panelCount(filters);
  const active = hasActiveRelanceFilters(filters);
  const chips = buildChips(filters, onPatch);

  const toggleType = (t: string) => {
    const has = filters.docTypes.includes(t);
    onPatch({ docTypes: has ? filters.docTypes.filter((x) => x !== t) : [...filters.docTypes, t] });
  };

  return (
    <div className="mb-4 flex flex-col gap-2.5">
      {/* Row A */}
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="relative w-full max-w-xs">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint">
            <IconSearch />
          </span>
          <input
            ref={searchRef}
            type="search"
            value={filters.search}
            onChange={(e) => onPatch({ search: e.target.value })}
            placeholder="Rechercher…  ( / )"
            aria-label="Rechercher une relance (nom, session, document)"
            className="w-full rounded-xl border border-hairline bg-surface py-2.5 pl-9 pr-3 text-sm text-ink placeholder:text-faint transition focus:border-ink"
          />
        </div>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2.5 text-sm transition ${
            open || nAdvanced > 0 ? 'border-ink text-ink' : 'border-hairline text-muted hover:text-ink'
          } bg-surface`}
        >
          Filtres
          {nAdvanced > 0 && (
            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-ink px-1.5 text-xs tabular-nums text-surface">
              {nAdvanced}
            </span>
          )}
          <span aria-hidden className="text-xs text-faint">{open ? '▲' : '▼'}</span>
        </button>

        <div className="ml-auto flex items-center gap-3">
          <div className="text-sm tabular-nums text-muted">
            <span className="font-semibold text-ink">{attestations}</span> attestations
            <span className="mx-1.5 text-faint">·</span>
            <span className="text-ink">{participants}</span> participants
          </div>
          <ExportButton onExport={onExport} disabled={exportDisabled} />
        </div>
      </div>

      {/* Row B — puces + reset */}
      {active && (
        <div className="flex flex-wrap items-center gap-2">
          {chips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={c.onRemove}
              className="inline-flex items-center gap-1 rounded-full border border-hairline bg-surface px-2.5 py-1 text-xs text-muted transition hover:text-ink"
              aria-label={`Retirer le filtre : ${c.label}`}
            >
              {c.label}
              <span aria-hidden className="text-faint">✕</span>
            </button>
          ))}
          <button
            type="button"
            onClick={onReset}
            className="rounded-full px-2.5 py-1 text-xs text-muted underline underline-offset-2 transition hover:text-ink"
          >
            Réinitialiser les filtres
          </button>
        </div>
      )}

      {/* Row C — panneau */}
      {open && (
        <div className="rounded-2xl border border-hairline bg-surface p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Session (n° DPC ou intitulé)">
              <input
                type="search"
                value={filters.sessionQuery}
                onChange={(e) => onPatch({ sessionQuery: e.target.value })}
                placeholder="ex. 26.001 ou Ménopause"
                aria-label="Filtrer par session"
                className="w-full rounded-xl border border-hairline bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint transition focus:border-ink"
              />
            </Field>

            <Field label="Type de document">
              <div className="flex flex-wrap gap-2">
                {RELANCE_DOC_TYPES.map((t) => (
                  <Toggle key={t} pressed={filters.docTypes.includes(t)} onClick={() => toggleType(t)}>
                    {t}
                  </Toggle>
                ))}
              </div>
            </Field>

            <Field label="Date d’envoi (« Envoyée le »)">
              <div className="flex flex-wrap items-center gap-2">
                <DateInput label="Date d’envoi — du" value={filters.sentFrom} onChange={(v) => onPatch({ sentFrom: v })} />
                <span className="text-xs text-faint">au</span>
                <DateInput label="Date d’envoi — au" value={filters.sentTo} onChange={(v) => onPatch({ sentTo: v })} />
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {DATE_PRESETS.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => {
                      const r = datePresetRange(p.key, todayParis);
                      onPatch({ sentFrom: r.from, sentTo: r.to });
                    }}
                    className="rounded-lg border border-hairline bg-surface px-2.5 py-1.5 text-xs text-muted transition hover:text-ink"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </Field>

            <Field label="Période de session (début/fin)">
              <div className="flex flex-wrap items-center gap-2">
                <DateInput label="Période de session — du" value={filters.sessionFrom} onChange={(v) => onPatch({ sessionFrom: v })} />
                <span className="text-xs text-faint">au</span>
                <DateInput label="Période de session — au" value={filters.sessionTo} onChange={(v) => onPatch({ sessionTo: v })} />
              </div>
              <p className="mt-1.5 text-xs text-faint">Sessions dont la période chevauche l’intervalle.</p>
            </Field>

            <Field label="Ancienneté">
              <Toggle pressed={filters.enRetard30} onClick={() => onPatch({ enRetard30: !filters.enRetard30 })}>
                En retard &gt; 30 j
              </Toggle>
            </Field>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-muted">{label}</p>
      {children}
    </div>
  );
}

function DateInput({ label, value, onChange }: { label: string; value: string | null; onChange: (v: string | null) => void }) {
  return (
    <input
      type="date"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      aria-label={label}
      className="rounded-xl border border-hairline bg-surface px-2.5 py-2 text-sm text-ink transition focus:border-ink"
    />
  );
}

function Toggle({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      className={`rounded-xl border px-2.5 py-1.5 text-xs transition ${
        pressed ? 'border-ink bg-ink text-surface' : 'border-hairline bg-surface text-muted hover:text-ink'
      }`}
    >
      {children}
    </button>
  );
}

interface Chip {
  key: string;
  label: string;
  onRemove: () => void;
}

function buildChips(f: RelanceFilters, onPatch: (p: Partial<RelanceFilters>) => void): Chip[] {
  const chips: Chip[] = [];
  if (f.search.trim()) chips.push({ key: 'search', label: `« ${f.search.trim()} »`, onRemove: () => onPatch({ search: '' }) });
  if (f.sessionQuery.trim()) chips.push({ key: 'session', label: `Session : ${f.sessionQuery.trim()}`, onRemove: () => onPatch({ sessionQuery: '' }) });
  if (f.sentFrom || f.sentTo) {
    chips.push({
      key: 'sent',
      label: `Envoi : ${f.sentFrom ? formatDateFr(f.sentFrom) : '…'} → ${f.sentTo ? formatDateFr(f.sentTo) : '…'}`,
      onRemove: () => onPatch({ sentFrom: null, sentTo: null }),
    });
  }
  if (f.sessionFrom || f.sessionTo) {
    chips.push({
      key: 'sessdate',
      label: `Session : ${f.sessionFrom ? formatDateFr(f.sessionFrom) : '…'} → ${f.sessionTo ? formatDateFr(f.sessionTo) : '…'}`,
      onRemove: () => onPatch({ sessionFrom: null, sessionTo: null }),
    });
  }
  if (f.enRetard30) chips.push({ key: 'retard', label: 'En retard > 30 j', onRemove: () => onPatch({ enRetard30: false }) });
  for (const t of f.docTypes) {
    chips.push({ key: `type-${t}`, label: `Type : ${t}`, onRemove: () => onPatch({ docTypes: f.docTypes.filter((x) => x !== t) }) });
  }
  return chips;
}
