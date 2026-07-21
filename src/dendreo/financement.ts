// src/dendreo/financement.ts — Enrichissement FINANCEMENTS + FACTURES (V2/V3).
// -----------------------------------------------------------------------------
// Fonctions PURES (aucune I/O, testables seules) + enrichFinancement (I/O
// RÉSILIENTE, partagée par backfill.mjs ET sync.ts → aucune dérive/duplication)
// + ensureAndpcValidated (validation du LIBELLÉ ANDPC, mise en cache).
//
// Endpoints & champs PROUVÉS sur données réelles (recons S11.0a→g) :
//   financements.php?id_action_de_formation → { id_finance, id_financeur, type, montant_finance }
//   factures.php?id_action_de_formation     → { id_opca, date_envoi, montant_total_ht, date_paiement, date_emission }
//   laps.php?id_action_de_formation         → { id_participant, id_entreprise }  (champs natifs, sans include)
//   financeurs.php?id=360                   → raison_sociale "ANDPC"
//
// Chaîne participant ↔ financeur PROUVÉE (S11.0f) :
//   idParticipant → laps.id_entreprise → financements.id_finance → id_financeur
//
// LECTURE SEULE Dendreo. Aucune PII loggée. Dates facture = jour Paris naïf (slice 10), jamais d'UTC.
// -----------------------------------------------------------------------------

import { DendreoClient } from './client';

/** id_financeur de l'ANDPC (S11.0b/g : financeurs.php?id=360 → raison_sociale "ANDPC"). */
export const ANDPC_ID = '360';

/** Une ligne de financements.php (vue minimale). */
export interface FinancementLine {
  idFinance: string; // = laps.id_entreprise (entreprise de facturation du participant)
  idFinanceur: string; // 360 = ANDPC
  type: string; // "opca" | "particulier" | "entreprise"
  montant: number; // montant_finance parsé
}

/** Une facture de factures.php (vue minimale ; dates déjà en jour Paris naïf | null). */
export interface FactureLine {
  idOpca: string; // 360 = ANDPC
  dateEnvoi: string | null;
  montantHt: number | null;
  datePaiement: string | null;
  dateEmission: string | null; // gardé pour diagnostic (non utilisé par l'agrégation)
}

/** Un lien inscription minimal (laps.php). */
export interface LapLink {
  idParticipant: string;
  idEntreprise: string; // laps.id_entreprise
}

// --- Helpers purs -----------------------------------------------------------
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** "560.5000" / "560,5" → nombre ; vide/non fini → 0. */
export function parseMontant(v: unknown): number {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

/** Date Dendreo "AAAA-MM-JJ HH:MM:SS" → jour Paris naïf "AAAA-MM-JJ". Vide/absent → null.
 *  PAS de conversion UTC (même règle que dateDebut/dateFin, cf. firestore-model §6). */
export function toParisDay(v: unknown): string | null {
  const s = String(v ?? '').trim();
  return s === '' ? null : s.slice(0, 10);
}

// --- Fonctions métier PURES -------------------------------------------------

/** Σ montant des lignes id_financeur=360 UNIQUEMENT. null si AUCUNE ligne ANDPC. */
export function sumMontantAndpc(lines: readonly FinancementLine[]): number | null {
  const andpc = lines.filter((l) => l.idFinanceur === ANDPC_ID);
  if (andpc.length === 0) return null;
  return round2(andpc.reduce((a, l) => a + l.montant, 0));
}

/**
 * Agrégation des factures ANDPC (id_opca=360) PAYÉES uniquement — une session PEUT
 * en avoir plusieurs (S11.1). Une facture sans date_paiement est IGNORÉE (elle sera
 * prise en compte plus tard, une fois payée). Aucun autre filtre (avoirs hors périmètre).
 *  - montantHt   : SOMME des montant_total_ht des factures PAYÉES (null si aucune valeur).
 *  - dateEnvoi   : la PLUS ANCIENNE date_envoi non vide des factures PAYÉES.
 *  - datePaiement: la PLUS RÉCENTE date_paiement.
 * AUCUNE facture payée (même s'il existe des non payées) → les 3 champs null.
 */
export function aggregateFacturesAndpc(factures: readonly FactureLine[]): {
  montantHt: number | null;
  dateEnvoi: string | null;
  datePaiement: string | null;
} {
  // id_opca=360 ET date_paiement renseignée (payée).
  const payees = factures.filter((f) => f.idOpca === ANDPC_ID && f.datePaiement !== null && f.datePaiement !== '');
  if (payees.length === 0) return { montantHt: null, dateEnvoi: null, datePaiement: null };

  const hts = payees.map((f) => f.montantHt).filter((m): m is number => m !== null);
  const envois = payees.map((f) => f.dateEnvoi).filter((d): d is string => d !== null && d !== '');
  const paiements = payees.map((f) => f.datePaiement).filter((d): d is string => d !== null && d !== '');

  return {
    montantHt: hts.length ? round2(hts.reduce((a, m) => a + m, 0)) : null,
    dateEnvoi: envois.length ? envois.reduce((min, d) => (d < min ? d : min)) : null, // plus ancienne (ISO → lexicographique)
    datePaiement: paiements.length ? paiements.reduce((max, d) => (d > max ? d : max)) : null, // plus récente
  };
}

/**
 * idParticipant → financeurAndpc via la chaîne prouvée :
 *   true  = ∃ financement id_financeur=360 rattaché à son id_entreprise ;
 *   false = financement(s) rattaché(s) mais aucun 360 (particulier/entreprise) ;
 *   null  = AUCUN financement rattaché (à signaler).
 * ANDPC prime : un participant mixte (360 + autre) est classé true (à relancer).
 */
export function buildFinanceurByParticipant(
  laps: readonly LapLink[],
  lines: readonly FinancementLine[],
): Map<string, boolean | null> {
  const byEntreprise = new Map<string, FinancementLine[]>();
  for (const l of lines) {
    const arr = byEntreprise.get(l.idFinance) ?? [];
    arr.push(l);
    byEntreprise.set(l.idFinance, arr);
  }
  const out = new Map<string, boolean | null>();
  for (const lap of laps) {
    if (!lap.idParticipant) continue;
    const fins = byEntreprise.get(lap.idEntreprise) ?? [];
    const val: boolean | null = fins.length === 0
      ? null
      : fins.some((f) => f.idFinanceur === ANDPC_ID);
    out.set(lap.idParticipant, val);
  }
  return out;
}

// --- I/O RÉSILIENTE : enrichissement partagé backfill + sync ----------------

function asArray<T = unknown>(json: unknown): T[] {
  if (Array.isArray(json)) return json as T[];
  if (json && typeof json === 'object' && Array.isArray((json as { data?: unknown }).data)) {
    return (json as { data: T[] }).data;
  }
  return json == null ? [] : [json as T];
}

function shortReason(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.replace(/\s+/g, ' ').slice(0, 160); // erreurs HTTP/SDK uniquement, jamais de PII
}

async function readFinancements(id: string, client: DendreoClient): Promise<FinancementLine[]> {
  try {
    const raw = asArray<Record<string, unknown>>(await client.get('financements.php', { id_action_de_formation: id }));
    return raw.map((f) => ({
      idFinance: String(f.id_finance ?? ''),
      idFinanceur: String(f.id_financeur ?? ''),
      type: String(f.type ?? ''),
      montant: parseMontant(f.montant_finance),
    }));
  } catch (err) {
    console.warn(`[enrichFinancement] financements.php KO idAdf=${id} : ${shortReason(err)}`);
    return [];
  }
}

async function readFactures(id: string, client: DendreoClient): Promise<FactureLine[]> {
  try {
    const raw = asArray<Record<string, unknown>>(await client.get('factures.php', { id_action_de_formation: id }));
    return raw.map((f) => {
      const htRaw = f.montant_total_ht;
      const ht = htRaw == null || String(htRaw).trim() === '' ? null : parseMontant(htRaw);
      return {
        idOpca: String(f.id_opca ?? ''),
        dateEnvoi: toParisDay(f.date_envoi),
        montantHt: ht,
        datePaiement: toParisDay(f.date_paiement),
        dateEmission: toParisDay(f.date_emission),
      };
    });
  } catch (err) {
    console.warn(`[enrichFinancement] factures.php KO idAdf=${id} : ${shortReason(err)}`);
    return [];
  }
}

async function readLaps(id: string, client: DendreoClient): Promise<LapLink[]> {
  try {
    const raw = asArray<Record<string, unknown>>(await client.get('laps.php', { id_action_de_formation: id }));
    return raw
      .map((l) => ({ idParticipant: String(l.id_participant ?? ''), idEntreprise: String(l.id_entreprise ?? '') }))
      .filter((x) => x.idParticipant !== '');
  } catch (err) {
    console.warn(`[enrichFinancement] laps.php KO idAdf=${id} : ${shortReason(err)}`);
    return [];
  }
}

export interface FinancementEnrichment {
  /** Champs à fusionner dans SessionUpsertInput. */
  session: {
    financeurAndpc: boolean;
    montantAndpc: number | null;
    factureDateEnvoi: string | null;
    factureMontantHt: number | null;
    factureDatePaiement: string | null;
  };
  /** idParticipant → financeurAndpc (true|false|null) pour chaque SignatureDoc. */
  financeurByParticipant: Map<string, boolean | null>;
}

/**
 * 3 lectures RÉSILIENTES (financements.php, factures.php, laps.php) + calcul pur.
 * Un échec de lecture → log SANS PII + valeurs vides : la session s'écrit TOUJOURS
 * (financeurAndpc=false, montants/dates null). On ne perd JAMAIS la session.
 */
export async function enrichFinancement(idAdf: string | number, client: DendreoClient): Promise<FinancementEnrichment> {
  const id = String(idAdf);
  const lines = await readFinancements(id, client);
  const factures = await readFactures(id, client);
  const laps = await readLaps(id, client);

  const agg = aggregateFacturesAndpc(factures);
  return {
    session: {
      financeurAndpc: lines.some((l) => l.idFinanceur === ANDPC_ID),
      montantAndpc: sumMontantAndpc(lines),
      factureDateEnvoi: agg.dateEnvoi,
      factureMontantHt: agg.montantHt,
      factureDatePaiement: agg.datePaiement,
    },
    financeurByParticipant: buildFinanceurByParticipant(laps, lines),
  };
}

// --- Validation du libellé ANDPC (une fois, mise en cache) ------------------
let andpcValidated: boolean | null = null;

/**
 * Vérifie UNE fois que financeurs.php?id=360 → raison_sociale "ANDPC" (validation
 * par le LIBELLÉ, pas seulement l'id). Résultat mis en cache. Ne bloque jamais :
 * un libellé inattendu ou une lecture KO → console.warn d'alerte clair, puis on continue.
 */
export async function ensureAndpcValidated(client: DendreoClient): Promise<boolean> {
  if (andpcValidated !== null) return andpcValidated;
  try {
    const raw = asArray<Record<string, unknown>>(await client.get('financeurs.php', { id: ANDPC_ID }));
    const o = raw[0] ?? {};
    const raison = String(o.raison_sociale ?? o.nom ?? '').trim();
    andpcValidated = /^ANDPC$/i.test(raison);
    if (!andpcValidated) {
      console.warn(`[ANDPC] ⚠ ALERTE : financeurs.php?id=${ANDPC_ID} → raison_sociale="${raison}" ≠ "ANDPC". Constante ANDPC_ID à revérifier.`);
    }
  } catch (err) {
    andpcValidated = false;
    console.warn(`[ANDPC] validation du libellé impossible (${shortReason(err)}) — poursuite avec ANDPC_ID=${ANDPC_ID}.`);
  }
  return andpcValidated;
}

/** Réinitialise le cache de validation (usage tests uniquement). */
export function __resetAndpcValidation(): void {
  andpcValidated = null;
}
