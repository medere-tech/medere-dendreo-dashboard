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

// --- S12.1 (corrigé) : dates des séances SYNCHRONES (créneaux datés) ----------
// Prouvé en S12.0 : lams.php?include=creneaux greffe les créneaux sur chaque LAM ;
// un créneau porte `day` = jour Paris NAÏF "AAAA-MM-JJ" (Cas A, cf. firestore-model §6).
//
// ⚠ RÈGLE AU NIVEAU SESSION (pas module). La 1re version filtrait sur le mode du LAM
// (`elearning_sync`), ce qui RATAIT des dates : preuve réelle idAdf 3586 (session
// PRÉSENTIEL) qui a 3 séances datées mais renvoyait []. Le mode du LAM n'est PAS fiable
// pour repérer une séance datée. La bonne clé est le `mode_organisation` de la SESSION :
//   - session `mixte` OU `elearning_sync` (= Classe virtuelle) → on prend TOUS les jours
//     des créneaux datés de la session (tous les LAM, sans filtrer le mode du module) ;
//   - sinon (`presentiel`, `elearning_async`, autre) → [].

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Formats de SESSION (mode_organisation ADF) qui portent des séances synchrones datées. */
const SYNC_SESSION_MODES = new Set(['mixte', 'elearning_sync']);

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
 * Règle NIVEAU SESSION : si `sessionMode` ∈ {mixte, elearning_sync}, on collecte le
 * `day` de TOUT créneau daté valide (tous les LAM, quel que soit le mode du module),
 * DÉDUPLIQUE par jour et TRIE croissant ; sinon (présentiel/async/autre) → []. PURE.
 * @param sessionMode `mode_organisation` de l'ADF (niveau session), pas du module.
 */
export function extractDatesSynchrones(lams: readonly unknown[], sessionMode: string | null | undefined): string[] {
  if (!SYNC_SESSION_MODES.has(String(sessionMode ?? '').trim())) return [];
  const days = new Set<string>();
  for (const lam of lams) {
    if (!lam || typeof lam !== 'object') continue;
    for (const c of creneauxOf(lam as Record<string, unknown>)) {
      const day = String(c.day ?? '').trim();
      if (ISO_DAY.test(day)) days.add(day);
    }
  }
  return [...days].sort();
}

// --- S18 : facturable au titre de l'ANNÉE N (sessions à cheval) ---------------
// RÈGLE FIGÉE (prouvée sur la recon 3818) :
//   facturableAnneeN = true SSI TOUS les modules dont `id_categorie_module != 21`
//   ont leur `date_fin` PASSÉE (strictement < aujourd'hui, comparaison au JOUR Paris).
//
// ⚠ La catégorie du CŒUR n'est PAS stable (13, 3, 15…) : on ne liste JAMAIS les
// catégories cœur. La seule borne fiable est l'aval = 21. Donc « année N » se définit
// par la NÉGATIVE : tout ce qui n'est pas 21.
//
// ⚠ DEUX NIVEAUX DIFFÉRENTS, à ne pas confondre :
//   - `id_categorie_module` vit sur le MODULE INCLUS (`lam.module`) — c'est déjà ce que
//     lit `toModuleViews` en prod (sync.ts / backfill.mjs) ;
//   - `date_fin` vit sur le LAM (3818 : lam 8087 amont → 2026-07-08, 8088 cœur →
//     2026-07-08, 8089 aval → 2027-01-15).
// Chacun garde un repli sur l'autre niveau : coût nul, robustesse en plus.
//
// Dates = jour « mur » NAÏF (cas A de firestore-model.md §6) → `slice(0,10)` puis
// comparaison lexicographique de deux "AAAA-MM-JJ". JAMAIS de `new Date()` ici :
// ce serait interpréter une date naïve en UTC et décaler d'un jour.
//
// JAMAIS `true` par défaut : chaque module non-aval doit PROUVER que sa date est passée.
// Date illisible, absente, `today` invalide, aucun module, ou que des modules aval → false.

/** Première valeur non vide parmi les candidats, trimée. '' si toutes absentes/vides. */
function premiereNonVide(...candidats: readonly unknown[]): string {
  for (const c of candidats) {
    const s = String(c ?? '').trim();
    if (s !== '') return s;
  }
  return '';
}

/** Objet `module` greffé sur un LAM (`include=module`), ou null. */
function moduleOf(lam: Record<string, unknown>): Record<string, unknown> | null {
  const m = lam.module;
  return m && typeof m === 'object' ? (m as Record<string, unknown>) : null;
}

/** Catégorie d'un LAM : MODULE inclus d'abord (source de prod), repli niveau LAM. */
function categorieOf(lam: Record<string, unknown>): string {
  const m = moduleOf(lam);
  return premiereNonVide(m ? m.id_categorie_module : undefined, lam.id_categorie_module);
}

/** Jour de fin d'un LAM : LAM d'abord (prouvé 3818), repli module. '' si illisible. */
function dateFinJourOf(lam: Record<string, unknown>): string {
  const m = moduleOf(lam);
  const jour = premiereNonVide(lam.date_fin, m ? m.date_fin : undefined).slice(0, 10);
  return ISO_DAY.test(jour) ? jour : '';
}

/**
 * La session est-elle facturable au titre de l'année N (cf. bloc ci-dessus) ?
 * PURE : `today` ("AAAA-MM-JJ", jour Paris) est INJECTÉ → déterministe.
 * Borne STRICTE : un module qui finit AUJOURD'HUI n'est pas passé (facturable demain).
 * @param lams LAM bruts de `lams.php?include=module,creneaux` (déjà lus — 0 appel ajouté).
 */
export function computeFacturableAnneeN(lams: readonly unknown[], today: string): boolean {
  if (!ISO_DAY.test(String(today ?? '').trim())) return false; // jour de référence illisible → prudent
  const anneeN: Record<string, unknown>[] = [];
  for (const lam of lams) {
    if (!lam || typeof lam !== 'object') continue;
    const l = lam as Record<string, unknown>;
    // Catégorie absente/illisible → NON classée aval → compte en année N (sens prudent :
    // sa date devra être passée). Un LAM sans objet `module` compte donc lui aussi.
    if (categorieOf(l) === EPP_AVAL_CAT) continue;
    anneeN.push(l);
  }
  if (anneeN.length === 0) return false; // que de l'aval (ou aucun module) → rien à facturer en N
  return anneeN.every((l) => {
    const jour = dateFinJourOf(l);
    return jour !== '' && jour < today; // '' (illisible) → false, jamais d'optimisme
  });
}
