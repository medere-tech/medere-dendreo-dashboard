'use client';

import { useState, type RefObject } from 'react';
import { IconSearch } from '@/components/icons';
import {
  datePresetRange,
  hasActiveFilters,
  type DatePreset,
  type SessionFilters,
  type SortKey,
} from '@/lib/sessions/derive';
import { formatDateFr } from '@/lib/format';

/** Les 4 libellés Format (cf. docs/recon-s5-findings.md §1). */
const FORMAT_OPTIONS = ['Présentiel', 'Mixte', 'E-learning', 'Classe virtuelle'];

const DATE_PRESETS: { key: DatePreset; label: string }[] = [
  { key: 'thisMonth', label: 'Ce mois' },
  { key: 'lastMonth', label: 'Mois dernier' },
  { key: 'year2025', label: '2025' },
  { key: 'year2026', label: '2026' },
];

const SORT_LABELS: Record<SortKey, string> = {
  urgence: 'Urgence',
  numeroSessionDpc: 'N° session DPC',
  numeroCompteProduit: 'N° compte produit',
  intitule: 'Formation',
  dateDebut: 'Début',
  dateFin: 'Fin',
  etape: 'Étape',
  totalParticipants: 'Participants',
  nonSignes: 'À relancer',
};

interface Props {
  searchRef: RefObject<HTMLInputElement | null>;
  filters: SessionFilters;
  onPatch: (patch: Partial<SessionFilters>) => void;
  onReset: () => void;
  etapes: string[];
  todayParis: string;
  total: number; // sessions après filtres
  relanceTotal: number; // Σ à relancer après filtres
  sortKey: SortKey;
  onResetUrgence: () => void;
}

/** Nb de filtres "avancés" actifs (ceux du panneau) → pastille du bouton Filtres. */
function panelCount(f: SessionFilters): number {
  return (
    (f.etape ? 1 : 0) +
    (f.dateFinFrom || f.dateFinTo ? 1 : 0) +
    (f.formats.length > 0 ? 1 : 0) +
    (f.enRetard30 ? 1 : 0) +
    (f.aCheval ? 1 : 0) +
    (f.eppConnecte ? 1 : 0)
  );
}

export function FiltersBar({
  searchRef,
  filters,
  onPatch,
  onReset,
  etapes,
  todayParis,
  total,
  relanceTotal,
  sortKey,
  onResetUrgence,
}: Props) {
  const [open, setOpen] = useState(false);
  const nAdvanced = panelCount(filters);
  const active = hasActiveFilters(filters);

  const toggleFormat = (label: string) => {
    const has = filters.formats.includes(label);
    onPatch({ formats: has ? filters.formats.filter((f) => f !== label) : [...filters.formats, label] });
  };

  const chips = buildChips(filters, onPatch);

  return (
    <div className="mb-4 flex flex-col gap-2.5">
      {/* Row A — barre compacte toujours visible */}
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
            aria-label="Rechercher une session"
            className="w-full rounded-xl border border-hairline bg-surface py-2.5 pl-9 pr-3 text-sm text-ink placeholder:text-faint transition focus:border-ink"
          />
        </div>

        <Toggle pressed={filters.hasRelances} onClick={() => onPatch({ hasRelances: !filters.hasRelances })}>
          À relancer
        </Toggle>

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

        {/* Compteur dynamique — reflète les filtres. Orange seulement sur "à relancer". */}
        <div className="ml-auto text-sm tabular-nums text-muted">
          <span className="font-medium text-ink">{total}</span> sessions
          <span className="mx-1.5 text-faint">·</span>
          <span className={relanceTotal > 0 ? 'font-semibold text-accent' : 'text-faint'}>{relanceTotal}</span> à relancer
        </div>
      </div>

      {/* Row B — puces retirables + reset + rappel tri */}
      {(active || sortKey !== 'urgence') && (
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
          {active && (
            <button
              type="button"
              onClick={onReset}
              className="rounded-full px-2.5 py-1 text-xs text-muted underline underline-offset-2 transition hover:text-ink"
            >
              Réinitialiser les filtres
            </button>
          )}
          {sortKey !== 'urgence' && (
            <button
              type="button"
              onClick={onResetUrgence}
              className="ml-auto rounded-lg border border-hairline bg-surface px-2.5 py-1.5 text-xs text-muted transition hover:text-ink"
            >
              Tri : {SORT_LABELS[sortKey]} · ↺ urgence
            </button>
          )}
        </div>
      )}

      {/* Row C — panneau détaillé, repliable (mobile ET desktop) */}
      {open && (
        <div className="rounded-2xl border border-hairline bg-surface p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Étape">
              <select
                value={filters.etape ?? ''}
                onChange={(e) => onPatch({ etape: e.target.value || null })}
                aria-label="Filtrer par étape"
                className="w-full rounded-xl border border-hairline bg-surface px-3 py-2 text-sm text-ink transition focus:border-ink"
              >
                <option value="">Toutes les étapes</option>
                {etapes.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Format">
              <div className="flex flex-wrap gap-2">
                {FORMAT_OPTIONS.map((label) => (
                  <Toggle key={label} pressed={filters.formats.includes(label)} onClick={() => toggleFormat(label)} small>
                    {label}
                  </Toggle>
                ))}
              </div>
            </Field>

            <Field label="Date de fin">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="date"
                  value={filters.dateFinFrom ?? ''}
                  onChange={(e) => onPatch({ dateFinFrom: e.target.value || null })}
                  aria-label="Date de fin — du"
                  className="rounded-xl border border-hairline bg-surface px-2.5 py-2 text-sm text-ink transition focus:border-ink"
                />
                <span className="text-xs text-faint">au</span>
                <input
                  type="date"
                  value={filters.dateFinTo ?? ''}
                  onChange={(e) => onPatch({ dateFinTo: e.target.value || null })}
                  aria-label="Date de fin — au"
                  className="rounded-xl border border-hairline bg-surface px-2.5 py-2 text-sm text-ink transition focus:border-ink"
                />
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {DATE_PRESETS.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => {
                      const r = datePresetRange(p.key, todayParis);
                      onPatch({ dateFinFrom: r.from, dateFinTo: r.to });
                    }}
                    className="rounded-lg border border-hairline bg-surface px-2.5 py-1.5 text-xs text-muted transition hover:text-ink"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </Field>

            <Field label="Attributs">
              <div className="flex flex-wrap gap-2">
                <Toggle pressed={filters.enRetard30} onClick={() => onPatch({ enRetard30: !filters.enRetard30 })} small>
                  En retard &gt; 30 j
                </Toggle>
                <Toggle pressed={filters.aCheval} onClick={() => onPatch({ aCheval: !filters.aCheval })} small>
                  À cheval
                </Toggle>
                <Toggle pressed={filters.eppConnecte} onClick={() => onPatch({ eppConnecte: !filters.eppConnecte })} small>
                  EPP connecté
                </Toggle>
              </div>
            </Field>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-muted">{label}</p>
      {children}
    </div>
  );
}

function Toggle({
  pressed,
  onClick,
  children,
  small = false,
}: {
  pressed: boolean;
  onClick: () => void;
  children: React.ReactNode;
  small?: boolean;
}) {
  const size = small ? 'px-2.5 py-1.5 text-xs' : 'px-3 py-2.5 text-sm';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      className={`rounded-xl border transition ${size} ${
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

/** Puces des filtres actifs (chacune retirable). Recherche/à-relancer inclus. */
function buildChips(f: SessionFilters, onPatch: (p: Partial<SessionFilters>) => void): Chip[] {
  const chips: Chip[] = [];
  if (f.search.trim()) chips.push({ key: 'search', label: `« ${f.search.trim()} »`, onRemove: () => onPatch({ search: '' }) });
  if (f.hasRelances) chips.push({ key: 'relance', label: 'À relancer', onRemove: () => onPatch({ hasRelances: false }) });
  if (f.etape) chips.push({ key: 'etape', label: `Étape : ${f.etape}`, onRemove: () => onPatch({ etape: null }) });
  if (f.dateFinFrom || f.dateFinTo) {
    const from = f.dateFinFrom ? formatDateFr(f.dateFinFrom) : '…';
    const to = f.dateFinTo ? formatDateFr(f.dateFinTo) : '…';
    chips.push({ key: 'date', label: `Fin : ${from} → ${to}`, onRemove: () => onPatch({ dateFinFrom: null, dateFinTo: null }) });
  }
  for (const fmt of f.formats) {
    chips.push({ key: `fmt-${fmt}`, label: `Format : ${fmt}`, onRemove: () => onPatch({ formats: f.formats.filter((x) => x !== fmt) }) });
  }
  if (f.enRetard30) chips.push({ key: 'retard', label: 'En retard > 30 j', onRemove: () => onPatch({ enRetard30: false }) });
  if (f.aCheval) chips.push({ key: 'acheval', label: 'À cheval', onRemove: () => onPatch({ aCheval: false }) });
  if (f.eppConnecte) chips.push({ key: 'epp', label: 'EPP connecté', onRemove: () => onPatch({ eppConnecte: false }) });
  return chips;
}
