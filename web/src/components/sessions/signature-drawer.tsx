'use client';

import { useEffect, useMemo, useState } from 'react';
import { getDocs, type FirestoreError } from 'firebase/firestore';
import { getFirebaseDb } from '@/lib/firebase/client';
import {
  SIGNATURE_FILTER_LABELS,
  countForFilter,
  signaturesForSessionQuery,
  signatureViewerHref,
  toSignatureDoc,
  type SessionDoc,
  type SignatureDoc,
  type SignatureFilter,
} from '@/lib/firestore/sessions';
import { EMPTY_DISPLAY, formatInstantParisFr } from '@/lib/format';
import { normalizeText } from '@/lib/sessions/derive';
import { IconSearch } from '@/components/icons';

const ANIM_MS = 180;

/**
 * Panneau glissant « clic → liste » (ui-spec.md §4.5). LECTURE SEULE : on
 * consulte, jamais on ne « Relance » (aucune écriture Dendreo/Firestore).
 * Chargement one-shot `getDocs` + skeleton (pas d'`onSnapshot` — cf. décision b).
 */
export function SignatureDrawer({
  session,
  filter,
  onClose,
}: {
  session: SessionDoc;
  filter: SignatureFilter;
  onClose: () => void;
}) {
  const [visible, setVisible] = useState(false);
  const [rows, setRows] = useState<SignatureDoc[] | null>(null);
  const [error, setError] = useState<FirestoreError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [search, setSearch] = useState('');

  // Slide-in : on monte hors écran puis on bascule à la frame suivante.
  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Sortie animée puis démontage réel côté parent.
  function requestClose() {
    setVisible(false);
    window.setTimeout(onClose, ANIM_MS);
  }

  // Échap ferme (capturé au niveau document).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        requestClose();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Chargement one-shot (re-déclenché par "Réessayer").
  useEffect(() => {
    let alive = true;
    setRows(null);
    setError(null);
    getDocs(signaturesForSessionQuery(getFirebaseDb(), session.idAdf, filter))
      .then((snap) => {
        if (!alive) return;
        // Normalisation défensive à la lecture (comme la vue "À relancer") : viewerUrl
        // lu par la MÊME voie que la vue qui marche, jamais un cast brut divergent.
        setRows(sortSignatures(snap.docs.map((d) => toSignatureDoc(d.data()))));
      })
      .catch((e: FirestoreError) => {
        if (alive) setError(e);
      });
    return () => {
      alive = false;
    };
  }, [session.idAdf, filter, attempt]);

  const label = SIGNATURE_FILTER_LABELS[filter];
  const expected = countForFilter(session.counts, filter);

  const filtered = useMemo(() => {
    if (!rows) return null;
    const q = normalizeText(search).trim();
    if (!q) return rows;
    const tokens = q.split(/\s+/);
    return rows.filter((r) => {
      const hay = normalizeText(r.nom);
      return tokens.every((t) => hay.includes(t));
    });
  }, [rows, search]);

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={`${label} — ${session.intitule}`}>
      {/* Scrim */}
      <button
        type="button"
        aria-label="Fermer"
        onClick={requestClose}
        className={`absolute inset-0 bg-ink/20 transition-opacity duration-[180ms] ${visible ? 'opacity-100' : 'opacity-0'}`}
      />

      {/* Panneau */}
      <div
        className={`absolute right-0 top-0 flex h-full w-full max-w-md flex-col bg-surface shadow-xl transition-transform duration-[180ms] ease-out ${
          visible ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <header className="flex items-start justify-between gap-3 border-b border-hairline-soft px-5 py-4">
          <div className="min-w-0">
            <p className="flex items-baseline gap-2 text-sm font-semibold text-ink">
              <span>{label}</span>
              <span className="tabular-nums text-muted">{expected}</span>
            </p>
            <p className="mt-0.5 truncate text-xs text-muted">{session.intitule}</p>
          </div>
          <button
            type="button"
            onClick={requestClose}
            aria-label="Fermer le panneau"
            className="-mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted transition hover:bg-canvas hover:text-ink"
          >
            <span aria-hidden="true" className="text-lg leading-none">
              ×
            </span>
          </button>
        </header>

        {/* Recherche dans la liste */}
        <div className="border-b border-hairline-soft px-5 py-3">
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint">
              <IconSearch className="h-4 w-4" />
            </span>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Rechercher un nom…"
              aria-label="Rechercher dans la liste"
              className="w-full rounded-xl border border-hairline bg-surface py-2 pl-9 pr-3 text-sm text-ink placeholder:text-faint transition focus:border-ink"
            />
          </div>
        </div>

        {/* Corps */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {error ? (
            <DrawerError onRetry={() => setAttempt((a) => a + 1)} />
          ) : filtered === null ? (
            <DrawerSkeleton />
          ) : filtered.length === 0 ? (
            <DrawerEmpty hasSearch={search.trim() !== ''} label={label} />
          ) : (
            <ul className="divide-y divide-hairline-soft">
              {filtered.map((r) => (
                <SignatureRow key={`${r.idParticipant}_${r.doctypeId}`} row={r} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * UNE LIGNE PAR ATTESTATION (par document), jamais regroupé par personne : une
 * même personne peut apparaître plusieurs fois (1 ligne / attestation), d'où le
 * `documentName` affiché pour lever l'ambiguïté. nom · doc · date · lien Dendreo.
 */
function SignatureRow({ row }: { row: SignatureDoc }) {
  const signed = row.status === 'signed';
  const date = signed ? row.signatureDate : row.sentDate;
  const dateLabel = signed ? 'Signée le' : 'Envoyée le';
  const href = signatureViewerHref(row); // = row.viewerUrl (jamais reconstruit) ; null si absent
  return (
    <li className="flex items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className="truncate text-sm text-ink">{row.nom}</p>
        <p className="mt-0.5 truncate text-xs text-muted">{row.documentName}</p>
        <p className="mt-0.5 text-xs tabular-nums text-faint">
          {dateLabel} {formatInstantParisFr(date)}
        </p>
      </div>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 rounded-lg border border-hairline bg-surface px-2.5 py-1.5 text-xs font-medium text-ink transition hover:bg-canvas"
        >
          Ouvrir dans Dendreo
        </a>
      ) : (
        <span className="shrink-0 text-xs text-faint">{EMPTY_DISPLAY}</span>
      )}
    </li>
  );
}

function DrawerSkeleton() {
  return (
    <ul className="divide-y divide-hairline-soft">
      {Array.from({ length: 6 }).map((_, i) => (
        <li key={i} className="flex items-center justify-between gap-3 py-3">
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="h-4 w-40 animate-pulse rounded bg-hairline-soft" />
            <div className="h-3 w-28 animate-pulse rounded bg-hairline-soft" />
          </div>
          <div className="h-7 w-28 animate-pulse rounded-lg bg-hairline-soft" />
        </li>
      ))}
    </ul>
  );
}

function DrawerEmpty({ hasSearch, label }: { hasSearch: boolean; label: string }) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center px-4 py-12 text-center">
      <p className="text-sm font-medium text-ink">{hasSearch ? 'Aucun nom trouvé' : `Aucun « ${label} »`}</p>
      <p className="mt-1 max-w-xs text-sm text-muted">
        {hasSearch ? 'Ajuste ta recherche.' : 'Rien à afficher pour ce chiffre.'}
      </p>
    </div>
  );
}

function DrawerError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center px-4 py-12 text-center">
      <p className="text-sm font-medium text-ink">Impossible de charger la liste</p>
      <p className="mt-1 max-w-xs text-sm text-muted">Vérifie ta connexion, puis réessaie.</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 rounded-xl border border-hairline bg-surface px-4 py-2 text-sm font-medium text-ink transition hover:bg-canvas"
      >
        Réessayer
      </button>
    </div>
  );
}

/**
 * Tri (décision architecte) : à relancer d'abord (sentDate asc = plus vieux en
 * haut, priorité), puis signés (signatureDate desc = plus récent en haut).
 * Dates ISO naïves → comparaison lexicographique ; null en bas de chaque groupe.
 */
export function sortSignatures(list: readonly SignatureDoc[]): SignatureDoc[] {
  return [...list].sort((a, b) => {
    const ap = a.status === 'pending' ? 0 : 1;
    const bp = b.status === 'pending' ? 0 : 1;
    if (ap !== bp) return ap - bp;
    if (a.status === 'pending') return cmpDate(a.sentDate, b.sentDate, 'asc');
    return cmpDate(a.signatureDate, b.signatureDate, 'desc');
  });
}

function cmpDate(a: string | null, b: string | null, dir: 'asc' | 'desc'): number {
  if (a === b) return 0;
  if (a === null) return 1; // null toujours en bas
  if (b === null) return -1;
  const c = a < b ? -1 : 1;
  return dir === 'asc' ? c : -c;
}
