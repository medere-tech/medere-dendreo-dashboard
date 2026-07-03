import type { ReactNode } from 'react';
import type { SessionDoc, SignatureFilter } from '@/lib/firestore/sessions';
import { IconCheck, IconClock, IconSend } from '@/components/icons';

/**
 * Bloc Signatures (cf. docs/signature-rule.md §4 + ui-spec.md §4.1) : trois
 * chiffres aérés avec MINI-LABEL dessous — Envoyés · Signés (neutres) ·
 * À relancer (nombre ORANGE si > 0) — chacun CLIQUABLE → ouvre le drawer.
 * Sous les chiffres (= volume de DOCUMENTS), une ligne LIBELLÉE explicitement
 * sur les PARTICIPANTS, à ne pas confondre avec la colonne "Part." (total).
 * Statut porté par icône + nombre + libellé, jamais par la couleur seule.
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
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2 tabular-nums">
        <Counter
          onClick={() => onOpen(session, 'envoyes')}
          ariaLabel={`${c.envoyes} envoyés, voir la liste`}
          label="Envoyés"
          value={c.envoyes}
          tone="neutral"
        >
          <IconSend className="h-3.5 w-3.5" />
        </Counter>
        <Counter
          onClick={() => onOpen(session, 'signes')}
          ariaLabel={`${c.signes} signés, voir la liste`}
          label="Signés"
          value={c.signes}
          tone="neutral"
        >
          <IconCheck className="h-3.5 w-3.5" />
        </Counter>
        <Counter
          onClick={() => onOpen(session, 'nonSignes')}
          ariaLabel={`${c.nonSignes} à relancer, voir la liste`}
          label="À relancer"
          value={c.nonSignes}
          tone={relance ? 'accent' : 'faint'}
        >
          <IconClock className="h-3.5 w-3.5" />
        </Counter>
      </div>
      <p className="text-xs tabular-nums text-faint">
        {c.participantsConcernes} concernés par une attestation · {c.participantsARelancer} à relancer
      </p>
    </div>
  );
}

type Tone = 'neutral' | 'accent' | 'faint';

/** Compteur cliquable : nombre (+ icône) au-dessus, mini-label muted dessous. */
function Counter({
  onClick,
  ariaLabel,
  label,
  value,
  tone,
  children,
}: {
  onClick: () => void;
  ariaLabel: string;
  label: string;
  value: number;
  tone: Tone;
  children: ReactNode;
}) {
  const valueTone = tone === 'accent' ? 'font-semibold text-accent' : tone === 'faint' ? 'text-faint' : 'text-muted-2';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className="flex flex-col items-start rounded-md px-1 py-0.5 transition hover:bg-canvas"
    >
      <span className={`inline-flex items-center gap-1 ${valueTone}`}>
        {children}
        {value}
      </span>
      <span aria-hidden="true" className="mt-0.5 text-[11px] leading-none text-faint">
        {label}
      </span>
    </button>
  );
}
