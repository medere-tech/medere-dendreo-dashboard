import { EMPTY_COUNTS, type Counts, type SessionDoc } from '@/lib/firestore/sessions';
import type { RelanceRow } from './relance';
import { parisDayOfInstant } from '@/lib/time';
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
 * EPP CO/NC (S6.2) : `—` si la session n'a AUCUN module EPP (`aEpp=false`),
 * sinon `{amont}/{aval}` avec CO = connecté (heures connectées > 0), NC = non connecté.
 * Ex. "—", "CO/CO", "NC/CO", "NC/NC".
 */
export function eppCoNc(s: Pick<SessionDoc, 'eppAmontConnecte' | 'eppAvalConnecte' | 'aEpp'>): string {
  if (!s.aEpp) return '—';
  return `${s.eppAmontConnecte ? 'CO' : 'NC'}/${s.eppAvalConnecte ? 'CO' : 'NC'}`;
}

/** Résumé signatures lisible pour la colonne "Signatures". */
export function signaturesSummary(c: Counts): string {
  if (c.envoyes === 0) return '—'; // rien d'envoyé → ni "tous signé" ni "à relancer"
  if (c.nonSignes === 0) return 'Tous ont signé';
  return `${c.nonSignes} à relancer`;
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
    '', // Attestation manquante (Ops)
    '', // Dendreo         (Ops)
    '', // Dossier         (Ops)
    s.idAdf ? suiviSignaturesUrl(s.idAdf) : '', // Lien stockage — constante partagée, jamais reconstruit
  ];
}

export function sessionsToCsv(rows: readonly SessionDoc[]): string {
  return buildCsv(SESSIONS_CSV_HEADERS, rows.map(sessionToCsvRow));
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
