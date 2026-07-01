# docs/sprint-2-firestore-backfill.md — Sprint S2

Découpé en deux tranches testables : **S2.1 fondation Firestore**, puis **S2.2 backfill historique**.
Réf. modèle : `docs/firestore-model.md`. Toujours **lecture seule côté Dendreo**. **Claude Code ne commit jamais.**

---

## S2.1 — Fondation Firestore

### Côté Déthié (manuel, console Firebase)
1. Créer un **nouveau projet Firebase dédié** (ex. `medere-dendreo-dashboard`).
2. Activer **Firestore** — **chemin gratuit (plan Spark, sans carte)** :
   - Depuis la **console Firebase** (PAS la console Google Cloud).
   - **Édition Standard** (PAS « Enterprise » → l'Enterprise exige la facturation).
   - Base **`(default)`** — ne pas créer de base **nommée** (une base nommée exige la facturation).
   - **Emplacement européen** (`europe-west1` ou `eur3`) pour le RGPD — choix **définitif**.
   - **Mode production** (règles verrouillées) — ce n'est pas ça qui déclenche la facturation.
   - Quota gratuit Spark largement suffisant ici : 1 Go, 50 000 lectures / 20 000 écritures par jour.
3. Générer une **clé de compte de service** (Project Settings → Service accounts → Generate new private key → JSON).
4. Mettre les creds dans **`.env.local`** (jamais commité) :
   ```
   FIREBASE_PROJECT_ID=...
   FIREBASE_CLIENT_EMAIL=...
   FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
   ```

### Côté Claude Code — ce qu'on livre
- Init **Firebase Admin SDK** (creds lus depuis l'env, **jamais loggés** ; gérer le `\n` de la private key).
- Couche de données Firestore **typée** : `upsertSession()`, `upsertSignature()`, `getSession()`, `listSignaturesByStatus()`, recalcul des `counts`/`oldestPendingSentDate` d'une session.
- `firestore.rules` (lecture = authentifié Médéré, écriture client interdite) — voir `docs/firestore-model.md` §3.
- `firestore.indexes.json` (les 3 index composites — §2).
- **Tests contre l'émulateur Firestore** (déterministes, aucune écriture en prod) : écrire session + signatures, relire, **idempotence** (réécriture = pas de doublon), recalcul des counts.

### Hors scope S2.1
- ❌ Backfill, appels Dendreo, UI, déploiement.

### Scénarios pré-arbitrés
- 🟢 Émulateur vert (upsert + relecture + idempotence) → on commit S2.1, on enchaîne S2.2.
- 🟡 Souci de creds (private key `\n`, projet) → on corrige l'init Admin SDK, on ne touche pas au modèle.
- 🔴 L'émulateur ne tourne pas chez toi → on installe/configure l'émulateur Firebase d'abord (étape outillage), puis on reprend.

---

## S2.2 — Backfill historique

### Ce qu'on livre
- Un script `scripts/backfill.mjs` (tsx) qui :
  1. **Découvre la 1re année** : balaie les années en arrière (`started_after`/`started_before` par fenêtre annuelle, cf. piège « dernière année par défaut » de `docs/dendreo-api.md`) jusqu'à tomber sur des années vides.
  2. **Énumère toutes les sessions** de chaque année.
  3. Pour chaque session : appelle `getSessionSignatureStatus(idAdf)` (S1) → **upsert** session + signatures dans Firestore.
  4. Recalcule les `counts` de chaque session, écrit `_meta/backfill`.
- **Flags** : `DRY_RUN` (n'écrit rien, log ce qui serait écrit) et `--limit N` / `--year YYYY` (tranche réduite d'abord).
- **Quota-aware (2 côtés)** :
  - *Dendreo (lecture)* : ~2 appels/session (fichiers + laps), one-shot. Trivial vs 150 k/mois (archi §5). Respecter le burst 100/10s → **pacing/concurrence limitée** (le backoff 429 est déjà géré par le client, mais on pace pour ne pas le déclencher en boucle).
  - *Firestore (écriture, plan Spark)* : **20 000 écritures/jour**. Le backfill peut dépasser sur tout l'historique → **traitement année par année** + script **reprenable** : `_meta/backfill` mémorise les années déjà faites ; relancer reprend les années manquantes, sans doublon (upserts idempotents). Si une journée plafonne, on continue le lendemain.

### Méthode d'exécution (progressive)
1. `DRY_RUN=1 --year {année courante}` → vérifier les volumes et le shape, **rien écrit**.
2. `--year {année courante}` (écrit pour de vrai, 1 année) → relire dans Firestore, valider.
3. Backfill complet (toutes les années).

### Ce qu'on valide en S2.2
- Le **notSent>0 sur vraie donnée** (item backlog de S1) apparaît enfin ici, à grande échelle.
- Réconciliation : total signés/pending/notSent cohérent avec un échantillon vérifié à la main dans Dendreo.

### Hors scope S2.2
- ❌ Sync quotidien automatique + webhooks (sprint S3), UI (sprint S4).

### Scénarios pré-arbitrés
- 🟢 DRY_RUN puis 1 année écrite, counts cohérents → on lance le backfill complet, puis commit S2.2.
- 🟡 Écart de comptes vs Dendreo → on inspecte (dédup ? règle attendu ? doctype ?) avant d'élargir.
- 🔴 1re année mal détectée / pagination qui boucle ou rate des sessions → on fige la stratégie de fenêtrage annuel avant tout écriture massive.
