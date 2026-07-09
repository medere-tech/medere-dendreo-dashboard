# RUNBOOK — Dashboard de suivi des signatures Médéré

> **À qui s'adresse ce document ?** À toute personne de Médéré qui doit comprendre, surveiller
> ou dépanner l'outil — même sans l'avoir construit. Aucune connaissance technique avancée n'est
> supposée : les termes sont expliqués au fil du texte, et un glossaire figure à la fin.
>
> **En cas de problème urgent :** va directement à la section [7. Pannes courantes](#7-pannes-courantes--que-faire).

---

## Sommaire

1. [À quoi sert l'outil (en une page)](#1-à-quoi-sert-loutil-en-une-page)
2. [Comment il est construit (vue d'ensemble)](#2-comment-il-est-construit-vue-densemble)
3. [Comment les données se mettent à jour — le cœur](#3-comment-les-données-se-mettent-à-jour--le-cœur)
4. [Les comptes et accès (qui possède quoi)](#4-les-comptes-et-accès-qui-possède-quoi)
5. [Où surveiller que tout va bien](#5-où-surveiller-que-tout-va-bien)
6. [Les règles métier à connaître](#6-les-règles-métier-à-connaître)
7. [Pannes courantes → que faire](#7-pannes-courantes--que-faire)
8. [Opérations manuelles (relancer, régénérer une clé…)](#8-opérations-manuelles)
9. [Les secrets et comment les renouveler](#9-les-secrets-et-comment-les-renouveler)
10. [Glossaire](#10-glossaire)

---

## 1. À quoi sert l'outil (en une page)

**Le problème résolu :** avant, suivre quelles attestations DPC les professionnels de santé
avaient signées (ou pas) demandait d'ouvrir **chaque session Dendreo une par une**, à la main,
dans un Google Sheet. Long, fastidieux, source d'oublis.

**Ce que fait l'outil :** il lit automatiquement les données de Dendreo et affiche, en un coup
d'œil, **qui a signé son attestation et qui reste à relancer**, sur toutes les sessions.

**Les deux écrans principaux :**
- **Sessions** (le cockpit) : la liste des sessions terminées, avec pour chacune le nombre
  d'attestations envoyées / signées / à relancer, plus des filtres (format, dates, EPP…) et un
  export.
- **À relancer** : la liste de travail — **toutes les attestations non signées, toutes sessions
  confondues**, triées de la plus ancienne à la plus récente, avec un lien direct vers Dendreo.

**Important — l'outil est en LECTURE SEULE sur Dendreo.** Il ne modifie jamais rien dans Dendreo :
il lit, il affiche. Les relances elles-mêmes se font dans Dendreo (via le bouton
« Ouvrir dans Dendreo »).

**Adresse de l'outil :** `https://medere-dendreo-dashboard.vercel.app`
**Accès :** connexion Google réservée aux comptes **@medere.fr** (tout autre compte est refusé).

---

## 2. Comment il est construit (vue d'ensemble)

Trois briques, à retenir simplement :

```
   DENDREO (la source de vérité)
       │  lecture seule (clé API)
       ▼
   ┌─────────────────────────────┐
   │   MIROIR (base Firestore)   │   ← une copie des données, tenue à jour
   │   projet: medere-dendreo-   │      automatiquement (voir section 3)
   │   dashboard                 │
   └─────────────────────────────┘
       │  lecture
       ▼
   DASHBOARD (site web sur Vercel)   ← ce que l'équipe consulte
   connexion Google @medere.fr
```

- **Dendreo** = le logiciel de gestion des formations. **La seule source de vérité.**
- **Le miroir** = une copie des informations utiles, stockée dans une base **Firestore**
  (un service de Google/Firebase). On copie pour que le dashboard soit rapide et pour pouvoir
  filtrer/trier instantanément. **Si le miroir était perdu, on le reconstruit entièrement depuis
  Dendreo** (voir [section 8](#8-opérations-manuelles)) — aucune donnée n'est unique au miroir.
- **Le dashboard** = le site web, hébergé sur **Vercel**, qui lit le miroir et l'affiche.

**Le code** vit dans un seul dépôt GitHub : `medere-tech/medere-dendreo-dashboard`.

---

## 3. Comment les données se mettent à jour — le cœur

C'est **le point le plus important** à comprendre. Le miroir est tenu à jour **automatiquement**,
par **trois mécanismes complémentaires**. Personne n'a besoin de lancer quoi que ce soit à la main
au quotidien.

### 3.1 Le webhook — temps réel (les signatures)

Quand un professionnel **signe une attestation** dans Dendreo, Dendreo **prévient l'outil
instantanément** (c'est un « webhook » : une notification automatique). L'outil re-lit alors la
session concernée et met à jour le miroir dans la seconde.

- **Résultat :** dès qu'une signature a lieu, le dashboard la reflète, sans délai, sans
  intervention.
- **Ce que le webhook NE couvre PAS :** Dendreo ne notifie **que les signatures**, pas les
  **envois**. Une attestation tout juste *envoyée* (mais pas encore signée) dans une session où
  personne n'a rien signé n'apparaîtra qu'à la prochaine réconciliation (voir 3.2). C'est une
  limite de Dendreo, pas de l'outil — et le délai (quelques heures) est sans conséquence pour une
  relance.

### 3.2 Le cron nocturne — réconciliation quotidienne

Chaque nuit (vers 3 h, heure de Paris), un programme automatique (**GitHub Actions**) relit
Dendreo pour **l'année en cours et l'année précédente**, et remet le miroir à jour. C'est le filet
qui rattrape ce que le webhook ne voit pas (les envois, les sessions sans activité récente).

- **Pérenne par construction :** les années sont **calculées automatiquement** à partir de la date
  du jour. En 2028, il traitera 2027 et 2028 tout seul. **Aucune année n'est écrite « en dur »**
  (sauf la borne de départ, voir 3.3).

### 3.3 Le cron mensuel — réconciliation complète

Le 1ᵉʳ de chaque mois (vers 4 h, Paris), un second programme relit Dendreo **de l'année 2025
jusqu'à l'année en cours** — une vérification plus large, ceinture et bretelles.

- **La borne de départ « 2025 »** est le **seul** paramètre fixe. Elle définit le périmètre de
  l'outil : les **relances vivantes**. (Des attestations existent dans Dendreo depuis 2022, mais
  celles d'avant 2025 sont considérées caduques et volontairement hors périmètre. Pour les inclure
  un jour, il suffit d'abaisser cette borne — voir le fichier `src/reco/years.ts`, constante
  `RECO_START_YEAR`.)

### En résumé

| Mécanisme | Quand | Ce qu'il couvre |
|---|---|---|
| **Webhook** | À chaque signature (temps réel) | Les signatures, instantanément |
| **Cron nocturne** | Chaque nuit ~3 h | Année en cours + précédente (envois inclus) |
| **Cron mensuel** | 1ᵉʳ du mois ~4 h | 2025 → année en cours (vérification complète) |

**Conclusion : l'outil se tient à jour tout seul.** Un backfill manuel n'est nécessaire que dans
des cas exceptionnels (voir [section 8](#8-opérations-manuelles)).

---

## 4. Les comptes et accès (qui possède quoi)

Pour que l'outil vive indépendamment d'une personne, ces accès doivent appartenir à **Médéré** et
être connus d'**au moins deux personnes**.

| Service | Rôle | Où | À vérifier |
|---|---|---|---|
| **GitHub** | Le code + les crons automatiques | `medere-tech/medere-dendreo-dashboard` | Plusieurs administrateurs Médéré ? |
| **Vercel** | Héberge le site + reçoit le webhook | Compte/organisation Médéré | Accès partagé ? |
| **Firebase** | La base de données (miroir) + la connexion Google | Projet `medere-dendreo-dashboard` | Plusieurs propriétaires ? |
| **Dendreo** | La source de données + la config du webhook | Compte Médéré | Qui gère les webhooks/clés API ? |
| **Google Workspace** | Détermine qui peut se connecter (@medere.fr) | Admin Médéré | — |

> **Recommandation :** s'assurer qu'au moins **deux personnes** de Médéré sont administratrices de
> chaque service. C'est la vraie garantie de continuité — plus que le fait qu'un compte reste ouvert.

---

## 5. Où surveiller que tout va bien

Trois endroits à connaître. Un coup d'œil de temps en temps suffit.

**1. Les crons (GitHub Actions)** — *est-ce que la réconciliation tourne ?*
GitHub → dépôt → onglet **Actions**. Chaque nuit/mois, un run doit apparaître avec une **coche
verte** ✅. Une **croix rouge** ❌ signale un échec → voir [section 7](#7-pannes-courantes--que-faire).

**2. Le webhook (Vercel)** — *est-ce que les signatures arrivent ?*
Vercel → projet → onglet **Logs** (Runtime Logs). On y voit les appels à `/api/webhooks/dendreo`.
Une signature d'attestation produit une ligne avec `matched: true`. Un « Convention → ignoré » est
**normal** (on ne suit que les attestations).

**3. Le quota Firestore** — *reste-t-on dans les limites gratuites ?*
Firebase → projet → **Firestore Database → Usage**. Le plan gratuit (« Spark ») autorise **20 000
écritures et 50 000 lectures par jour**. En usage normal, on est loin du plafond. Si le dashboard
affiche « Données temporairement indisponibles », c'est probablement le quota (voir section 7).

---

## 6. Les règles métier à connaître

Ces règles expliquent **ce que l'outil compte et pourquoi**. Elles ont été validées sur les
données réelles et avec Justine.

- **Ce qu'on suit = les « Attestations ».** Un document compte comme signature à suivre **si son
  nom commence par « Attestation »** et qu'il vise un **participant**. On **exclut** les
  Conventions, lettres de mission, etc. (Détail : `docs/signature-rule.md`.)
- **Par attestation, pas par personne.** Un même participant peut avoir **1 à 3 attestations** sur
  une session (EPP amont, EPP aval, formation continue), signées indépendamment. L'outil compte
  chaque attestation séparément — d'où deux chiffres possibles : « X attestations à relancer » et
  « Y participants concernés ».
- **Deux statuts seulement :** signée / à relancer (envoyée mais pas signée). Règle d'or :
  `signées + à relancer = envoyées`.
- **Sessions affichées dans le cockpit :** uniquement les sessions **terminées** (date de fin ≤
  aujourd'hui, heure de Paris) et **hors « Échec »**. Une session qui se termine aujourd'hui
  apparaît à **00 h**.
- **La vue « À relancer »** couvre **toutes les sessions (même en cours) sauf les « Échec »** —
  parce qu'une attestation peut partir dès la fin d'un module, avant la fin de la session.

---

## 7. Pannes courantes → que faire

Format : **symptôme → cause probable → action**. Commence toujours par identifier le symptôme exact.

### 🔴 Le dashboard affiche « Données temporairement indisponibles » / une page d'erreur
- **Cause la plus probable :** quota Firestore (lectures) épuisé pour la journée.
- **Vérifier :** Firebase → Firestore → Usage (section 5, point 3).
- **Action :** le quota se réinitialise chaque jour (vers 9 h, heure de Paris). Si le problème est
  récurrent, envisager de passer Firebase en plan **Blaze** (payant à l'usage, souvent quelques
  centimes — on ne paie que le dépassement du quota gratuit).

### 🔴 Un run GitHub Actions (cron) est en rouge ❌
- **Ouvrir** le run (GitHub → Actions → cliquer dessus → cliquer le job → dérouler l'étape rouge).
- **Si le message contient `RESOURCE_EXHAUSTED` / `Quota exceeded`** → c'est le quota Firestore,
  **ce n'est pas grave** : le backfill s'arrête proprement et reprend au run suivant. (Le workflow
  est conçu pour transformer ça en simple avertissement, pas en échec.)
- **Si le message contient `permission denied` / une erreur d'authentification** → un **secret**
  GitHub est manquant ou expiré (souvent `FIREBASE_PRIVATE_KEY` mal collé). → Voir
  [section 9](#9-les-secrets-et-comment-les-renouveler).
- **Autre erreur** → noter le message et le transmettre à un développeur.

### 🔴 Le webhook renvoie une erreur (visible dans les logs Vercel ou côté Dendreo)
- **Code `401`** → la vérification de signature échoue → la clé secrète du webhook ne correspond
  plus. Cause typique : la clé a été régénérée dans Dendreo mais pas mise à jour dans Vercel (ou
  l'inverse). → Réaligner `DENDREO_WEBHOOK_SECRET` (section 9), puis **redéployer**.
- **Code `500`** → l'outil plante côté serveur, souvent un secret Firebase mal collé sur Vercel.
  → Vérifier les variables d'environnement Vercel (section 9).
- **Code `200` avec « ignored »** → **ce n'est pas une erreur** : le document n'était pas une
  attestation (ex. une Convention), l'outil l'a correctement ignoré.

### 🟠 Une session récente ou une signature n'apparaît pas
- **D'abord :** est-ce une **signature** ? Elle devrait apparaître en temps réel (webhook). Vérifier
  les logs Vercel qu'elle est bien arrivée.
- **Est-ce un simple envoi** (pas encore signé) dans une session sans activité ? → normal, il
  apparaîtra à la prochaine réconciliation nocturne.
- **Pour forcer une mise à jour immédiate :** lancer un backfill manuel (section 8) ou
  re-déclencher le cron nocturne à la main (GitHub → Actions → le workflow → « Run workflow »).

### 🟠 Le dashboard s'affiche mais tout est vide / en erreur après une opération
- Souvent une réconciliation interrompue. **L'affichage ne plante jamais** (protections en place),
  mais des compteurs peuvent être à zéro temporairement. → Relancer un backfill complet (section 8)
  remet tout d'aplomb.

---

## 8. Opérations manuelles

À utiliser **exceptionnellement** — l'outil se met à jour seul en temps normal. Ces opérations se
lancent sur un ordinateur avec le code du dépôt installé (voir un développeur si besoin).

### Relancer la réconciliation à la main (sans ordinateur)
Le plus simple : **GitHub → onglet Actions → « Backfill nocturne » → bouton « Run workflow »**.
Ça relance la réconciliation immédiatement, sur les serveurs de GitHub. Résultat en quelques minutes.

### Relancer un backfill depuis un poste développeur
Depuis le dossier du projet :
```
npm run backfill -- --year 2025 --force
npm run backfill -- --year 2026 --force
npx tsx scripts/verify-coverage.mjs      # vérifie que tout est cohérent
```
> ⚠️ Toujours cibler avec `--year` (ex. 2025, 2026). Ne **jamais** lancer `--force` seul : cela
> re-balaierait tout l'historique jusqu'en 2015 et ramènerait des données inutiles.
> Le backfill est **reprenable** : s'il atteint le quota Firestore, il s'arrête proprement et on le
> relance le lendemain.

### Reconstruire entièrement le miroir (cas extrême)
Si le miroir est corrompu, on peut le vider et le reconstruire depuis Dendreo (aucune perte : la
source de vérité est Dendreo). Voir `scripts/clear-mirror.mjs` (protégé : ne supprime rien sans
l'option `--confirm`). **À faire par un développeur, avec précaution.**

---

## 9. Les secrets et comment les renouveler

Les « secrets » sont les clés d'accès (Dendreo, Firebase). Ils sont stockés **à deux endroits** et
ne doivent **jamais** apparaître dans le code, dans une capture d'écran, ni dans un message.

| Secret | Où il est utilisé | Stocké dans |
|---|---|---|
| `DENDREO_API_KEY` | Lire Dendreo | Vercel **et** GitHub |
| `DENDREO_BASE_URL` | Adresse de l'API Dendreo | Vercel **et** GitHub |
| `DENDREO_WEBHOOK_SECRET` | Vérifier le webhook | **Vercel uniquement** |
| `FIREBASE_PROJECT_ID` | Écrire dans le miroir | Vercel **et** GitHub |
| `FIREBASE_CLIENT_EMAIL` | Écrire dans le miroir | Vercel **et** GitHub |
| `FIREBASE_PRIVATE_KEY` | Écrire dans le miroir | Vercel **et** GitHub |

- **Où les gérer :**
  - Vercel : projet → Settings → Environment Variables.
  - GitHub : dépôt → Settings → Secrets and variables → Actions.
  - Firebase (générer un nouveau fichier de clés) : Paramètres du projet → Comptes de service →
    « Générer une nouvelle clé privée » (télécharge un fichier JSON contenant `project_id`,
    `client_email`, `private_key`).

- **Collage de `FIREBASE_PRIVATE_KEY` :** copier la valeur telle quelle, **avec ses `\n`**, sans
  guillemets autour, sans double-échapper. Le code convertit les `\n` automatiquement.

- **Ne jamais définir `FIRESTORE_EMULATOR_HOST`** dans Vercel ou GitHub. Cette variable ne sert
  qu'aux tests ; en production, elle ferait écrire l'outil « dans le vide ».

### Régénérer la clé secrète du webhook (recommandé une fois)
1. Dendreo → page Webhooks → régénérer la **clé secrète**.
2. Copier la nouvelle clé → Vercel → `DENDREO_WEBHOOK_SECRET` → **Edit** → coller → Save.
3. **Redéployer** le site (Vercel → Deployments → dernier → « … » → Redeploy).
4. Tester : Dendreo → « Tester ce Webhook » → doit renvoyer **200**.

---

## 10. Glossaire

- **Dendreo** — le logiciel de gestion des formations de Médéré. La source de vérité.
- **Miroir** — la copie des données de Dendreo, stockée dans Firestore, qu'affiche le dashboard.
- **Firestore / Firebase** — la base de données (service Google) qui héberge le miroir et gère la
  connexion Google @medere.fr.
- **Vercel** — l'hébergeur du site web et du point d'entrée du webhook.
- **GitHub Actions** — le service qui exécute les réconciliations automatiques (crons), sur les
  serveurs de GitHub.
- **Webhook** — une notification automatique envoyée par Dendreo à l'outil quand un événement se
  produit (ici : une signature).
- **Cron** — une tâche planifiée qui s'exécute automatiquement à heure fixe (chaque nuit / chaque
  mois).
- **Backfill** — l'opération qui (re)lit Dendreo et (re)remplit le miroir.
- **Réconciliation** — synonyme de backfill : remettre le miroir en accord avec Dendreo.
- **Attestation** — le document DPC que le professionnel doit signer ; ce que l'outil suit.
- **EPP amont / aval** — les deux temps d'une évaluation des pratiques professionnelles ; chacun
  peut donner lieu à une attestation distincte.
- **Session « Échec »** — une session non tenue/annulée dans Dendreo ; exclue de l'outil.
- **À cheval** — une session qui commence une année et se termine l'année suivante.
- **Quota Firestore** — les limites gratuites du plan Firebase (20 000 écritures / 50 000 lectures
  par jour).

---

### Documents techniques associés (dans le dépôt, dossier `docs/`)
- `signature-rule.md` — la règle exacte de ce qui compte comme attestation (fait autorité).
- `firestore-model.md` — la structure des données du miroir.
- `architecture.md` — l'architecture technique détaillée.
- `webhook-recon.md` — le fonctionnement du webhook Dendreo.
- `ui-spec.md`, `design-system.md` — l'interface et la charte visuelle.

---

*Ce runbook décrit le fonctionnement de l'outil au moment de sa rédaction. Si l'architecture évolue
(nouveaux crons, changement d'hébergeur, etc.), pense à le mettre à jour — c'est le document que
liront celles et ceux qui reprendront l'outil.*
