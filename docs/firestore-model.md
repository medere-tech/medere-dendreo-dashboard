# docs/firestore-model.md — Modèle de données Firestore (miroir)

> Le dashboard lit **Firestore**, jamais Dendreo directement. La couche de sync écrit ici.
> Projet Firebase **dédié** (séparé du projet SMS). Last-write-wins, idempotent.

---

## 1. Collections

> ⚠️ **Modèle signature à jour : `docs/signature-rule.md`.** Les compteurs et statuts ci-dessous sont
> remplacés par le modèle attestation (envoyés/signés/non-signés), sans `notSent`.

### `sessions/{idAdf}`
Une session de formation + son agrégat de signatures (pour la vue transverse et le tri).
```
{
  idAdf, numeroComplet, intitule, dateDebut, dateFin, idEtapeProcess, etape,
  idCentre, type, totalParticipants,
  numeroSessionDpc: string,            // 26.001 (toujours présent)
  numeroCompteProduit: string | null,  // 92622... — ADF.numero_comptable, sinon num_programme_dpc du module CŒUR (cat ∉ {21,22}) — cf. recon-s5-findings §2
  format: string,                      // S5.1b — libellé Format depuis mode_organisation : Présentiel | Mixte | E-learning (elearning_async) | Classe virtuelle (elearning_sync)
  aCheval: boolean,                    // S5.1b — année(dateDebut) != année(dateFin)
  eppAmontConnecte: boolean,           // S5.1b — module id_categorie_module=22 AVEC c_nombre_dheures_connectees > 0
  eppAvalConnecte: boolean,            // S5.1b — module id_categorie_module=21 AVEC c_nombre_dheures_connectees > 0
  eligibleDpc: boolean,                // S6.2 — eligible_dpc="1" du module CŒUR (cat ∉ {21,22})
  aEpp: boolean,                       // S6.2 — ∃ module EPP (cat 22 ou 21) dans la session
  datesSynchrones: string[],           // S12.1 — jours ISO "AAAA-MM-JJ" (jour Paris NAÏF, cf. §6 cas A) des créneaux datés. RÈGLE NIVEAU SESSION : si format session (mode_organisation ADF) ∈ {mixte, elearning_sync} → TOUS les jours des créneaux de TOUS les LAM (sans filtrer le mode du module), dédupliqués + triés croissant ; sinon (présentiel/elearning_async/autre) → []
  financeurAndpc: boolean,             // S11.1 (V2) — ∃ ligne financements.id_financeur=360 (ANDPC)
  montantAndpc: number | null,         // S11.1 (V2) — Σ financements.montant_finance des lignes 360 UNIQUEMENT ; null si aucune
  // V3 : agrégat des factures id_opca=360. S13.3 — le PÉRIMÈTRE DÉPEND DU CHAMP :
  //   la date de DÉPÔT se voit dès le dépôt (payée ou non), le montant et le paiement
  //   attendent le paiement. AUCUNE facture ANDPC → les 3 champs null. Factures déposées
  //   mais AUCUNE payée → factureDateEnvoi remplie, montantHt et datePaiement null.
  factureDateEnvoi: string | null,     // S13.3 — plus ANCIENNE date_envoi non vide parmi TOUTES les factures ANDPC, PAYÉES OU NON, JOUR PARIS (slice 10, jamais UTC)
  factureMontantHt: number | null,     // S11.1 (V3) — Σ montant_total_ht des factures ANDPC PAYÉES uniquement (date_paiement non vide)
  factureDatePaiement: string | null,  // S11.1 (V3) — plus RÉCENTE date_paiement des factures ANDPC PAYÉES, JOUR PARIS
  // S15 — FACTURE 1 / FACTURE 2 des sessions À CHEVAL (demande Justine). Le budget ANDPC
  //   est ANNUEL : une session à cheval est facturée sur le budget de l'année de DÉBUT
  //   puis sur celui de l'année de FIN. AUCUN champ de la facture ne porte l'année de
  //   budget (78 clés vérifiées : ni période, ni année, ni libellé) — c'est l'ORDRE
  //   D'ÉMISSION qui la porte : la facture du budget N est toujours émise avant celle du
  //   budget N+1. Tri des factures id_opca=360 par date_emission CROISSANTE, départage
  //   id_facture croissant → position 1 = année de début, position 2 = année de fin.
  //   ⚠ date_envoi n'est PAS discriminante (une facture 2025 peut être envoyée en 2026 si
  //   des PS signent en retard) et peut être VIDE sur une facture payée (cas réel 3328).
  //   Session NON à cheval → les 4 champs null. À cheval avec 1 seule facture → facture2* null.
  //   > 2 factures → seules les 2 plus anciennes alimentent ces colonnes. `factureMontantHt`
  //   (montant payé) reste l'agrégat S13.3, INCHANGÉ.
  facture1DateEnvoi: string | null,    // S15 — date_envoi de la facture ANDPC la plus ancienne (JOUR PARIS)
  facture1DatePaiement: string | null, // S15 — date_paiement de cette même facture
  facture2DateEnvoi: string | null,    // S15 — date_envoi de la 2e facture ANDPC par date_emission
  facture2DatePaiement: string | null, // S15 — date_paiement de cette même facture
  counts: {                            // cf. signature-rule.md §4
    envoyes: number,
    signes: number,
    nonSignes: number,                 // = envoyes - signes (à relancer)
    participantsConcernes: number,
    participantsARelancer: number
  },
  oldestPendingSentDate: string | null,
  lastSyncedAt, source: "dendreo"
}
```

### `signatures/{idAdf}_{idParticipant}_{doctypeId}`
Une ligne par **attestation** (participant × session × doctype). Source de la vue « à relancer ».
```
{
  idAdf, idParticipant, doctypeId,
  documentName: string,                // nom du document (commence par "Attestation")
  nom: string,                         // affichage, interne, accès protégé
  status: "signed" | "pending",        // plus de "notSent"
  signatureDate: string | null,
  sentDate: string | null,
  viewerUrl: string | null,
  financeurAndpc: boolean | null,      // S11.1 — true=ANDPC(360) | false=autre financeur | null=aucun financement rattaché
                                       //   (chaîne : idParticipant → laps.id_entreprise → financements.id_finance → id_financeur)
  commercial: string | null,           // S13.1 — "Prénom NOM" du commercial de l'inscription (laps.commercial_id → administrateurs.php, référentiel lu 1×/run) ; null si absent/non résolu. Coût 0 (laps déjà lu par enrichFinancement)
  sessionNumeroComplet, sessionIntitule, sessionDateDebut,
  lastSyncedAt
}
```

### `_meta/{doc}`
- `_meta/backfill` : `{ firstYearDiscovered, yearsProcessed: [], sessionsProcessed, lastRunAt, status }`
- `_meta/sync` : `{ lastDailyRunAt, activeSessionsCount, status }`

## 2. Index composites (Firestore)

Déclarés dans `firestore.indexes.json` :
- `signatures` : `status (ASC)` + `sentDate (ASC)` → liste « à relancer » triée par ancienneté, toutes sessions.
- `signatures` : `idAdf (ASC)` + `status (ASC)` → détail d'une session.
- `sessions` : `counts.pending (DESC)` (ou `oldestPendingSentDate ASC`) → accueil trié par urgence.

## 3. Règles de sécurité (`firestore.rules`)

- **Lecture** : autorisée uniquement aux utilisateurs **authentifiés Médéré** (Firebase Auth ; email du domaine Médéré ou allowlist). C'est ce qui permet les listeners temps réel côté UI.
- **Écriture client** : **interdite**. Seule la couche serveur (Admin SDK, qui bypass les règles) écrit.
- `_meta` : lecture admin uniquement.

## 4. PII — minimisation (RGPD)

- On stocke **uniquement** ce que le dashboard affiche : `nom` + `viewerUrl` + statut/dates.
- **Pas d'email, pas de téléphone, pas de n° sécu** dans Firestore.
- Tout accès est derrière **Firebase Auth**. Outil interne, données minimales, accès contrôlé.
- Les fixtures de test restent anonymisées (initiales).

## 5. Contrat d'upsert (idempotent)

- **Clés déterministes** : `sessions/{idAdf}`, `signatures/{idAdf}_{idParticipant}_{doctypeId}`.
- Rejouer le backfill, recevoir un webhook, ou relancer la sync → **met à jour le même doc** sans doublon. Last-write-wins.
- `counts` et `oldestPendingSentDate` de la session sont **recalculés** à chaque sync de la session (dérivés des `signatures` de cette session).
- **Enrichissement S5.1b/S6.2/S12.1** (`format`, `aCheval`, `eppAmontConnecte`, `eppAvalConnecte`, `eligibleDpc`, `aEpp`, `datesSynchrones`, `numeroCompteProduit` corrigé) : `format`/`aCheval` sont dérivés de l'ADF seul ; les booléens EPP, `eligibleDpc`, `aEpp`, `datesSynchrones` et la correction `numeroCompteProduit` viennent des **LAM** via **1 lecture / session** — `lams.php?id_action_de_formation={id}&include=module,creneaux` (porte `id_categorie_module`, `c_nombre_dheures_connectees`, `num_programme_dpc`, `eligible_dpc`, et les `creneaux` datés — champ `day`). **`include=creneaux` est GRATUIT** : même requête, aucune lecture Dendreo supplémentaire (S12.0). Logique pure et testée : `src/dendreo/enrich.ts` (`extractDatesSynchrones(lams, sessionMode)`, partagée backfill + sync — le filtre CV/Mixte est **au niveau session**, pas module : le mode du LAM n'est pas fiable, cf. idAdf 3586 présentiel qui a des séances datées). Une lecture LAM KO n'empêche pas l'écriture de la session (valeurs ADF-only conservées ; `datesSynchrones` reste `[]`).
- **Enrichissement S11.1/S15 — financements + factures** : `enrichFinancement(idAdf, client, aCheval)` (`src/dendreo/financement.ts`, **partagée backfill + sync**) fait **3 lectures résilientes / session** (`financements.php`, `factures.php`, `laps.php`). Le split **S15** (`splitFacturesAcheval`) rejoue les factures **déjà lues** → **0 lecture Dendreo ajoutée**. `aCheval` est passé par l'appelant (déjà calculé par `isACheval(dateDebut, dateFin)`), jamais recalculé ici. Une lecture KO → champs à `null` + `console.warn` sans PII : **la session s'écrit toujours**.
- Suppression de lignes obsolètes (un doc qui disparaîtrait côté Dendreo) : **backlog** (rare ; on traite plus tard, pas en S2).

## 6. Format des dates (anti-bug fuseau) — DEUX cas distincts

**Cas A — dates de session** (`dateDebut`, `dateFin`), issues de `actions_de_formation.php` : **heure murale Europe/Paris, SANS fuseau** (ex. `"2026-01-01T00:00:00"`).
- Normalisées en **ISO 8601 naïf** (espace → `T`). Comparaison par `slice(0,10)` (jour), triable lexicographiquement.
- **Ne JAMAIS** faire `new Date(x).toISOString()` dessus (ajouterait un `Z` UTC → décalage d'1 jour). Pas de conversion de fuseau.

**Cas B — dates de signature** (`signatureDate`, `sentDate`, `oldestPendingSentDate`), issues de `fichiers.php` : **instants UTC absolus, AVEC `Z`** (ex. `"2025-06-02T22:01:04.000000Z"`).
- Ce sont des instants non ambigus → pour AFFICHER ou dériver un **jour Paris**, convertir via `Intl` (timeZone `Europe/Paris`). **Ne pas** faire `slice(0,10)` (donnerait le jour UTC → décalage ~22h-minuit).
- Un helper Paris partagé (`parisDayOfInstant`) sert le drawer et la vue « À relancer ».

⚠️ Ne pas confondre les deux : slice pour le cas A (naïf Paris), conversion Intl pour le cas B (UTC-Z).
