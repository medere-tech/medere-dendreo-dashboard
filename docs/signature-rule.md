# docs/signature-rule.md — RÈGLE SIGNATURE (fait autorité)

> ⚠️ Ce document **remplace** l'ancienne logique « doctype 111 / notSent / expectAllEnrolled »
> présente dans `architecture.md`, `firestore-model.md`, `dendreo-api.md`. En cas de contradiction,
> **c'est ce fichier qui gagne.** Confirmé par Justine + prouvé par `scripts/inspect-doctypes.mjs`.

---

## 1. Quel document on suit

Une **attestation à suivre** = un fichier de la collection `signature` (via `fichiers.php`) tel que :
- le **nom du document commence par « Attestation »** (normalisé : minuscules, sans accents, `trim`), **ET**
- **cible = Participant** (`entite_liee.type == "Participant"`).

**On EXCLUT** tout le reste : Convention_Participant (doctype 111), LettredeMission (79, Formateur), Convention_Ent (62, Entreprise), et tout document ne commençant pas par « Attestation ».

**Pourquoi par le nom et pas par l'ID :** robuste au temps. Une future « Attestation … 2027 » (nouveau doctype) sera captée automatiquement, sans changement de code. Les doctypes constatés aujourd'hui qui matchent : **165, 166, 173, 177**.

## 2. Granularité : par attestation, pas par participant

Sur **une même session**, un participant peut recevoir **1, 2 ou 3** attestations, une par module « non connecté » suivi :
- Attestation **EPP amont** (constaté : doctype 165),
- Attestation **EPP aval** (166),
- Attestation **formation continue / PI** (177, 173…).

Chaque attestation se signe **indépendamment**. Un même participant peut être **signé sur l'une et à relancer sur une autre**, dans la même session. ⇒ **L'unité de suivi = l'attestation**, pas la personne.

## 3. Statuts : 2 seulement (plus de « notSent »)

On ne compte **que ce que Dendreo a réellement envoyé**. Le « pas encore envoyé » (notSent) est **supprimé** — il fabriquait des fantômes. Plus besoin de `laps.php` pour le statut.

Pour chaque attestation trackée :
- **signée** = `signature_date` non vide,
- **non signée (à relancer)** = envoyée, `signature_date` vide.

## 4. Compteurs par session (les DEUX, côte à côte)

- **envoyes** = nb d'attestations trackées envoyées (le total qui compte),
- **signes** = parmi envoyées, signées,
- **nonSignes** = `envoyes − signes` (= à relancer),
- **participantsConcernes** = nb de participants distincts ayant ≥ 1 attestation trackée,
- **participantsARelancer** = nb de participants distincts avec ≥ 1 attestation non signée.

**Invariant garanti :** `signes + nonSignes == envoyes`. (Vérifiable ligne à ligne contre Dendreo.)

### 4 bis. Ventilation par BLOC (S18) — amont+cœur vs aval

Pour l'onglet Sheet des sessions **à cheval 26/27**, chaque session porte en plus :

- **amontCoeur** = `{ signes, total }` des attestations dont le bloc **n'est PAS** `aval` ;
- **aval** = `{ signes, total }` des attestations dont le bloc **est** `aval`.

**Le bloc se lit dans le NOM du document** (`src/core/attestation-name.ts`, prouvé sur les
sessions 3117 et 3818) : nom normalisé contenant `amont` → `amont` ; sinon `aval` → `aval` ;
sinon → `coeur`. **`amont` est testé AVANT `aval`** : un nom portant les deux marqueurs part
en `amont`, de façon déterministe.

⚠️ **`coeur` est un DÉFAUT, pas une preuve.** Aucun nom réel ne contient le mot « cœur » : un
nom sans marqueur signifie seulement « ni amont ni aval ». Ces attestations tombent donc dans
**amontCoeur** — c'est le côté sûr pour l'onglet à cheval, mais c'est un choix, pas une neutralité.

**Invariant garanti :** `amontCoeur.total + aval.total == envoyes` (et idem sur `signes`).
Structurellement vrai : chaque ligne tombe dans exactement un des deux blocs.

**Source du calcul** : `recalcSessionCounts` **re-dérive** le bloc depuis `documentName` à
chaque recalc, dans la MÊME transaction et le MÊME snapshot que les 5 compteurs (0 lecture
Firestore ajoutée, 0 appel Dendreo). Il ne lit **pas** le champ `bloc` persisté sur la ligne —
c'est ce qui rend les documents écrits avant S18 corrects **sans migration**. Le champ `bloc`
de `signatures/*` reste écrit par les mappers (`sync.ts`, `backfill.mjs`) pour l'affichage par
ligne et les futurs filtres Firestore.

**Affichage** : côté équipe, on montre le volume de **documents** (envoyés/signés/à relancer) ET le nombre de **participants** concernés/à relancer — les deux côte à côte, **jamais superposés/tassés**.

## 5. Dédup

Clé par `(idAdf, idParticipant, doctypeId)`. Si doublon exact d'un même document pour un participant → dédupliquer, **garder le signé** s'il existe, sinon le plus récent.

## 5 bis. Purge des fantômes (S17.4) — quand une ligne du miroir est SUPPRIMÉE

Un **fantôme** = une ligne de `signatures` qui n'existe **plus** côté Dendreo (attestation annulée, participant désinscrit, document re-généré sous une autre clé). Sans purge, elle reste comptée `pending` **pour toujours** : le cockpit affiche des relances qui n'existent pas.

**Critère de suppression — verrouillé, ne pas élargir.**
On supprime `signatures/{idAdf}_{idParticipant}_{doctypeId}` **si et seulement si** :
1. la clé est **ABSENTE** de la réponse `fichiers.php` du sync **en cours**, **ET**
2. le `status` au miroir est **`pending`**.

Le critère ne regarde **ni** le participant, **ni** l'assiduité, **ni** l'inscription : uniquement **la clé et le statut**.

**JAMAIS un `signed`.** Une attestation signée est une **preuve de conformité**. Disparue de la source, c'est une **anomalie à signaler** (`[PURGE ANOMALIE — NON SUPPRIMÉE]`), jamais à effacer. Idem pour tout `status` inattendu : seul le littéral `pending` est supprimable.

**Garde-fous — on ne purge que sur une réponse Dendreo FIABLE.** Le cron tourne sans surveillance et une suppression Firestore est irréversible : au moindre doute, la purge est **entièrement sautée** pour cette session (0 suppression, docs gardés) et le sync **continue normalement** — il écrit ce qu'il a récupéré. Cas de skip :

| Situation | Pourquoi c'est suspect |
|---|---|
| Réponse **vide** alors que le miroir a des docs | hoquet API — tout ressemblerait à un fantôme |
| Réponse **< 50 %** des docs du miroir | réponse partielle probable |
| Lignes **sans `doctype_id`** dans la réponse | jeu de clés incomplet (cf. §2) → un vrai document passerait pour un fantôme |
| Miroir **illisible** (erreur Firestore) | on ne compare rien |
| Appel `fichiers.php` **KO** (HTTP ≠ 200) | le sync s'interrompt avant : la purge n'est jamais atteinte |

La purge **ne peut pas faire échouer un sync** : toute erreur (y compris une suppression refusée) est capturée et loggée, jamais propagée.

**Où elle tourne.** Dans `syncSession` / `backfill`, **après** l'upsert des attestations renvoyées et **avant** `recalcSessionCounts` — les compteurs du cockpit sont donc calculés sur un miroir **déjà nettoyé**, en une seule passe. Elle réutilise la réponse `fichiers.php` déjà récupérée : **zéro appel Dendreo ajouté**.

**Activation** : **cron nocturne uniquement** (`backfill --purge`). Pas le webhook (événement isolé, non supervisé), pas le cron mensuel. Cf. `docs/RUNBOOK.md` §3.2.

Implémentation : `purgeGhostSignatures` (`src/dendreo/sync.ts`), partagée sync + backfill. Équivalent manuel et ciblé : `scripts/purge-fantomes.mjs` (dry-run par défaut).

## 6. Cible de réconciliation (preuve)

La session de l'image Dendreo « Attestation sur l'honneur PI_2026 » : **6 envoyés · 5 signés · 1 à relancer**. Notre calcul doit retomber **exactement** là-dessus.

## 7. Fonctionnalité « clic → liste » (premium, demandée par Justine)

Chaque compteur est **cliquable** et ouvre la **liste des participants concernés par ce chiffre** :
- clic **Signés** → qui a signé (+ date, + lien de visualisation),
- clic **À relancer** → qui reste (+ depuis quand, + lien direct de relance),
- clic **Envoyés** → tout le monde à qui l'attestation est partie.

Premium : panneau qui **glisse** (drawer), aucun rechargement, recherche dans la liste, lien direct par ligne, fermeture au clavier (Échap). C'est le geste quotidien ops/CSM : voir « 9 à relancer » → cliquer → 9 noms + liens → relancer.

## 8. Impact (changement de RÈGLE, pas d'architecture)

- Couche S1 (`signatures.ts`) : filtrer sur le **nom « Attestation »** (normalisé) + cible Participant ; supprimer `notSent`/`expectAllEnrolled` ; statut envoyé → signé/non-signé. **Simplification** : `laps.php` n'est plus requis pour le statut.
- Miroir : compteurs session `{ envoyes, signes, nonSignes, participantsConcernes, participantsARelancer }` ; docs signature avec `documentName`, `status ∈ {signed, pending}`.
- Backfill : re-run **2026 ET 2025** (2025 devient enfin exploitable : attestations, pas Convention).
- UI : bloc chiffres ré-agencé (aéré) + drawer cliquable.
