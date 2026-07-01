# docs/firestore-model.md — Modèle de données Firestore (miroir)

> Le dashboard lit **Firestore**, jamais Dendreo directement. La couche de sync écrit ici.
> Projet Firebase **dédié** (séparé du projet SMS). Last-write-wins, idempotent.

---

## 1. Collections

### `sessions/{idAdf}`
Une session de formation + son agrégat de signatures (pour la vue transverse et le tri).
```
{
  idAdf: string,
  numeroComplet: string,          // "ADF_2026xxxx"
  intitule: string,
  dateDebut: string,              // ISO
  dateFin: string,                // ISO
  idEtapeProcess: string,
  etape: string,                  // libellé ("Réalisation"...)
  idCentre: string,
  type: string,                   // "inter"
  totalParticipants: number,
  counts: { signed: number, pending: number, notSent: number },
  oldestPendingSentDate: string | null,  // pour trier par urgence (plus vieux en attente)
  lastSyncedAt: string,           // ISO
  source: "dendreo"
}
```

### `signatures/{idAdf}_{idParticipant}_{doctypeId}`
Une ligne par participant × session × document. **Source de la vue « à relancer » transverse.**
```
{
  idAdf: string,
  idParticipant: string,
  doctypeId: string,              // "111" (Convention) par défaut
  nom: string,                    // nom d'affichage (interne, accès protégé)
  status: "signed" | "pending" | "notSent",
  signatureDate: string | null,   // si signed
  sentDate: string | null,        // si pending (date d'envoi → ancienneté)
  viewerUrl: string | null,
  // dénormalisé pour éviter les jointures dans la vue transverse :
  sessionNumeroComplet: string,
  sessionIntitule: string,
  sessionDateDebut: string,
  lastSyncedAt: string
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
