// src/dendreo/sync.ts — Synchronisation IDEMPOTENTE d'UNE session Dendreo → miroir.
// Réutilise les fonctions existantes (client, signatures, enrich, firestore).
// Même logique que scripts/backfill.mjs (processSession) mais réutilisable côté
// serveur (webhook S8.1). LECTURE SEULE Dendreo (GET) ; écriture NOTRE Firestore.
//
// Rejouable sans doublon : clés déterministes sessions/{idAdf} +
// signatures/{idAdf}_{idParticipant}_{doctypeId}, last-write-wins.

import { loadDendreoEnv } from '../config';
import { classifyAttestationBloc } from '../core/attestation-name';
import { DendreoClient } from './client';
import { getSessionSignatureStatus } from './signatures';
import {
  deriveEligibleDpc,
  deriveNumeroCompteProduit,
  eppConnecte,
  extractDatesSynchrones,
  formatLabel,
  hasEpp,
  isACheval,
  parseHeures,
  type SessionModuleView,
} from './enrich';
import { enrichFinancement, ensureAndpcValidated, loadCommerciauxReferentiel, type ParcoursFlags } from './financement';
import { listSessionSignatureMirror, recalcSessionCounts, upsertSession, upsertSignature } from '../firebase/firestore';
import type { SessionUpsertInput } from '../firebase/types';
import type { AttestationLine, SessionSignatureStatus } from './types';

const SESSION_FIELDS = [
  'id_action_de_formation', 'numero_complet', 'intitule', 'date_debut', 'date_fin',
  'id_etape_process', 'total_participants', 'id_centre_de_formation', 'type',
  'num_session_dpc', 'numero_comptable', 'mode_organisation',
].join(',');

function asArray<T = unknown>(json: unknown): T[] {
  if (Array.isArray(json)) return json as T[];
  if (json && typeof json === 'object' && Array.isArray((json as { data?: unknown }).data)) {
    return (json as { data: T[] }).data;
  }
  return json == null ? [] : [json as T];
}

/** ISO naïf : espace -> "T" ; vide/absent -> '' (jamais null → session s'écrit toujours). */
function normDate(v: unknown): string {
  if (v === null || v === undefined || String(v).trim() === '') return '';
  const s = String(v);
  return s.includes(' ') ? s.replace(' ', 'T') : s;
}

function nullableTrim(v: unknown): string | null {
  const s = v == null ? '' : String(v).trim();
  return s === '' ? null : s;
}

// --- Référentiel des étapes (S14.2 ; une lecture, mise en cache) -------------
let etapesCache: Map<string, string> | null = null;

/**
 * Référentiel des étapes : `etapes.php` lu UNE seule fois par exécution → Map
 * <id_etape_process, libellé>. Même pattern que `loadCommerciauxReferentiel` /
 * `ensureAndpcValidated` (cache module). Le référentiel des étapes ne bouge quasiment
 * jamais ; le relire à chaque session coûtait 1 appel Dendreo par syncSession (webhook
 * ET scripts) pour une valeur identique.
 *
 * RÉSILIENCE : on ne met en cache QUE le succès. Une lecture KO renvoie une Map vide
 * SANS la mémoriser → la session suivante retentera, exactement comme avant ce cache
 * (aucune régression : un incident passager ne fige pas les libellés de tout le process).
 */
async function loadEtapesReferentiel(client: DendreoClient): Promise<Map<string, string>> {
  if (etapesCache !== null) return etapesCache;
  const map = new Map<string, string>();
  try {
    const json = await client.get<unknown>('etapes.php');
    for (const e of asArray<Record<string, unknown>>(json)) {
      const id = String(e.id_etape_process ?? e.id ?? '');
      if (id) map.set(id, String(e.intitule ?? e.nom ?? `etape_${id}`));
    }
  } catch {
    return map; // NON mis en cache : on retentera à la prochaine session (comportement d'avant)
  }
  etapesCache = map;
  return etapesCache;
}

/** Libellé d'étape, depuis le référentiel en cache. Libellés STRICTEMENT identiques à
 *  avant : id vide → "etape_?" ; id inconnu du référentiel ou lecture KO → "etape_{id}". */
async function etapeLabel(client: DendreoClient, idEtape: string): Promise<string> {
  if (!idEtape) return 'etape_?';
  const referentiel = await loadEtapesReferentiel(client);
  return referentiel.get(idEtape) ?? `etape_${idEtape}`;
}

/** Réinitialise le cache du référentiel étapes (usage tests uniquement). */
export function __resetEtapesReferentiel(): void {
  etapesCache = null;
}

/** LAM d'une session : 1 lecture — `include=module,creneaux` porte modules ET créneaux
 *  synchrones (S12.1). Aucune lecture Dendreo supplémentaire par rapport à avant. */
async function fetchLams(client: DendreoClient, idAdf: string): Promise<Record<string, unknown>[]> {
  return asArray<Record<string, unknown>>(
    await client.get('lams.php', { id_action_de_formation: idAdf, include: 'module,creneaux' }),
  );
}

/** Vue modules (dédupliquée par id_module) pour les dérivations EPP/DPC/compte produit. */
function toModuleViews(lams: readonly Record<string, unknown>[]): SessionModuleView[] {
  const out: SessionModuleView[] = [];
  const seen = new Set<string>();
  for (const l of lams) {
    const m = l.module as Record<string, unknown> | undefined;
    const idModule = m && m.id_module != null ? String(m.id_module) : '';
    if (!m || !idModule || seen.has(idModule)) continue;
    seen.add(idModule);
    out.push({
      categorie: String(m.id_categorie_module ?? ''),
      heuresConnectees: parseHeures(m.c_nombre_dheures_connectees),
      numProgrammeDpc: String(m.num_programme_dpc ?? '').trim(),
      eligibleDpc: String(m.eligible_dpc ?? '').trim(),
    });
  }
  return out;
}

function mapSignature(
  a: AttestationLine,
  session: SessionUpsertInput,
  financeurAndpc: boolean | null,
  commercial: string | null,
  parcours: ParcoursFlags | undefined,
) {
  return {
    idAdf: session.idAdf,
    idParticipant: String(a.idParticipant),
    doctypeId: String(a.doctypeId),
    documentName: a.documentName,
    bloc: classifyAttestationBloc(a.documentName), // S18 : amont/cœur/aval par le NOM (0 appel Dendreo)
    nom: a.nom && a.nom.trim() ? a.nom : '—',
    status: a.status,
    signatureDate: a.signatureDate ?? null,
    sentDate: a.sentDate ?? null,
    viewerUrl: a.viewerUrl ?? null,
    financeurAndpc, // S11.1 : chaîne idParticipant → id_entreprise → financeur
    commercial, // S13.1 : "Prénom NOM" du commercial de l'inscription (laps.commercial_id résolu)
    assidu: parcours ? parcours.assidu : null, // S14 : laps absent/KO → null (inconnu), jamais false
    inscrit: parcours ? parcours.inscrit : null, // S14 : idem
    sessionNumeroComplet: session.numeroComplet,
    sessionIntitule: session.intitule,
    sessionDateDebut: session.dateDebut,
  };
}

// =============================================================================
// S17.4 — PURGE DES FANTÔMES (intégrée au sync)
// =============================================================================
// Un « fantôme » = une ligne du miroir `signatures` qui n'existe plus côté Dendreo.
// Sans purge, elle reste comptée `pending` pour toujours → le cockpit affiche des
// relances qui n'existent pas. Cf. docs/signature-rule.md §6.
//
// ┌── CRITÈRE DE SUPPRESSION (identique à scripts/purge-fantomes.mjs, prouvé S17.3) ──┐
// │ Supprimer signatures/{idAdf}_{idParticipant}_{doctypeId} SI ET SEULEMENT SI :     │
// │   (1) la clé est ABSENTE de la réponse fichiers.php du sync EN COURS, ET          │
// │   (2) le status au miroir === 'pending'.                                          │
// │ JAMAIS un 'signed' absent : une attestation signée est une PREUVE DE CONFORMITÉ.  │
// │ Disparue de la source, c'est une ANOMALIE à signaler — jamais à effacer.          │
// └───────────────────────────────────────────────────────────────────────────────────┘
//
// GARDE-FOUS (le cron tourne SANS SURVEILLANCE — une suppression est irréversible) :
//  Le sync ne purge QUE sur une réponse Dendreo jugée FIABLE. Tout doute → SKIP total
//  de la purge sur cette session (0 suppression), log de la raison, et le sync
//  CONTINUE normalement (il écrit ce qu'il a récupéré). Cas de skip :
//    a. réponse VIDE alors que le miroir a des docs        (hoquet API probable)
//    b. réponse < 50 % des docs du miroir                  (réponse partielle probable)
//    c. lignes non clefables (doctype_id vide) dans la réponse : des clés Dendreo
//       manquent à l'appel → un vrai document ressemblerait à un fantôme
//    d. miroir illisible / erreur Firestore
//  Appel Dendreo KO (HTTP != 200) : `getSessionSignatureStatus` lève AVANT tout écrit,
//  donc syncSession s'interrompt comme aujourd'hui — la purge n'est jamais atteinte.
//
// COÛT : ZÉRO appel Dendreo ajouté (on réutilise la réponse fichiers.php déjà
// récupérée par le sync). Côté Firestore : +1 requête (miroir de la session) et
// N suppressions, uniquement quand la purge est activée.
//
// LOGS — SANS PII (S17.4b). Ces lignes finissent dans les journaux GitHub Actions,
// conservés 90 jours et lisibles par tout collaborateur du dépôt. On ne logge donc
// NI le nom du participant, NI le nom du document : uniquement idAdf, la clé
// {idAdf}_{idParticipant}_{doctypeId}, le doctype et le status. La clé suffit à
// retrouver le participant dans Dendreo en cas d'audit.

/** Réponse Dendreo < 50 % du miroir → réponse partielle probable → aucune suppression. */
const PURGE_RATIO_SUSPECT = 0.5;

/** Message d'erreur compact et sans PII (ce sont des erreurs HTTP/SDK). */
function shortReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/\s+/g, ' ').slice(0, 160);
}

export interface PurgeOutcome {
  /** Fantômes pending réellement supprimés. */
  purged: number;
  /** Attestations SIGNÉES absentes de Dendreo : anomalies loggées, JAMAIS supprimées. */
  signedMissing: number;
  /** Raison du skip (réponse douteuse) ; `null` si la purge s'est exécutée. */
  skipped: string | null;
}

const NO_PURGE: PurgeOutcome = { purged: 0, signedMissing: 0, skipped: null };

/**
 * Purge les fantômes `pending` d'UNE session, à partir du statut d'attestations
 * DÉJÀ récupéré par le sync (aucun appel Dendreo supplémentaire).
 *
 * Ne lève JAMAIS : toute erreur est capturée et convertie en skip. La purge est un
 * nettoyage opportuniste, elle ne doit pas pouvoir faire échouer un sync.
 */
export async function purgeGhostSignatures(idAdf: string, status: SessionSignatureStatus): Promise<PurgeOutcome> {
  const id = String(idAdf);
  const skip = (raison: string): PurgeOutcome => {
    console.log(`[PURGE SKIP] idAdf=${id} — ${raison} (aucune suppression)`);
    return { purged: 0, signedMissing: 0, skipped: raison };
  };

  let mirror;
  try {
    mirror = await listSessionSignatureMirror(id);
  } catch (err) {
    return skip(`miroir illisible : ${shortReason(err)}`); // (d)
  }
  if (mirror.length === 0) return NO_PURGE; // rien au miroir → rien à purger

  const att = status.attestations;
  if (att.length === 0) return skip('réponse Dendreo VIDE alors que le miroir a des docs'); // (a)
  if (att.length < mirror.length * PURGE_RATIO_SUSPECT) {
    return skip(`réponse partielle probable : ${att.length} attestation(s) Dendreo vs ${mirror.length} au miroir (< ${PURGE_RATIO_SUSPECT * 100} %)`); // (b)
  }
  if (status.ignored > 0) {
    return skip(`${status.ignored} ligne(s) Dendreo sans doctype_id : jeu de clés incomplet`); // (c)
  }

  const clesDendreo = new Set(att.map((a) => `${a.idParticipant}_${a.doctypeId}`));
  const absentes = mirror.filter((m) => !clesDendreo.has(`${m.idParticipant}_${m.doctypeId}`));

  // Anomalies : signalées, JAMAIS touchées.
  const signedMissing = absentes.filter((m) => m.status !== 'pending');
  for (const s of signedMissing) {
    console.log(`[PURGE ANOMALIE — NON SUPPRIMÉE] idAdf=${id} clé=${s.key} | doctype=${s.doctypeId || '—'} | status=${s.status || '—'}`);
  }

  let purged = 0;
  for (const g of absentes.filter((m) => m.status === 'pending')) {
    // Ceinture et bretelles : le critère est re-vérifié sur CE doc juste avant d'agir.
    if (g.status !== 'pending' || clesDendreo.has(`${g.idParticipant}_${g.doctypeId}`)) continue;
    const trace = `idAdf=${id} clé=${g.key} | doctype=${g.doctypeId || '—'} | status=pending`;
    try {
      await g.delete();
      purged += 1;
      console.log(`[PURGE SUPPRIMÉ] ${trace}`);
    } catch (err) {
      // Une suppression KO n'abat ni la purge des autres, ni le sync.
      console.log(`[PURGE ÉCHEC] ${trace} → ${shortReason(err)}`);
    }
  }

  return { purged, signedMissing: signedMissing.length, skipped: null };
}

export interface SyncOptions {
  /**
   * S17.4 — Purge des fantômes pending disparus de Dendreo.
   * `false` PAR DÉFAUT : seul le chemin CRON (réconciliation nocturne) l'active.
   * Le webhook, déclenché par un événement isolé, ne purge JAMAIS.
   */
  purge?: boolean;
}

export interface SyncResult {
  idAdf: string;
  found: boolean; // la session existe côté Dendreo
  attestations: number; // lignes upsertées
  purged: number; // S17.4 : fantômes pending supprimés (0 si purge inactive ou skip)
  signedMissing: number; // S17.4 : signées absentes de Dendreo (anomalies, jamais supprimées)
  purgeSkipped: string | null; // S17.4 : raison du skip de la purge, sinon null
}

/**
 * Re-fetch d'UNE session (ADF + modules + fichiers signature) et upsert idempotent
 * (session + signatures + purge optionnelle + recalcSessionCounts).
 * `client` injectable pour les tests ; `options.purge` réservé au cron (cf. SyncOptions).
 */
export async function syncSession(
  idAdf: string,
  client: DendreoClient = new DendreoClient(loadDendreoEnv()),
  options: SyncOptions = {},
): Promise<SyncResult> {
  const id = String(idAdf);

  const adf = asArray<Record<string, unknown>>(
    await client.get('actions_de_formation.php', { id, fields: SESSION_FIELDS }),
  )[0];
  if (!adf) return { idAdf: id, found: false, attestations: 0, purged: 0, signedMissing: 0, purgeSkipped: null };

  const idEtape = String(adf.id_etape_process ?? '');
  const dateDebut = normDate(adf.date_debut);
  const dateFin = normDate(adf.date_fin);
  const lams = await fetchLams(client, id);
  const modules = toModuleViews(lams);

  // S15 : calculé AVANT l'enrichissement — le split facture 1/2 en dépend (0 lecture ajoutée).
  const aCheval = isACheval(dateDebut, dateFin);

  // S11.1 : enrichissement financements/factures (résilient) — MÊME fonction que le backfill.
  await ensureAndpcValidated(client);
  const fin = await enrichFinancement(id, client, aCheval);
  // S13.1 : référentiel commerciaux chargé une fois (cache module, comme ANDPC).
  const commerciaux = await loadCommerciauxReferentiel(client);

  const session: SessionUpsertInput = {
    idAdf: id,
    numeroComplet: String(adf.numero_complet ?? `ADF_${id}`),
    numeroSessionDpc: nullableTrim(adf.num_session_dpc),
    numeroCompteProduit: deriveNumeroCompteProduit(nullableTrim(adf.numero_comptable), modules),
    intitule: String(adf.intitule ?? '(sans intitulé)'),
    dateDebut,
    dateFin,
    idEtapeProcess: idEtape,
    etape: await etapeLabel(client, idEtape),
    idCentre: String(adf.id_centre_de_formation ?? ''),
    type: String(adf.type ?? ''),
    totalParticipants: Number(adf.total_participants ?? 0) || 0,
    format: formatLabel(adf.mode_organisation as string | undefined),
    aCheval,
    eppAmontConnecte: eppConnecte(modules, 'amont'),
    eppAvalConnecte: eppConnecte(modules, 'aval'),
    eligibleDpc: deriveEligibleDpc(modules),
    aEpp: hasEpp(modules),
    datesSynchrones: extractDatesSynchrones(lams, adf.mode_organisation as string | undefined), // S12.1 : règle niveau session
    ...fin.session,
  };

  const status = await getSessionSignatureStatus(id, client); // fichiers.php + règle attestation
  await upsertSession(session);
  for (const a of status.attestations) {
    const idp = String(a.idParticipant);
    const commercialId = fin.commercialIdByParticipant.get(idp);
    const commercial = commercialId ? commerciaux.get(commercialId) ?? null : null;
    await upsertSignature(
      mapSignature(a, session, fin.financeurByParticipant.get(idp) ?? null, commercial, fin.parcoursByParticipant.get(idp)),
    );
  }

  // S17.4 — Purge des fantômes. APRÈS les upserts (le miroir contient déjà ce que
  // Dendreo vient de renvoyer), AVANT recalcSessionCounts (les compteurs du cockpit
  // sont donc calculés sur un miroir DÉJÀ nettoyé, en une seule passe).
  // Réutilise `status` : ZÉRO appel Dendreo ajouté.
  const purge = options.purge === true ? await purgeGhostSignatures(id, status) : NO_PURGE;

  await recalcSessionCounts(id);

  return {
    idAdf: id,
    found: true,
    attestations: status.attestations.length,
    purged: purge.purged,
    signedMissing: purge.signedMissing,
    purgeSkipped: purge.skipped,
  };
}
