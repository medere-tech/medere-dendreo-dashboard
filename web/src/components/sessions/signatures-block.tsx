import type { ReactNode } from 'react';
import type { SessionDoc, SignatureFilter } from '@/lib/firestore/sessions';
import { IconCheck, IconClock, IconSend } from '@/components/icons';

/**
 * Bloc Signatures (cf. docs/signature-rule.md §4 + ui-spec.md §4.1) : trois
 * chiffres aérés — Envoyés · Signés (neutres) · À relancer (ORANGE si > 0) —
 * chacun CLIQUABLE → ouvre le drawer sur le sous-ensemble correspondant.
 * Sous les chiffres (= volume de documents), une ligne LIBELLÉE explicitement
 * sur les PARTICIPANTS, à ne pas confondre avec la colonne "Part." (total).
 * Statut porté par icône + nombre + libellé a11y, jamais par la couleur seule.
 */
export function SignaturesBlock({
  session,
  onOpen,
}: {
  session: SessionDoc;
  onOpen: (session: SessionDoc, filter: SignatureFilter) => void;
}) {
  const c = session.counts;
  const relance = c.nonSignes > 0;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 tabular-nums">
        <CountButton
          onClick={() => onOpen(session, 'envoyes')}
          label={`${c.envoyes} envoyés, voir la liste`}
          className="text-muted-2"
        >
          <IconSend className="h-3.5 w-3.5" />
          {c.envoyes}
        </CountButton>
        <CountButton
          onClick={() => onOpen(session, 'signes')}
          label={`${c.signes} signés, voir la liste`}
          className="text-muted-2"
        >
          <IconCheck className="h-3.5 w-3.5" />
          {c.signes}
        </CountButton>
        <CountButton
          onClick={() => onOpen(session, 'nonSignes')}
          label={`${c.nonSignes} à relancer, voir la liste`}
          className={relance ? 'font-semibold text-accent' : 'text-faint'}
        >
          <IconClock className="h-3.5 w-3.5" />
          {c.nonSignes}
        </CountButton>
      </div>
      <p className="text-xs tabular-nums text-faint">
        {c.participantsConcernes} concernés par une attestation · {c.participantsARelancer} à relancer
      </p>
    </div>
  );
}

/** Compteur cliquable : cible tactile confortable, focus visible, hover discret. */
function CountButton({
  onClick,
  label,
  className,
  children,
}: {
  onClick: () => void;
  label: string;
  className: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={`inline-flex items-center gap-1 rounded-md px-1 py-0.5 transition hover:bg-canvas ${className}`}
    >
      {children}
    </button>
  );
}
