# docs/sprint-10-faisabilite-sheets.md — S10.0 Faisabilité (Google Sheets « pull »)

> **Sprint de recherche/lecture uniquement.** Aucun code de prod, aucun commit.
> Objectif : trancher entre **Option B** (Apps Script lit Firestore directement) et
> **Option C** (l'outil expose une route de lecture que le script appelle), avec preuves.
> Date de l'analyse : **2026-07-09**.

**Besoin** : un Google Sheet autonome (Apps Script « pull ») qui affiche **exactement les
colonnes de l'export CSV Ops** (cf. `web/src/lib/sessions/export.ts`), avec des **titres
cliquables** (`=LIEN_HYPERTEXTE` vers l'espace signatures Dendreo). Contrainte non
négociable : **source unique, zéro duplication de logique métier** — la logique reste dans
l'outil, on ne la réécrit PAS en Apps Script.

---

## 0. Résumé exécutif (TL;DR)

| Sujet | Verdict |
|---|---|
| **Recommandation** | ✅ **Option C** (route de lecture réutilisant `export.ts`), sans réserve. |
| **Option B** | 🔴 Non viable durablement : clé de service account dans un Apps Script + duplication obligatoire de la présentation + lib figée depuis 2020. |
| **Point décisif** | La **présentation** (formatage, ordre des 19 colonnes, colonnes Ops vides, hyperlien) vit dans `export.ts`, **PAS** dans Firestore. Lire Firestore « déjà calculé » ne suffit donc pas à éviter la duplication. |
| **Angle mort** | Chaque refresh du Sheet = une passe de lectures Firestore facturées → déclenchement **manuel/horaire** + **cache court** côté route. À cadrer en S10.1. |

---

## 1. Ce que le code établit (preuves, pas hypothèses)

1. **Mappers CSV déjà purs et centralisés** — `web/src/lib/sessions/export.ts` :
   `SESSIONS_CSV_HEADERS` (19 colonnes, ordre exact du Sheet Ops), `sessionToCsvRow(s: SessionDoc)`,
   et les formateurs `signaturesSummary` (« 3 à relancer »), `attestationManquante` (« 2/5 »),
   `eppCoNc` (« NC/CO »), `ddmmyy` (« JJ/MM/AA »), + les colonnes Ops laissées **vides**
   volontairement.
2. **Le lien cliquable existe déjà comme donnée** — dernière colonne « Lien stockage » =
   `suiviSignaturesUrl(s.idAdf)` (`export.ts:78`). Le titre cliquable Apps Script n'a besoin
   d'**aucune logique nouvelle** : titre = `Intitulé`, URL = colonne « Lien stockage » déjà
   présente dans la ligne.
3. **La couche métier calculée est déjà persistée dans Firestore** — `s.counts`,
   `s.eppAmontConnecte`, `s.aEpp`, `s.eligibleDpc`, `s.aCheval`… sont écrits au sync/backfill.
   **MAIS** la couche *présentation* (formatage + ordre + colonnes Ops vides + hyperlien) vit
   dans `export.ts`, **pas** dans Firestore.
4. **Deux chemins d'accès Firestore déjà en place** : l'app lit côté **client**
   (SDK client + Firebase Auth : `allSessionsQuery`), le webhook lit côté **serveur** via
   **Admin SDK** — service account déjà câblé (`FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` /
   `FIREBASE_PRIVATE_KEY`, cf. `web/src/app/api/webhooks/dendreo/route.ts`).

---

## 2. LE POINT DÉCISIF

> **La présentation vit dans `export.ts`, pas dans Firestore.**

« Lire les données déjà calculées » ne suffit **pas** à éviter la duplication. Les champs
métier (`counts`, `eppAmontConnecte`, `aEpp`…) sont bien pré-calculés et stockés dans Firestore,
mais le **rendu CSV** — le « même Sheet que l'export » — n'est pas dans les données : il est dans
`export.ts` (formatage « 3 à relancer » / « 2/5 » / « NC/CO » / « JJ/MM/AA », ordre des 19
colonnes, colonnes Ops laissées vides, construction du lien).

Conséquence directe :
- **Option C** réutilise `export.ts` tel quel → **zéro duplication**.
- **Option B** doit **réécrire cette présentation en Apps Script** → duplication + dérive
  garantie dès la première évolution de colonne.

---

## 3. Option B — Apps Script lit Firestore directement

**Lib de référence** : `grahamearley/FirestoreGoogleAppsScript` (la seule mûre). Constats :

- **Dernière release : v33, juillet 2020** → ~6 ans sans nouvelle version, 24 issues ouvertes.
  Non archivée, mais **maintenance de fait arrêtée**.
- **Auth = compte de service** : il faut copier `client_email` + `private_key` + `project_id`
  dans les **Script Properties** du script.
- Alternative « sans lib » = appeler la **REST API Firestore** en montant soi-même un **JWT signé**
  → échange OAuth2 via `UrlFetchApp`, puis décoder le format typé (`stringValue` / `booleanValue`
  / `mapValue`…) document par document, pagination à gérer à la main.

| Critère | Verdict B |
|---|---|
| **Fiabilité** | ⚠️ Faible-moyenne. Dépendance à une lib non maintenue **ou** décodage REST typé maison + pagination manuelle. |
| **Sécurité** | 🔴 **Une vraie clé privée de service account posée dans un Apps Script.** Secret Google durable hors périmètre `.env.local`/Vercel, exposé à quiconque accède au script. Contredit le §4 de `CLAUDE.md`. |
| **Maintenance** | 🔴 Lib figée depuis 2020 ; si Google change l'auth ou le runtime GAS, personne ne patche. |
| **Duplication** | 🔴 **Rédhibitoire.** Toute la présentation (`signaturesSummary`, `attestationManquante`, `eppCoNc`, `ddmmyy`, ordre des 19 colonnes, colonnes Ops vides) réécrite en Apps Script et **dérive** de `export.ts`. Viole « source unique ». |
| **Effort** | Moyen-élevé (auth JWT + décodage REST + réécriture des mappers + tests impossibles côté GAS). |
| **Quota** | Chaque refresh du Sheet = N lectures documentaires facturées côté Firestore. |

**Verdict B : NON viable durablement.** Deux faits suffisent : (1) une clé de service account
dans un Apps Script, (2) la duplication obligatoire de la couche présentation.

---

## 4. Option C — l'outil expose une route de lecture, le script l'appelle

**Route (décrite, pas codée)** : `GET /api/export/sheet` dans `web/src/app/api/…`,
`runtime = 'nodejs'`, `dynamic = 'force-dynamic'` — même modèle que la route webhook existante.
Elle :
1. lit les sessions via l'**Admin SDK déjà câblé** (même service account que le webhook, côté
   serveur uniquement) ;
2. **réutilise `export.ts` tel quel** — `SESSIONS_CSV_HEADERS` + `rows.map(sessionToCsvRow)`
   (ou `sessionsToCsv`). **Aucune logique nouvelle.** Renvoie soit le CSV brut, soit
   `{ headers, rows }` en JSON (plus simple à parser côté GAS).

**Sécurité (approche la plus simple)** : un **jeton statique** dans un header
(`Authorization: Bearer …`) ou un param, comparé **en temps constant** à une variable d'env Vercel
(ex. `SHEET_EXPORT_TOKEN`). Côté Apps Script, le jeton est rangé dans les **Script Properties**.
Aucune donnée publique, aucun secret Google chez Vercel, la clé Firebase ne quitte jamais le
serveur. Le jeton est un secret **bas privilège** : lecture seule, révocable en changeant l'env —
sans commune mesure avec une clé de service account.

**Côté Apps Script** : `UrlFetchApp.fetch(url, { headers })` → `JSON.parse` → écriture des lignes,
avec `=LIEN_HYPERTEXTE(url; intitulé)` où `url` et `intitulé` viennent **déjà** de la ligne
renvoyée. C'est le pattern standard et robuste des « connecteurs » Apps Script.

| Critère | Verdict C |
|---|---|
| **Fiabilité** | ✅ Élevée. `UrlFetchApp` + JSON, zéro décodage Firestore typé, pagination côté serveur maîtrisée. |
| **Sécurité** | ✅ Meilleure. Secret Firebase reste serveur ; seul un jeton lecture-seule révocable circule. Aligné §4. |
| **Maintenance** | ✅ Une route qui **importe** `export.ts`. Le Sheet suit automatiquement toute évolution des colonnes. Couvert par `vitest` via les mappers existants. |
| **Duplication** | ✅ **Nulle.** Source unique = `export.ts`. C'est l'objectif littéral du sprint. |
| **Effort** | Faible : route mince (modèle webhook déjà présent) + ~30 lignes Apps Script. |
| **Quota** | Idem B (lecture Admin SDK au refresh), mais **une seule requête réseau** GAS→Vercel au lieu de N. |

**Verdict C : viable et aligné.**

---

## 5. Recommandation — **Option C**, sans réserve

Trois raisons dirimantes :

1. **Source unique respectée.** C reste branché sur `export.ts` ; B **oblige** à réécrire toute
   la présentation en Apps Script (les données Firestore sont pré-calculées, mais le *rendu* ne
   l'est pas) → dérive garantie.
2. **Sécurité.** C garde la clé de service account côté serveur et ne fait circuler qu'un jeton
   lecture-seule révocable ; B pose une **clé privée Google durable dans un Apps Script**, ce qui
   contredit le §4 « secrets non négociable » de `CLAUDE.md`.
3. **Maintenance/fiabilité.** La seule lib GAS↔Firestore mûre est **figée depuis juillet 2020** ;
   C ne dépend que de `UrlFetchApp` + JSON, standard et stable.

---

## 6. Angle mort — quota (règle d'or 7)

Dans **les deux** options, chaque refresh du Sheet déclenche une passe de lecture Firestore
facturée. Un `onOpen` (rafraîchir à chaque ouverture du Sheet) multiplierait les lectures sans
valeur ajoutée.

**À cadrer en S10.1 (hors périmètre S10.0)** :
- **Déclenchement maîtrisé** côté Apps Script : bouton manuel + **trigger horaire** (`ScriptApp`
  time-driven), **pas** de refresh à chaque ouverture.
- **Cache court** côté route (`GET /api/export/sheet`) : revalidation de quelques minutes pour
  absorber les rafales et plafonner les lectures Firestore.

---

## 7. Périmètre

- **Livré (S10.0)** : ce comparatif + recommandation. Rien codé, rien commité.
- **Hors scope S10.0** : implémentation de la route, du jeton, du script Apps Script, du cache —
  → S10.1 si l'architecte valide l'Option C.

---

## Sources

- [FirestoreGoogleAppsScript — GitHub (grahamearley)](https://github.com/grahamearley/FirestoreGoogleAppsScript) — lib de référence, dernière release v33 (juillet 2020), auth service account.
- [Using Firestore in Apps Script — Justin Poehnelt](https://justin.poehnelt.com/posts/apps-script-firestore/) — auth service account / OAuth2 depuis Apps Script.
- [Using Firestore in Apps Script — Google Workspace / DEV](https://dev.to/googleworkspace/using-firestore-in-apps-script-4n9d) — approche REST + JWT via UrlFetchApp.
- [Cloud Firestore REST API — Firebase](https://firebase.google.com/docs/firestore/use-rest-api) — auth (ID token / OAuth2), format typé des documents.
- [External APIs — Apps Script (Google)](https://developers.google.com/apps-script/guides/services/external) — `UrlFetchApp` pour appeler une API externe (pattern Option C).
