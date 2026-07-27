// src/dendreo/enrich.ts — Dérivations PURES d'enrichissement SessionDoc (S5.1b).
// Mappings prouvés en S5.0 (docs/recon-s5-findings.md). Aucune I/O → testable seul.

/** Vue minimale d'un module de session pour les dérivations (issue de lams.php?include=module). */
export interface SessionModuleView {
  categorie: string; // id_categorie_module (string). EPP amont=22, aval=21.
  heuresConnectees: number; // c_nombre_dheures_connectees (>= 0)
  numProgrammeDpc: string; // num_programme_dpc (11 chiffres) ; '' si absent
  eligibleDpc: string; // eligible_dpc brut ("1" = éligible, "0" = non)
}

export const EPP_AMONT_CAT = '22';
export const EPP_AVAL_CAT = '21';

/** mode_organisation (niveau session) → libellé Format (S5.0 §1). */
export const FORMAT_LABELS: Record<string, string> = {
  presentiel: 'Présentiel',
  mixte: 'Mixte',
  elearning_async: 'E-learning',
  elearning_sync: 'Classe virtuelle',
};

/** Libellé Format. Valeur inconnue → renvoyée telle quelle (jamais perdue) ; vide → ''. */
export function formatLabel(modeOrganisation: string | null | undefined): string {
  const raw = String(modeOrganisation ?? '').trim();
  return FORMAT_LABELS[raw] ?? raw;
}

/** Session à cheval = année(dateDebut) ≠ année(dateFin). Dates ISO naïves "YYYY-...". */
export function isACheval(dateDebut: string | null | undefined, dateFin: string | null | undefined): boolean {
  const y1 = String(dateDebut ?? '').slice(0, 4);
  const y2 = String(dateFin ?? '').slice(0, 4);
  if (y1.length < 4 || y2.length < 4) return false; // année indéterminée → prudent
  return y1 !== y2;
}

/** Parse d'heures Dendreo (gère '', null, virgule décimale). Renvoie 0 si non fini. */
export function parseHeures(v: unknown): number {
  const n = parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

/** EPP amont/aval connecté = ∃ module de la catégorie visée AVEC heures connectées > 0. */
export function eppConnecte(modules: readonly SessionModuleView[], sens: 'amont' | 'aval'): boolean {
  const cat = sens === 'amont' ? EPP_AMONT_CAT : EPP_AVAL_CAT;
  return modules.some((m) => m.categorie === cat && m.heuresConnectees > 0);
}

/** Présence d'AU MOINS UN module EPP (amont OU aval) dans la session. */
export function hasEpp(modules: readonly SessionModuleView[]): boolean {
  return modules.some((m) => m.categorie === EPP_AMONT_CAT || m.categorie === EPP_AVAL_CAT);
}

/**
 * Éligible DPC (S6.2) : `eligible_dpc === "1"` du module CŒUR (catégorie ∉ {21,22},
 * même module que le n° compte produit). À défaut de cœur : 1er module ; sinon false.
 */
export function deriveEligibleDpc(modules: readonly SessionModuleView[]): boolean {
  const core = modules.find((m) => m.categorie !== EPP_AMONT_CAT && m.categorie !== EPP_AVAL_CAT);
  const ref = core ?? modules[0];
  return String(ref?.eligibleDpc ?? '').trim() === '1';
}

/**
 * N° compte produit (S5.0 §2) :
 *  - si l'ADF a `numero_comptable` → on le garde ;
 *  - sinon → `num_programme_dpc` du module CŒUR (catégorie ∉ {21,22}) ;
 *  - repli ultime : le 1er module portant un num ; sinon null.
 * Sessions composées : les modules cœur partagent le num en pratique → 1er cœur suffit.
 */
export function deriveNumeroCompteProduit(
  adfNumeroComptable: string | null | undefined,
  modules: readonly SessionModuleView[],
): string | null {
  const adf = String(adfNumeroComptable ?? '').trim();
  if (adf) return adf;
  const core = modules.find(
    (m) => m.categorie !== EPP_AMONT_CAT && m.categorie !== EPP_AVAL_CAT && m.numProgrammeDpc.trim() !== '',
  );
  if (core) return core.numProgrammeDpc.trim();
  const any = modules.find((m) => m.numProgrammeDpc.trim() !== '');
  return any ? any.numProgrammeDpc.trim() : null;
}

// --- S12.1 : dates des séances SYNCHRONES (créneaux datés) -------------------
// Prouvé en S12.0 : lams.php?include=creneaux greffe les créneaux sur chaque LAM ;
// un créneau porte `day` = jour Paris NAÏF "AAAA-MM-JJ" (Cas A, cf. firestore-model §6).
// Un LAM `elearning_sync` = séance datée à distance ; un LAM `elearning_async` n'a
// aucun créneau daté (module e-learning asynchrone).

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const SYNC_MODE = 'elearning_sync';

/** Créneaux greffés sur un LAM (tolère `creneaux` array/objet unique + `creneau` singulier). */
function creneauxOf(lam: Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const key of ['creneaux', 'creneau'] as const) {
    const v = lam[key];
    if (Array.isArray(v)) {
      for (const c of v) if (c && typeof c === 'object') out.push(c as Record<string, unknown>);
    } else if (v && typeof v === 'object') {
      out.push(v as Record<string, unknown>);
    }
  }
  return out;
}

/**
 * Jours des séances SYNCHRONES d'une session, depuis les LAM DÉJÀ lus
 * (`lams.php?include=module,creneaux` — aucune lecture Dendreo supplémentaire).
 * Ne garde que les créneaux des LAM `mode_organisation === 'elearning_sync'` ;
 * collecte les `day` (jour ISO "AAAA-MM-JJ"), DÉDUPLIQUE par jour, TRIE croissant.
 * On COLLECTE LES FAITS ici : aucun filtrage sur le format de session (le filtrage
 * CV/Mixte pour l'affichage se fera à l'export, cf. S12.2). PURE, sans I/O.
 */
export function extractDatesSynchrones(lams: readonly unknown[]): string[] {
  const days = new Set<string>();
  for (const lam of lams) {
    if (!lam || typeof lam !== 'object') continue;
    const l = lam as Record<string, unknown>;
    if (String(l.mode_organisation ?? '').trim() !== SYNC_MODE) continue;
    for (const c of creneauxOf(l)) {
      const day = String(c.day ?? '').trim();
      if (ISO_DAY.test(day)) days.add(day);
    }
  }
  return [...days].sort();
}
