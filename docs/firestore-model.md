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
  financeurAndpc: boolean,             // S11.1 (V2) — ∃ ligne financements.id_financeur=360 (ANDPC)
  montantAndpc: number | null,         // S11.1 (V2) — Σ financements.montant_finance des lignes 360 UNIQUEMENT ; null si aucune
  // V3 : agrégat des factures id_opca=360 PAYÉES uniquement (date_paiement non vide ;
  //   une facture non payée est ignorée jusqu'à son paiement). null si aucune facture payée.
  factureDateEnvoi: string | null,     // S11.1 (V3) — plus ANCIENNE date_envoi des factures ANDPC PAYÉES, JOUR PARIS (slice 10, jamais UTC)
  factureMontantHt: number | null,     // S11.1 (V3) — Σ montant_total_ht des factures ANDPC PAYÉES
  factureDatePaiement: string | null,  // S11.1 (V3) — plus RÉCENTE date_paiement des factures ANDPC PAYÉES, JOUR PARIS
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
- **Enrichissement S5.1b/S6.2** (`format`, `aCheval`, `eppAmontConnecte`, `eppAvalConnecte`, `eligibleDpc`, `aEpp`, `numeroCompteProduit` corrigé) : `format`/`aCheval` sont dérivés de l'ADF seul ; les booléens EPP, `eligibleDpc`, `aEpp` et la correction `numeroCompteProduit` viennent des **modules** via **1 lecture / session** — `lams.php?id_action_de_formation={id}&include=module` (porte `id_categorie_module`, `c_nombre_dheures_connectees`, `num_programme_dpc`, `eligible_dpc`). Logique pure et testée : `src/dendreo/enrich.ts`. Une lecture module KO n'empêche pas l'écriture de la session (valeurs ADF-only conservées).
- Suppression de lignes obsolètes (un doc qui disparaîtrait côté Dendreo) : **backlog** (rare ; on traite plus tard, pas en S2).

## 6. Format des dates (anti-bug fuseau) — DEUX cas distincts

**Cas A — dates de session** (`dateDebut`, `dateFin`), issues de `actions_de_formation.php` : **heure murale Europe/Paris, SANS fuseau** (ex. `"2026-01-01T00:00:00"`).
- Normalisées en **ISO 8601 naïf** (espace → `T`). Comparaison par `slice(0,10)` (jour), triable lexicographiquement.
- **Ne JAMAIS** faire `new Date(x).toISOString()` dessus (ajouterait un `Z` UTC → décalage d'1 jour). Pas de conversion de fuseau.

**Cas B — dates de signature** (`signatureDate`, `sentDate`, `oldestPendingSentDate`), issues de `fichiers.php` : **instants UTC absolus, AVEC `Z`** (ex. `"2025-06-02T22:01:04.000000Z"`).
- Ce sont des instants non ambigus → pour AFFICHER ou dériver un **jour Paris**, convertir via `Intl` (timeZone `Europe/Paris`). **Ne pas** faire `slice(0,10)` (donnerait le jour UTC → décalage ~22h-minuit).
- Un helper Paris partagé (`parisDayOfInstant`) sert le drawer et la vue « À relancer ».

⚠️ Ne pas confondre les deux : slice pour le cas A (naïf Paris), conversion Intl pour le cas B (UTC-Z).
