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
  numeroCompteProduit: string | null,  // 92622... (optionnel)
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
- Suppression de lignes obsolètes (un doc qui disparaîtrait côté Dendreo) : **backlog** (rare ; on traite plus tard, pas en S2).

## 6. Format des dates (anti-bug fuseau)

Dendreo renvoie les dates/heures en **heure murale Europe/Paris, sans indicateur de fuseau** (ex. `"2026-01-01 00:00:00"`).
- On normalise en **ISO 8601 naïf** : remplacer l'espace par `T` → `"2026-01-01T00:00:00"`. Triable lexicographiquement.
- **Ne JAMAIS** faire `new Date(x).toISOString()` (ajoute un `Z` UTC → décalage d'1 jour sur les `00:00:00`). Pas de conversion de fuseau.
- Vaut pour `dateDebut`, `dateFin`, `signatureDate`, `sentDate`, `oldestPendingSentDate`.
