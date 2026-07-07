'use client';

import { IconDownload } from '@/components/icons';

/**
 * Bouton « Exporter » NEUTRE (design-system : pas d'orange sur les CTA).
 * Désactivé si rien à exporter (0 ligne). Le parent fournit `onExport` qui
 * génère + télécharge le CSV depuis le working set FILTRÉ.
 */
export function ExportButton({
  onExport,
  disabled,
  label = 'Exporter',
}: {
  onExport: () => void;
  disabled: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onExport}
      disabled={disabled}
      aria-label="Exporter en CSV les lignes affichées"
      className="inline-flex items-center gap-1.5 rounded-xl border border-hairline bg-surface px-3 py-2.5 text-sm text-muted transition hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
    >
      <IconDownload className="h-4 w-4" />
      {label}
    </button>
  );
}
