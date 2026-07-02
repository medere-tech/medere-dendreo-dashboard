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

**Affichage** : côté équipe, on montre le volume de **documents** (envoyés/signés/à relancer) ET le nombre de **participants** concernés/à relancer — les deux côte à côte, **jamais superposés/tassés**.

## 5. Dédup

Clé par `(idAdf, idParticipant, doctypeId)`. Si doublon exact d'un même document pour un participant → dédupliquer, **garder le signé** s'il existe, sinon le plus récent.

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
