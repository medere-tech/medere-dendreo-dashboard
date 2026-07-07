/**
 * Génération CSV 100% client, sans dépendance. Format Excel FR :
 *  - séparateur ";" ;
 *  - fins de ligne CRLF ;
 *  - échappement RFC 4180 (guillemets doublés, champ entre guillemets si besoin) ;
 *  - le BOM UTF-8 est ajouté au TÉLÉCHARGEMENT (downloadCsv), pas dans buildCsv.
 */

export const CSV_SEP = ';';

/** Échappe une cellule : guillemets si elle contient sép., guillemet, ou saut de ligne. */
export function csvEscape(value: string, sep: string = CSV_SEP): string {
  const needsQuote = value.includes(sep) || value.includes('"') || value.includes('\n') || value.includes('\r');
  return needsQuote ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Construit le texte CSV (sans BOM). `rows` = valeurs déjà en string (nulls gérés en amont). */
export function buildCsv(headers: readonly string[], rows: readonly (readonly string[])[], sep: string = CSV_SEP): string {
  const line = (cells: readonly string[]): string => cells.map((c) => csvEscape(c ?? '', sep)).join(sep);
  return [line(headers), ...rows.map(line)].join('\r\n');
}

/**
 * Déclenche le téléchargement d'un CSV avec BOM UTF-8 (accents corrects dans
 * Excel/Sheets). Effet de bord DOM uniquement (pas de logique métier ici).
 */
export function downloadCsv(filename: string, csv: string): void {
  const BOM = '﻿'; // BOM UTF-8 → accents corrects dans Excel/Sheets
  const blob = new Blob([BOM + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
