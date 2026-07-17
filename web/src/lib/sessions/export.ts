import { EMPTY_COUNTS, type Counts, type SessionDoc } from '@/lib/firestore/sessions';
import type { RelanceRow } from './relance';
import { parisDayOfInstant } from '@/lib/time';
import { EMPTY_DISPLAY } from '@/lib/format';
import { buildCsv } from '@/lib/csv';
import { suiviSignaturesUrl } from '@/lib/dendreo';

/**
 * Mapping CSV « Ops » (calqué sur le Google Sheet de Déthié). Logique PURE et
 * testable : colonnes + valeurs (échappement délégué à lib/csv). Les colonnes
 * remplies à la main par les Ops sortent VIDES.
 */

/** Date session ISO naïve "YYYY-MM-DD…" → "JJ/MM/AA". Vide/invalide → "". */
export function ddmmyy(iso: string | null | undefined): string {
  const [y, m, d] = String(iso ?? '').slice(0, 10).split('-');
  if (!y || !m || !d) return '';
  return `${d}/${m}/${y.slice(2)}`;
}

/** Instant absolu ("…Z") → jour Paris "JJ/MM/AA". Vide/invalide → "". */
export function ddmmyyFromInstant(instant: string | null | undefined): string {
  return ddmmyy(parisDayOfInstant(instant));
}

/**
 * EPP CO/NC (S6.2) : EMPTY_DISPLAY si la session n'a AUCUN module EPP (`aEpp=false`),
 * sinon `{amont}/{aval}` avec CO = connecté (heures connectées > 0), NC = non connecté.
 * Ex. "-", "CO/CO", "NC/CO", "NC/NC".
 */
export function eppCoNc(s: Pick<SessionDoc, 'eppAmontConnecte' | 'eppAvalConnecte' | 'aEpp'>): string {
  if (!s.aEpp) return EMPTY_DISPLAY;
  return `${s.eppAmontConnecte ? 'CO' : 'NC'}/${s.eppAvalConnecte ? 'CO' : 'NC'}`;
}

/** Résumé signatures lisible pour la colonne "Signatures". */
export function signaturesSummary(c: Counts): string {
  if (c.envoyes === 0) return EMPTY_DISPLAY; // rien d'envoyé → ni "tous signé" ni "à relancer"
  if (c.nonSignes === 0) return 'Tous ont signé';
  return `${c.nonSignes} à relancer`;
}

/** Colonne "Attestation manquante" : EMPTY_DISPLAY si 0 envoyé, "Signature complète" si
 *  tout signé, sinon "{nonSignes}/{envoyes}" (non signées / envoyées). */
export function attestationManquante(c: Counts): string {
  if (c.envoyes === 0) return EMPTY_DISPLAY;
  if (c.nonSignes === 0) return 'Signature complète';
  return `${c.nonSignes}/${c.envoyes}`;
}

// --- COCKPIT (ordre EXACT du Sheet Ops) -------------------------------------
export const SESSIONS_CSV_HEADERS = [
  'DPC', 'Intitulé', 'N° CP', 'Session', 'Organisation', 'Début', 'Fin', 'EPP CO/NC', 'Cheval?',
  'Date de dépôt', 'Montant €', 'Date de paiement', 'Signatures', 'Commentaire', 'Relance',
  'Attestation manquante', 'Dendreo', 'Dossier', 'Lien stockage',
] as const;

export function sessionToCsvRow(s: SessionDoc): string[] {
  const c = s.counts ?? EMPTY_COUNTS;
  return [
    s.eligibleDpc ? 'TRUE' : 'FALSE', // DPC = éligibilité DPC (S6.2)
    s.intitule ?? '',
    s.numeroCompteProduit ?? '',
    s.numeroSessionDpc ?? '',
    s.format ?? '',
    ddmmyy(s.dateDebut),
    ddmmyy(s.dateFin),
    eppCoNc(s),
    s.aCheval ? '✅' : '❌',
    '', // Date de dépôt   (Ops)
    '', // Montant €       (Ops)
    '', // Date de paiement(Ops)
    signaturesSummary(c),
    '', // Commentaire     (Ops)
    '', // Relance         (Ops)
    attestationManquante(c), // Attestation manquante (S6.3)
    '', // Dendreo         (Ops)
    '', // Dossier         (Ops)
    s.idAdf ? suiviSignaturesUrl(s.idAdf) : '', // Lien stockage — constante partagée, jamais reconstruit
  ];
}

export function sessionsToCsv(rows: readonly SessionDoc[]): string {
  return buildCsv(SESSIONS_CSV_HEADERS, rows.map(sessionToCsvRow));
}

// --- COCKPIT — variante "sheet" (S10.1, route /api/export/sheet) -------------
// EXACTEMENT l'export CSV cockpit, préfixé de la clé `idAdf` en 1re colonne. Cette
// clé permet à l'Apps Script (S10.2) de mettre à jour le Google Sheet EN PLACE,
// ligne par ligne, sans écraser les colonnes remplies à la main par les Ops.
// ZÉRO logique dupliquée : les colonnes du milieu = `sessionToCsvRow(s)` tel quel ;
// toute évolution de colonne du CSV se propage automatiquement ici (source unique).
//
// S10.2b — « À relancer (noms) » est ajoutée EN DERNIÈRE position, APRÈS
// `SESSIONS_CSV_HEADERS` (donc après "Lien stockage") : les index des colonnes
// existantes du Sheet Ops ne bougent PAS. Elle est propre au format "sheet" (elle
// n'entre pas dans le CSV cockpit, qui reste strictement inchangé) car elle exige
// une lecture de la collection `signatures` que l'export CSV client ne fait pas.
export const RELANCE_NOMS_HEADER = 'À relancer (noms)';
export const SESSIONS_SHEET_HEADERS = ['idAdf', ...SESSIONS_CSV_HEADERS, RELANCE_NOMS_HEADER] as const;

/**
 * Cellule "À relancer (noms)" : noms pending d'UNE session, déjà dédupliqués par
 * participant en amont (cf. route sheet). Triés alphabétiquement (`fr`, donc
 * accents-insensible : "Émile" se range à "E"), joints par ", ". Format "Prénom NOM"
 * tel que stocké dans `signatures.nom` — Dendreo ne fournit pas "NOM Prénom" et le
 * miroir ne conserve pas prénom/nom séparés (cf. rapport de recon S10.2b).
 * Aucun nom → EMPTY_DISPLAY (jamais "").
 */
export function relanceNomsCell(noms: readonly string[]): string {
  if (noms.length === 0) return EMPTY_DISPLAY;
  return [...noms].sort((a, b) => a.localeCompare(b, 'fr')).join(', ');
}

export function sessionToSheetRow(s: SessionDoc, noms: readonly string[] = []): string[] {
  return [s.idAdf, ...sessionToCsvRow(s), relanceNomsCell(noms)];
}

// --- À RELANCER --------------------------------------------------------------
export const RELANCE_CSV_HEADERS = [
  'Participant', 'N° session DPC', 'Intitulé', 'Document', 'Envoyée le', 'Ancienneté (jours)', 'Lien Dendreo',
] as const;

export function relanceToCsvRow(r: RelanceRow): string[] {
  return [
    r.nom ?? '',
    r.numeroSessionDpc ?? '',
    r.sessionIntitule ?? '',
    r.documentName ?? '',
    ddmmyyFromInstant(r.sentDate),
    r.ageDays === null ? '' : String(r.ageDays),
    r.viewerUrl ?? '',
  ];
}

export function relanceToCsv(rows: readonly RelanceRow[]): string {
  return buildCsv(RELANCE_CSV_HEADERS, rows.map(relanceToCsvRow));
}

// --- Noms de fichiers horodatés (jour Paris "YYYY-MM-DD") --------------------
export function sessionsCsvFilename(todayParis: string): string {
  return `medere-sessions-${todayParis}.csv`;
}
export function relanceCsvFilename(todayParis: string): string {
  return `medere-a-relancer-${todayParis}.csv`;
}
