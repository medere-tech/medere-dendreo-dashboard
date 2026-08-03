// scripts/sync-cheval.mjs — S14.1 : re-synchronisation CIBLÉE des sessions de la liste Loane.
// -----------------------------------------------------------------------------
// POURQUOI : le filtre S14 de l'onglet "À cheval 25/26" exige `assidu`/`inscrit` au
// miroir. Les docs signatures écrits avant S14 ne les portent pas → l'onglet sort VIDE.
// Un backfill COMPLET coûterait des centaines d'appels Dendreo ; le quota est à ~96 %.
// Ce script ne re-synchronise QUE les sessions listées ci-dessous (≈6 appels chacune).
//
// Réutilise syncSession() — la MÊME fonction que le webhook, aucune logique dupliquée :
// re-fetch ADF + lams + financements + factures + laps + fichiers, puis ré-upsert la
// session et TOUTES ses signatures avec assidu/inscrit/commercial/financeurAndpc.
//
// LECTURE SEULE Dendreo (GET). Écriture NOTRE Firestore uniquement. Idempotent
// (clés déterministes, merge) → relançable sans doublon.
// Logs : idAdf + compteurs UNIQUEMENT, jamais de PII (aucun nom de participant).
//
// Usage (PowerShell) :
//   node --import tsx scripts/sync-cheval.mjs              → traite tout
//   node --import tsx scripts/sync-cheval.mjs --dry-run    → n'écrit RIEN, liste seulement
//   node --import tsx scripts/sync-cheval.mjs --from 3196  → reprend à partir de cet idAdf
// -----------------------------------------------------------------------------

import { syncSession } from '../src/dendreo/sync';

// --- Liste Loane (une ligne par personne → DOUBLONS attendus, dédupliqués ici) ----
const IDADFS = [
  2735, 2889, 3094, 3095, 3117, 3129, 3173, 3178, 3181, 3182, 3185, 3196, 3207, 3216, 3236,
  3261, 3262, 3265, 3268, 3273, 3276, 3279, 3286, 3289, 3292, 3293, 3297, 3304, 3317, 3330,
  3342, 3344, 3346, 3347, 3355, 3358, 3360, 3369, 3373, 3388, 3403, 3404, 3415, 3417, 3434,
  3451, 3458,
];

/**
 * Appels Dendreo par session — COMPTÉS dans syncSession(), pas estimés au doigt mouillé :
 *   actions_de_formation.php, lams.php, financements.php, factures.php, laps.php,
 *   fichiers.php  → 6 par session.
 * Les 3 RÉFÉRENTIELS (financeurs.php, administrateurs.php, etapes.php — ce dernier mis
 * en cache en S14.2) ne coûtent qu'1 appel chacun sur TOUTE l'exécution.
 */
const APPELS_PAR_SESSION = 6;
const APPELS_INITIAUX = 3; // financeurs.php + administrateurs.php + etapes.php (mis en cache ensuite)

// --- helpers (copiés de backfill.mjs pour rester autonomes et cohérents) ------
const log = (...m) => console.log(...m); // ids & compteurs uniquement, jamais de PII

function shortReason(err) {
  const msg = err && err.message ? String(err.message) : String(err);
  return msg.replace(/\s+/g, ' ').slice(0, 200); // erreurs HTTP/SDK, jamais de PII
}

/** Quota FIRESTORE : code gRPC 8 = RESOURCE_EXHAUSTED (même détection que backfill.mjs). */
function isQuotaError(err) {
  const code = err && err.code;
  const msg = String((err && err.message) || '');
  return code === 8 || /RESOURCE_EXHAUSTED|Quota exceeded/i.test(msg);
}

/** Quota DENDREO : 429 épuisé après les retries du client (DendreoError.status===429).
 *  À 96 % de quota, continuer après un 429 ne ferait qu'aggraver — on s'arrête aussi. */
function isDendreoQuotaError(err) {
  return (err && err.status === 429) || /HTTP 429/.test(String((err && err.message) || ''));
}

function parseArgs(argv) {
  const out = { dryRun: false, from: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') out.dryRun = true;
    else if (argv[i] === '--from') out.from = String(argv[i + 1] ?? '').trim();
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Dédup en PRÉSERVANT l'ordre croissant → progression lisible et reprise facile.
  let cibles = [...new Set(IDADFS.map((n) => String(n)))].sort((a, b) => Number(a) - Number(b));
  const doublons = IDADFS.length - cibles.length;

  if (args.from) {
    const i = cibles.indexOf(args.from);
    if (i === -1) {
      log(`!! --from ${args.from} : idAdf absent de la liste. Rien à faire.`);
      process.exit(1);
    }
    cibles = cibles.slice(i);
  }

  log(`# SYNC-CHEVAL S14.1 — mode=${args.dryRun ? 'DRY-RUN (aucune écriture)' : 'WRITE'}`);
  log(`# Liste Loane : ${IDADFS.length} entrées → ${cibles.length} session(s) à traiter (${doublons} doublon(s) écarté(s))${args.from ? ` ; reprise à ${args.from}` : ''}`);
  log(`# Coût Dendreo estimé : ~${cibles.length * APPELS_PAR_SESSION + APPELS_INITIAUX} appels (${cibles.length} × ${APPELS_PAR_SESSION} + ${APPELS_INITIAUX}) — LECTURE SEULE`);
  log(`# Écriture : NOTRE Firestore uniquement (idempotent). Aucun POST/PUT vers Dendreo.\n`);

  if (args.dryRun) {
    log(cibles.join(', '));
    log('\n# DRY-RUN : aucune lecture Dendreo, aucune écriture. Relance sans --dry-run pour exécuter.');
    return;
  }

  const ok = [];
  const absentes = [];
  const erreurs = [];
  let signatures = 0;
  let quotaHit = null; // 'firestore' | 'dendreo'
  let reprise = null; // idAdf à passer à --from pour reprendre

  for (let i = 0; i < cibles.length; i += 1) {
    const idAdf = cibles[i];
    const pos = `[${String(i + 1).padStart(2, ' ')}/${cibles.length}]`;
    try {
      // SÉQUENTIEL, jamais en parallèle : le rate-limiter du client protège l'API,
      // et on veut un arrêt net au premier signe de quota (aucune requête en vol).
      const r = await syncSession(idAdf);
      if (!r.found) {
        absentes.push(idAdf);
        log(`${pos} idAdf=${idAdf} — ABSENTE côté Dendreo (aucune écriture)`);
      } else {
        ok.push(idAdf);
        signatures += r.attestations;
        log(`${pos} idAdf=${idAdf} — OK, ${r.attestations} signature(s) écrite(s)`);
      }
    } catch (err) {
      if (isQuotaError(err)) { quotaHit = 'firestore'; reprise = idAdf; break; }
      if (isDendreoQuotaError(err)) { quotaHit = 'dendreo'; reprise = idAdf; break; }
      erreurs.push({ idAdf, raison: shortReason(err) });
      log(`${pos} idAdf=${idAdf} — ERREUR (session suivante) : ${shortReason(err)}`);
      // résilient : une session KO n'arrête JAMAIS les autres
    }
  }

  const traitees = ok.length + absentes.length + erreurs.length;
  log(`\n################ RAPPORT SYNC-CHEVAL ################`);
  log(`# Sessions traitées      : ${traitees} / ${cibles.length}`);
  log(`#   OK (écrites)         : ${ok.length}  → ${signatures} signature(s) au total`);
  log(`#   Absentes de Dendreo  : ${absentes.length}${absentes.length ? ` (${absentes.join(', ')})` : ''}`);
  log(`#   Erreurs              : ${erreurs.length}`);
  for (const e of erreurs) log(`#     - idAdf=${e.idAdf} : ${e.raison}`);
  log(`# Appels Dendreo estimés : ~${traitees * APPELS_PAR_SESSION + APPELS_INITIAUX} (${traitees} × ${APPELS_PAR_SESSION} + ${APPELS_INITIAUX})`);

  if (quotaHit === 'firestore') {
    log(`\n# ⚠ QUOTA FIRESTORE atteint (RESOURCE_EXHAUSTED) sur idAdf=${reprise} → arrêt propre.`);
    log(`# Les sessions déjà traitées sont écrites. Reprendre plus tard :`);
    log(`#   node --import tsx scripts/sync-cheval.mjs --from ${reprise}`);
  } else if (quotaHit === 'dendreo') {
    log(`\n# ⚠ QUOTA DENDREO atteint (HTTP 429 après retries) sur idAdf=${reprise} → arrêt propre.`);
    log(`# Ne PAS relancer tout de suite (quota déjà à ~96 %). Reprendre plus tard :`);
    log(`#   node --import tsx scripts/sync-cheval.mjs --from ${reprise}`);
  } else if (erreurs.length === 0) {
    log(`\n# ✅ Terminé. L'onglet "À cheval 25/26" peut être actualisé (cache route : 60 s).`);
  } else {
    log(`\n# Terminé AVEC erreurs : les sessions listées ci-dessus n'ont pas été mises à jour.`);
  }

  // exit 0 même sur quota : c'est un arrêt PRÉVU, pas un plantage (idem backfill.mjs).
  process.exit(0);
}

main().catch((err) => {
  log(`!! SYNC-CHEVAL interrompu : ${shortReason(err)}`);
  process.exit(1);
});
