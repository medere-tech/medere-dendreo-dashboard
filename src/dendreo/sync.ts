// src/dendreo/sync.ts — Synchronisation IDEMPOTENTE d'UNE session Dendreo → miroir.
// Réutilise les fonctions existantes (client, signatures, enrich, firestore).
// Même logique que scripts/backfill.mjs (processSession) mais réutilisable côté
// serveur (webhook S8.1). LECTURE SEULE Dendreo (GET) ; écriture NOTRE Firestore.
//
// Rejouable sans doublon : clés déterministes sessions/{idAdf} +
// signatures/{idAdf}_{idParticipant}_{doctypeId}, last-write-wins.

import { loadDendreoEnv } from '../config';
import { DendreoClient } from './client';
import { getSessionSignatureStatus } from './signatures';
import {
  deriveEligibleDpc,
  deriveNumeroCompteProduit,
  eppConnecte,
  formatLabel,
  hasEpp,
  isACheval,
  parseHeures,
  type SessionModuleView,
} from './enrich';
import { enrichFinancement, ensureAndpcValidated } from './financement';
import { recalcSessionCounts, upsertSession, upsertSignature } from '../firebase/firestore';
import type { SessionUpsertInput } from '../firebase/types';
import type { AttestationLine } from './types';

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

async function etapeLabel(client: DendreoClient, idEtape: string): Promise<string> {
  if (!idEtape) return 'etape_?';
  try {
    const json = await client.get<unknown>('etapes.php');
    for (const e of asArray<Record<string, unknown>>(json)) {
      const id = String(e.id_etape_process ?? e.id ?? '');
      if (id === idEtape) return String(e.intitule ?? e.nom ?? `etape_${idEtape}`);
    }
  } catch {
    /* non bloquant : on retombe sur un libellé neutre */
  }
  return `etape_${idEtape}`;
}

async function fetchModules(client: DendreoClient, idAdf: string): Promise<SessionModuleView[]> {
  const lams = asArray<Record<string, unknown>>(
    await client.get('lams.php', { id_action_de_formation: idAdf, include: 'module' }),
  );
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

function mapSignature(a: AttestationLine, session: SessionUpsertInput, financeurAndpc: boolean | null) {
  return {
    idAdf: session.idAdf,
    idParticipant: String(a.idParticipant),
    doctypeId: String(a.doctypeId),
    documentName: a.documentName,
    nom: a.nom && a.nom.trim() ? a.nom : '—',
    status: a.status,
    signatureDate: a.signatureDate ?? null,
    sentDate: a.sentDate ?? null,
    viewerUrl: a.viewerUrl ?? null,
    financeurAndpc, // S11.1 : chaîne idParticipant → id_entreprise → financeur
    sessionNumeroComplet: session.numeroComplet,
    sessionIntitule: session.intitule,
    sessionDateDebut: session.dateDebut,
  };
}

export interface SyncResult {
  idAdf: string;
  found: boolean; // la session existe côté Dendreo
  attestations: number; // lignes upsertées
}

/**
 * Re-fetch d'UNE session (ADF + modules + fichiers signature) et upsert idempotent
 * (session + signatures + recalcSessionCounts). `client` injectable pour les tests.
 */
export async function syncSession(idAdf: string, client: DendreoClient = new DendreoClient(loadDendreoEnv())): Promise<SyncResult> {
  const id = String(idAdf);

  const adf = asArray<Record<string, unknown>>(
    await client.get('actions_de_formation.php', { id, fields: SESSION_FIELDS }),
  )[0];
  if (!adf) return { idAdf: id, found: false, attestations: 0 };

  const idEtape = String(adf.id_etape_process ?? '');
  const dateDebut = normDate(adf.date_debut);
  const dateFin = normDate(adf.date_fin);
  const modules = await fetchModules(client, id);

  // S11.1 : enrichissement financements/factures (résilient) — MÊME fonction que le backfill.
  await ensureAndpcValidated(client);
  const fin = await enrichFinancement(id, client);

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
    aCheval: isACheval(dateDebut, dateFin),
    eppAmontConnecte: eppConnecte(modules, 'amont'),
    eppAvalConnecte: eppConnecte(modules, 'aval'),
    eligibleDpc: deriveEligibleDpc(modules),
    aEpp: hasEpp(modules),
    ...fin.session,
  };

  const status = await getSessionSignatureStatus(id, client); // fichiers.php + règle attestation
  await upsertSession(session);
  for (const a of status.attestations) {
    await upsertSignature(mapSignature(a, session, fin.financeurByParticipant.get(String(a.idParticipant)) ?? null));
  }
  await recalcSessionCounts(id);

  return { idAdf: id, found: true, attestations: status.attestations.length };
}
