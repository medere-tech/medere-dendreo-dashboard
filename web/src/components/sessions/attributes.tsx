import type { SessionDoc } from '@/lib/firestore/sessions';
import { suiviSignaturesUrl } from '@/lib/dendreo';
import { EMPTY_DISPLAY } from '@/lib/format';
import { IconCheck, IconExternalLink } from '@/components/icons';

/**
 * Présentations réutilisées (table + card) des attributs S5.1b. Tout est NEUTRE :
 * l'orange reste réservé à « à relancer » (cf. design-system.md). Les champs peuvent
 * valoir ""/false tant que le backfill S5.1b n'a pas tourné → défauts propres.
 */

/** Puce Format courte, neutre. Vide → EMPTY_DISPLAY. */
export function FormatPill({ format }: { format: string }) {
  if (!format) return <span className="text-faint">{EMPTY_DISPLAY}</span>;
  return <span className="whitespace-nowrap rounded-md bg-canvas px-2 py-0.5 text-xs text-muted">{format}</span>;
}

/** Case à cocher NEUTRE (statut par forme + libellé, jamais par la couleur seule). */
export function EppCheck({ checked, label }: { checked: boolean; label: string }) {
  return (
    <span
      title={label}
      role="img"
      aria-label={`${label} : ${checked ? 'oui' : 'non'}`}
      className={`inline-flex h-4 w-4 items-center justify-center rounded border ${
        checked ? 'border-hairline text-ink' : 'border-hairline-soft text-faint'
      }`}
    >
      {checked ? <IconCheck className="h-3 w-3" /> : null}
    </span>
  );
}

/** Badge « à cheval » : années dateDebut→dateFin si vrai, sinon EMPTY_DISPLAY. Neutre. */
export function AChevalBadge({ session }: { session: SessionDoc }) {
  if (!session.aCheval) return <span className="text-faint">{EMPTY_DISPLAY}</span>;
  const y1 = session.dateDebut.slice(0, 4);
  const y2 = session.dateFin.slice(0, 4);
  const text = y1.length === 4 && y2.length === 4 ? `${y1}→${y2}` : 'Oui';
  return (
    <span className="whitespace-nowrap rounded-md bg-canvas px-2 py-0.5 text-xs tabular-nums text-muted">{text}</span>
  );
}

/** Nom de la formation, cliquable → espace de stockage des signatures (nouvel onglet). */
export function FormationLink({ session }: { session: SessionDoc }) {
  return (
    <a
      href={suiviSignaturesUrl(session.idAdf)}
      target="_blank"
      rel="noopener noreferrer"
      title="Ouvrir l’espace signatures dans Dendreo"
      className="font-medium text-ink underline-offset-2 hover:underline"
    >
      {session.intitule || EMPTY_DISPLAY}
    </a>
  );
}

/** Bouton dédié « Espace signatures » (neutre). `withLabel` pour la card mobile. */
export function StorageLink({ session, withLabel = false }: { session: SessionDoc; withLabel?: boolean }) {
  return (
    <a
      href={suiviSignaturesUrl(session.idAdf)}
      target="_blank"
      rel="noopener noreferrer"
      title="Espace signatures (Dendreo)"
      aria-label="Ouvrir l’espace signatures dans Dendreo"
      className="inline-flex items-center gap-1 rounded-md border border-hairline px-1.5 py-1 text-xs text-muted transition hover:bg-canvas hover:text-ink"
    >
      <IconExternalLink className="h-3.5 w-3.5" />
      {withLabel ? <span>Espace signatures</span> : null}
    </a>
  );
}
