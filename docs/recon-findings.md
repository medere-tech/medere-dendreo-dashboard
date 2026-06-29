# docs/recon-findings.md — Résultats S0 (Reconnaissance)

> Réponses **réelles** aux 3 inconnues, obtenues par appels **lecture seule** (GET)
> via `scripts/recon.mjs`. Clé API jamais affichée (rédigée `***`). PII anonymisée
> en initiales. Date du run : **2026-06-29**. Centre : SAS MEDERE.
>
> **Statut : les 3 inconnues sont levées.** Il reste 2 questions de cadrage métier
> (pour Justine) + 1 relevé UI (quota), tous **non bloquants** pour démarrer S1.

---

## 0. Résumé exécutif (TL;DR)

| Sujet | Verdict |
|---|---|
| **Centres** | 2 centres existent (SAS MEDERE id=1, MEDEOR id=2) mais **100 % du scope 2026 est sur le centre 1** → **mono-centre en pratique**. |
| **Volume 2026** | **399** sessions « entièrement dans 2026 » ; **660** sessions « qui chevauchent 2026 » → **le ~659 du brief = filtre de chevauchement**. 365 en étape *Réalisation*. 100 % `inter`. |
| **Inconnue 1 — connecté/non connecté** | 🟡 **Scénario B** : pas `mode_organisation` (identique partout), mais porté par **`c_nombre_dheures_non_connectees > 0`** (≡ modules EPP/audit clinique) vs `c_nombre_dheures_connectees > 0` (≡ e-learning « EL »). **MAIS** : non nécessaire pour le dashboard (voir §3). |
| **Inconnue 2 — statut signé** | ✅ **`fichiers.php?cible=action-de-formation&id_cible={ADF}&collection_name=signature`**. **SIGNÉ = `signature_date` non vide**, EN ATTENTE = vide. Prouvé sur 14 signés / 6 en attente réels. |
| **Inconnue 3 — document « même nom »** | ✅ Identifié de façon fiable par **`collection_name="signature"` + `doctype_id`** (+ `name`). Doc participant observé : `Convention_Participant_Formation_Médéré` (**doctype_id=111**). |
| **Source primaire data** | **`fichiers.php`** (1 appel/session = signés + en attente + qui + quand). `taches.php` = contrôle croisé. |
| **Coût sync** | ~**1 + N** requêtes (N = sessions actives). Full reco ≈ **366 req** (365 actives). Très en deçà des quotas. |

---

## 1. Méthode & sécurité

- 8 sondes lecture seule (`scripts/recon.mjs`), **GET uniquement**, header `Authorization: Token token="***"`.
- Clé chargée depuis `.env.local` (20 caractères), **jamais imprimée** : `redact()` remplace toute occurrence par `***` (URLs, erreurs, `err.message`).
- `.env.local` est dans `.gitignore` (`git check-ignore .env.local` → confirmé) — **jamais commité**.
- Requêtes consommées sur l'ensemble de la reconnaissance : **~50** (cumul des runs), aucune écriture.

---

## 2. Centres & volume des sessions 2026

### Centres (`centres_de_formation.php`)
```json
[ { "id": "1", "raison_sociale": "SAS MEDERE" },
  { "id": "2", "raison_sociale": "MEDEOR" } ]
```
→ 2 centres, mais **toutes les sessions 2026 du scope sont sur le centre 1**. MEDEOR : 0 session dans le périmètre. **On traite mono-centre**, en gardant à l'esprit que le multi-centres existe (filtrage `id_centre_de_formation` à prévoir si MEDEOR s'active).

### Volume (`actions_de_formation.php`, filtres date explicites)
- **(A)** `started_after=2026-01-01 & ended_before=2026-12-31` → **399** sessions (entièrement contenues dans 2026).
- **(B)** `started_before=2026-12-31 & ended_after=2026-01-01` → **660** sessions (qui **chevauchent** 2026). **≈ le « ~659 » du brief.**
- ⇒ **Le chiffre métier de référence (~659) = le filtre de chevauchement (B).** Le piège `actions_de_formation.php` (défaut = dernière année) est neutralisé par les filtres explicites.

### Étapes (filtre A)
| `id_etape_process` | libellé | nb |
|---|---|---|
| 6 | Réalisation | 365 |
| 9 | Echec | 34 |

`etapes.php` liste les libellés **en double** (Réalisation = id 2 **et** 6 ; Echec = 4 **et** 9 ; etc.) → un jeu d'étapes par centre. **Pour le centre 1 : Réalisation = `id_etape_process=6`, Echec = 9.** Population « active » à suivre = **étape 6**.

---

## 3. INCONNUE n°1 — « connecté / non connecté » 🟡 (scénario B)

Session témoin : **`ADF_20260316`** (id=3894), module **composé** (`master_lam_id=1926`), 3 sous-modules :

| `id_lam` | `id_module` | `intitule_court` | `mode_organisation` | h_connectées | **h_non_connectées** | `id_categorie_module` |
|---|---|---|---|---|---|---|
| 8366 | 1221 | `2026_Ménopause_EL_4h` (cœur e-learning) | elearning_async | **4** | 0 | 7 |
| 8365 | 1219 | `2026_Ménopause_EPP amont_2h` | elearning_async | 0 | **2** | 22 |
| 8367 | 1220 | `2026_Ménopause_EPP aval_2h` | elearning_async | 0 | **2** | 21 |

**Constats :**
- `mode_organisation` est **identique** (`elearning_async`) sur les 3 → **ce n'est PAS le discriminant**.
- La notion vit dans **`c_nombre_dheures_connectees` vs `c_nombre_dheures_non_connectees`** (vocabulaire DPC/ANDPC) :
  - **CONNECTÉ** = unité tracée par la plateforme e-learning (`c_nombre_dheures_connectees > 0`) → module « EL ».
  - **NON CONNECTÉ** = activité non tracée, ex. **EPP / audit clinique** (`c_nombre_dheures_non_connectees > 0`) → modules « EPP amont/aval ».
- Discriminant secondaire concordant : `id_categorie_module` (7 = EL connecté ; 21/22 = EPP non connecté). À confirmer qu'il est stable sur tout le catalogue.
- ⚠️ Le « 0h non connectées » sur un module connecté est un **découpage administratif ANDPC** (cf. note métier Damien), pas le temps réellement passé.

**Pourquoi 🟡 B et pas 🟢 A :** il y a bien des champs natifs nets, mais (a) ce sont des champs DPC (pas un booléen « connecté »), et (b) la règle reste à valider sur des formations **non-DPC** (où `eligible_dpc=0`, les heures connectées/non connectées peuvent être à 0).

**⚠️ Découverte qui change la donne :** le document de signature est **par participant × session** (la « Convention »), **pas par sous-module non connecté**. Session 3894 = 2 modules non connectés mais **1 seule Convention par participant** (3 participants → 3 docs). ⇒ **Le dashboard n'a PAS besoin de résoudre connecté/non connecté** : il suit directement les docs de la collection `signature` par session (voir §4). La distinction module devient **informative**, utile seulement si Justine veut filtrer par type de doc/module.

---

## 4. INCONNUE n°2 — statut « signé » via `fichiers.php` ✅

### Requête exacte (paramètres confirmés sur données réelles)
```
GET /fichiers.php?cible=action-de-formation&id_cible={id_action_de_formation}&collection_name=signature
```
- `cible` = **`action-de-formation`** (avec tirets — PAS `ActionDeFormation` ni `action_de_formation`).
- `collection_name` = **`signature`** (PAS `signature_electronique`).
- SHOW d'un média précis : `GET /fichiers.php?id={id_media}`.
- ⚠️ Sans `cible`/`collection_name`, l'API répond `422` (« le paramètre id_fichier ou cible est requis ») ou 0 résultat → **toujours passer `cible` + `collection_name`**.

### Champs clés d'un objet fichier/média
`id`, `uuid`, `collection_name`, `name`, `mime_type`, `doctype_id`, **`signature_date`**, `related_media_id`, `created_at`, `cible`, `id_cible`, `public_url`, **`entite_liee`** (objet `{ Participant|Formateur: {...} }`).

### Règle de statut (prouvée)
- **SIGNÉ** ⇔ `signature_date` **non vide** (ex. `"2026-02-17T11:27:05.000000Z"`).
- **À RELANCER** ⇔ `signature_date` **vide** (`""`).
- **Ancienneté / priorité de relance** = `created_at` du doc (date d'émission) — recoupe le champ `date` de `taches.php`.
- **Qui** = `entite_liee.Participant.id_participant` (+ nom/prénom dispo dans l'objet, à anonymiser à l'affichage selon besoin).

### Échantillon réel anonymisé — `id_cible=3686`, collection `signature` (20 docs : 14 signés / 6 en attente)
```json
[
  { "id":"117263","name":"Convention_Participant_Formation_Médéré","doctype_id":"111",
    "signature_date":"2026-02-17T11:27:05Z","signe":true,  "created_at":"2026-02-17",
    "entite_liee":{"type":"Participant","id_participant":"450439","initiales":"A.N."} },
  { "id":"130868","name":"Convention_Participant_Formation_Médéré","doctype_id":"111",
    "signature_date":"","signe":false, "created_at":"2026-06-07",
    "entite_liee":{"type":"Participant","id_participant":"452275","initiales":"G.L."} },
  { "id":"130764","name":"LettredeMission_Form_formation_Médéré","doctype_id":"79",
    "signature_date":"2026-06-06T21:36:16Z","signe":true,
    "entite_liee":{"type":"Formateur","initiales":"I.B."} }
]
```
> Contrôle croisé OK : le média `130868` (`signature_date` vide) est exactement celui que `taches.php?types=esignature-doc` renvoyait comme **en attente** pour le participant 452275.

---

## 5. INCONNUE n°3 — le document « même nom » ✅

- **Identification fiable et répétable** : `collection_name="signature"` **+ `doctype_id`**. Le `doctype_id` est l'**identifiant stable du modèle** (le « même nom »), insensible aux variantes d'intitulé.
- Doctypes observés dans la collection `signature` :
  - **`doctype_id=111` → `Convention_Participant_Formation_Médéré`** = le document **signé par chaque participant** (notre cible probable).
  - `doctype_id=79` → `LettredeMission_Form_formation_Médéré` = signé par le **Formateur** (hors scope « participants »).
- ⚠️ `taches.php` renvoie un intitulé **générique** (« Signature électronique d'un document ») qui ne suffit pas à identifier le doc → **c'est `fichiers.php` qui donne le `name`/`doctype_id` réels**.
- ❓ **À confirmer avec Justine** : le doc à suivre = **la Convention (doctype 111)** ? ou existe-t-il une **« attestation sur l'honneur »** distincte (doctype non observé sur 3686/3894) à tracker pour les modules non connectés ? Sur nos 2 sessions témoins, **seuls** Convention (111) + LettreDeMission (79) apparaissent.

---

## 6. Architecture de données recommandée (proposition pour S1, à valider)

**Source primaire = `fichiers.php` (collection `signature`), 1 appel par session active :**
1. `actions_de_formation.php` (filtre chevauchement + `id_etape_process=6`) → liste des sessions actives.
2. Pour chaque session : `fichiers.php?cible=action-de-formation&id_cible={ADF}&collection_name=signature`
   → on dérive directement : nb attendus (docs émis), signés (`signature_date` rempli), à relancer (vide, triés par `created_at`), avec lien participant + `public_url`.
3. (Option) `participants.php?id={batch}` pour enrichir noms/emails si besoin d'affichage.

**Contrôles / temps réel :**
- `taches.php?types=esignature-doc` = contrôle croisé du « en attente » (participant-scoped).
- **Webhook « document signé »** (à câbler en sprint ultérieur) pour le temps réel ; réconciliation périodique via le point 2.

> ⚠️ Filtres incrémentaux : `fichiers.php` accepte `updated_after`/`created_after`, mais **exige une `cible`** → pas de « tous les signés récents » global ; l'incrémental reste **par session**. Le webhook couvre le temps réel.

---

## 7. Coût requêtes & marge de quota (Or)

**Quotas connus (doc)** : burst 100 req/10 s ; 100 000 req/jour ; **mensuel limité (Or)** — chiffre exact **non exposé par l'API** (aucun header de quota observé sur les réponses).

**Coût d'une synchro complète** (source primaire ci-dessus) :
- 1 (liste sessions) + **365** (fichiers, sessions en Réalisation) ≈ **~366 requêtes**.
- Variante « toutes sessions chevauchant 2026 » : ~**661** requêtes.
- À 100 req/10 s, une full reco prend **~37 s à ~66 s** (avec throttling de courtoisie).

**Projection mensuelle (à confirmer une fois le quota Or connu) :**
- Full reco **toutes les heures** : 366 × 24 × 30 ≈ **264 k/mois**.
- Full reco **4×/jour** : 366 × 4 × 30 ≈ **44 k/mois**.
- Full reco **1×/jour** + webhooks temps réel : 366 × 30 ≈ **11 k/mois**. ✅ **Stratégie recommandée.**

**🔧 À relever côté UI Dendreo (page config API)** : quota mensuel total + conso courante → pour fixer la fréquence de sync sans risque de `429`.

---

## 8. Angles morts / surprises

1. **Multi-centres** : 2 centres existent. Scope 2026 = centre 1 uniquement, mais prévoir le filtre `id_centre_de_formation` (robustesse si MEDEOR s'active).
2. **399 vs 660** : bien distinguer « contenu dans 2026 » (A) vs « chevauche 2026 » (B = chiffre métier). Choisir explicitement la population à synchroniser en S1.
3. **`taches.php` est participant-scoped** : il renvoie les signatures de **toutes les ADF** du participant, pas d'une session → toujours filtrer par `id_adf`. Ne pas l'utiliser comme source de vérité « par session » (préférer `fichiers.php`).
4. **Plusieurs docs par participant** possibles dans une session (ré-émissions / docs multiples) — ex. un même participant apparaît 2× (1 signé + 1 en attente). La logique « à relancer » doit gérer les **doublons par (participant, doctype)** et l'historique.
5. **`name` ≠ stable à 100 %** : préférer **`doctype_id`** comme clé d'identification du modèle (le `name` peut varier ; `doctype_id` est l'ancre).
6. **Docs Formateur** (`LettredeMission`, doctype 79) mélangés dans la même collection `signature` → **filtrer sur `entite_liee.type="Participant"`** (et/ou doctype) pour ne pas compter le formateur comme « à relancer ».
7. **Participants sans doc émis** : `fichiers.php` ne montre que les docs **déjà générés**. Un participant pour qui rien n'a encore été envoyé n'apparaît pas (≠ « à relancer »). À clarifier si on veut une catégorie « pas encore envoyé ».
8. **PII** : `fichiers.php` (et `laps.php?include=participant`) renvoient des fiches participant complètes (email, tel, adresse, RPPS). À ne **jamais** logger en clair ; stockage Firestore minimal + accès restreint (Firebase Auth équipe).
9. **Quota Or mensuel inconnu** (non exposé par l'API) → à relever en UI avant de fixer la fréquence de sync.

---

## 9. Questions ouvertes (cadrage, non bloquant)

1. **Pour Justine** — le document à suivre = la **Convention (doctype_id=111)** signée par chaque participant ? Ou une **attestation sur l'honneur** spécifique aux modules non connectés (doctype non observé sur nos 2 témoins) ? → fige le filtre `doctype_id` en S1.
2. **Pour Justine / archi** — population cible du dashboard : **365 sessions en Réalisation** (étape 6) ? ou les **~660 chevauchant 2026** ? ou autre (ex. inclure « À facturer ») ?
3. **Pour Déthié (UI)** — relever le **quota mensuel Or** + conso courante (page config API Dendreo).
4. **Visibilité utilisateurs** (pôle opérationnel vs CSM) — tout le monde voit tout, ou filtré ? (déjà noté non bloquant S0).

---

## 10. Décision attendue

Valider (a) la **source primaire `fichiers.php`/collection `signature`**, (b) le **statut par `signature_date`**, (c) la **population cible**, (d) le **doctype à suivre**, avant d'ouvrir **S1 (build)**. **Aucune ligne de logique métier n'est figée tant que ce n'est pas validé.**
