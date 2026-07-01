# docs/security-notes.md — Passe sécurité dépendances (S2.1)

> Date : 2026-06-29. Outil interne, posture « premium ». Objectif : **chaîne de
> PRODUCTION propre** (ce qui s'exécute dans l'app déployée = `firebase-admin` et
> sa chaîne). Le DEV (outillage local : `firebase-tools`, `vitest`/`vite`) est
> traité à part : il ne part pas dans l'artefact déployé.

## Méthode

1. `npm audit` + `npm audit --omit=dev` + parse JSON → classement PROD vs DEV de chaque vuln.
2. `npm audit fix` **sans `--force`** (corrections non-breaking uniquement).
3. `overrides` ciblés vers une version patchée **uniquement** si pas de bump majeur d'une dép **directe**.
4. Toute vuln ne se corrigeant que par un **breaking** d'une dép directe → **non corrigée, documentée**.
5. Preuve de non-régression : `npm run typecheck && npm test` (25 tests verts) + smoke-import `firebase-admin`.

## Actions correctives appliquées

| Action | Détail | Effet |
|---|---|---|
| **Retrait de paquets parasites** | `npm`, `run`, `typecheck` étaient en `dependencies` (ajout accidentel) | −149 paquets ; élimine `undici` (**high**) et tout son bruit transitif de la chaîne prod |
| **Override `uuid` → `^11.1.1`** | transitif (via `gaxios`/`teeny-request`/`@google-cloud/storage` sous `firebase-admin`) ; **pas** un bump majeur d'une dép directe | élimine **toute** la chaîne prod (`uuid`/`gaxios`/`teeny-request`/`retry-request`/`@google-cloud/storage`/`firebase-admin`) ; firebase-admin vérifié OK |
| **`npm audit fix`** (sans `--force`) | aucune correction non-breaking restante après les 2 actions ci-dessus | no-op (attendu) |

## Triage des vulnérabilités

### Chaîne PRODUCTION (firebase-admin)
| Vuln | Sévérité | Statut |
|---|---|---|
| `undici` (HTTP header injection, DoS WS, etc.) | high | **Corrigée** — venait du parasite `npm`, retiré |
| `uuid <11.1.1` (+ `gaxios`, `teeny-request`, `retry-request`, `@google-cloud/storage`, `firebase-admin`) | moderate | **Corrigée** — override `uuid ^11.1.1` |

➡️ **`npm audit --omit=dev` = `found 0 vulnerabilities`. Chaîne de production PROPRE.**

### Chaîne DEV uniquement (non déployée) — vulns restantes, reportées
| Vuln | Sévérité | Prod/Dev | Action / Raison du report |
|---|---|---|---|
| `vitest <=3.2.5` | **critical** | DEV | Correctif = `vitest@4` (**bump majeur** d'une dép directe dev). Report (règle 4). Vuln du **serveur de dev** vitest, jamais exécutée en prod. Migration vitest 2→4 à planifier à part. |
| `vite <=6.4.2` | high | DEV | Même chaîne que vitest. Report (breaking). Serveur de dev only. |
| `esbuild <=0.24.2` | moderate | DEV | Serveur de dev esbuild peut recevoir des requêtes arbitraires. Correctif via `vitest@4` (breaking). Report. Non exposé : émulateur/tests en local. |
| `@vitest/mocker`, `vite-node` | moderate | DEV | Dépendent de `vite`/`esbuild` vulnérables. Report (même fix breaking). |
| `@opentelemetry/core <2.8.0` | moderate | DEV | Via `@google-cloud/pubsub` ← `firebase-tools`. Correctif = downgrade `firebase-tools@14.23.0` (**breaking**). Report (règle 4). `firebase-tools` = outillage émulateur, jamais déployé. |
| `@google-cloud/pubsub`, `firebase-tools` | moderate | DEV | Même chaîne `firebase-tools`. Report. |

## Conclusion

- **Production : 0 vulnérabilité** (`npm audit --omit=dev`). La seule dépendance runtime est `firebase-admin`, dont la chaîne est désormais saine grâce à l'override `uuid`.
- **Dev : 8 vulns restantes** (1 critical, 1 high, 6 moderate), **toutes** dans l'outillage local (`vitest`/`vite`/`esbuild`, `firebase-tools`) et **non déployées**. Leur seul correctif passe par un **changement breaking** d'une dépendance directe (`vitest@4` / downgrade `firebase-tools`) → reporté volontairement (règles 3-4), sans impact sur l'app livrée.
- **Suivi recommandé** (hors S2.1) : planifier la migration `vitest 2 → 4` (referme critical+high+moderate dev d'un coup) ; revoir l'override `uuid` quand `firebase-admin` embarquera nativement `uuid >= 11`.

## Garde anti-régression (CI locale)

- Script `audit:prod` = `npm audit --omit=dev --audit-level=high`.
- Câblé dans le hook **`pre-push`** (Husky), à côté de `tsc` + `vitest`. Un push qui
  réintroduirait une vuln **high/critical en PRODUCTION** échoue automatiquement ;
  les vulns **dev** ne bloquent pas le push.

## Passe sécurité — app web Next.js (S3.1)

> Date : 2026-07-01. Nouvelle **surface d'audit distincte** : `web/` (app Next
> déployée sur Vercel). Chaîne de PRODUCTION web = `next` + `react`/`react-dom` +
> `firebase` (Web SDK client). Auditée séparément via `npm --prefix web run
> audit:prod` (= `npm audit --omit=dev --audit-level=high`).

### Résultat
- **`audit:prod` web = 0 high/critical** → le gate passe (exit 0). Acceptation S3.1 tenue.
- **Restant : 2 moderate** — `postcss <8.5.10` (GHSA-qx2v-qp2m-jg93 : XSS via `</style>`
  non échappé dans la sortie *stringify* de PostCSS), tirés **uniquement** du postcss
  **imbriqué de Next** : `node_modules/next/node_modules/postcss@8.4.31`.
  (Notre propre devDep `postcss` résout déjà à `8.5.16`, patché, et hors chaîne prod.)

### Décision
- On est **déjà sur le dernier patch 15.x** (`next@15.5.19`). Le seul correctif proposé par
  `npm audit fix --force` est `next@9.3.3` → **downgrade cassant**. **Non appliqué** (règle 4).
- **Moderate, sous notre seuil high/critical.** Risque réel **quasi nul** : PostCSS ne traite,
  au *build*, que **notre propre CSS** (`web/src/app/globals.css`) — aucune entrée CSS non
  fiable, aucune exécution runtime côté client. Non exploitable dans notre usage.
- **Option de remédiation disponible (NON appliquée, à décider)** : `override postcss ^8.5.10`
  dans `web/package.json` — bump **mineur** (non-major), cohérent avec la méthodo S2.1 §3 et le
  précédent `uuid`. Forcerait le postcss imbriqué de Next à la version patchée → audit prod web
  à **0**. À valider par Déthié/l'architecte au besoin (le gate passe déjà sans).

### Garde
- Le hook `pre-push` (Husky) lance désormais aussi `npm --prefix web run audit:prod` : une
  vuln **high/critical** réintroduite dans la chaîne prod web fait échouer le push. Les moderate
  ci-dessus ne bloquent pas.

## Évolution auth (Firestore)

- **Aujourd'hui (prod)** : lecture autorisée si utilisateur Firebase authentifié **ET**
  email vérifié (`email_verified == true`) **ET** email matchant la regex **ancrée**
  `^[^@]+@medere[.]fr$` (domaine dans une fonction unique `isMedereUser()` de
  `firestore.rules`). Écriture client interdite partout ; `_meta` inaccessible au client ;
  **fail-closed** (deny par défaut).
- **Durcissement futur (NON implémenté, prochaine étape tracée)** : remplacer/compléter le
  filtre par domaine par une **allowlist explicite via custom claims Firebase**
  (ex. claim `medereAccess == true` posé par une Cloud Function/Admin à la création du compte).
  Avantages : révocation fine par utilisateur, support d'emails hors domaine si besoin,
  indépendance vis-à-vis du libellé de domaine. À décider au sprint Auth (S4).
