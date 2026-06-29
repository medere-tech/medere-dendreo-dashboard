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
