# docs/recon-s5-findings.md — DISCOVERY S5.0 phase 2 (lecture seule)

> Réponses **réelles** à 4 points, obtenues par appels **GET** Dendreo + lecture
> Firestore (miroir, `.get()` seulement). **Aucune écriture nulle part.** Clé API
> jamais affichée (client `redact`). PII non imprimée (niveau session/module).
> Scripts jetables : `scripts/recon-s5.mjs`, `recon-s5-p2.mjs`, `recon-s5-p2b.mjs`,
> `recon-s5-p3.mjs`. Date du run : **2026-07-06**. web_base : `https://pro.dendreo.com/nes_formation`.
>
> ⚠️ **Rien n'est tranché unilatéralement.** Les points ambigus sont signalés
> comme « À CONFIRMER par Déthié/Justine » — pas de supposition figée.

---

## 0. Ce qu'il faut décider (TL;DR)

| # | Sujet | Verdict data | Ce qui reste à trancher |
|---|-------|--------------|--------------------------|
| 1 | **Format** | `mode_organisation` **existe au niveau session**, 4 valeurs réelles : `presentiel`, `elearning_async`, `elearning_sync`, `mixte`. Suffit seul. | Le mapping « classe virtuelle ». Candidat fort : `elearning_sync` (corroboré par `_CV_` dans les intitulés). |
| 2 | **N° compte produit « gris »** | ADF.`numero_comptable` **vide dans ~97 % des sessions DPC**. Le gris = **`num_programme_dpc`** (11 chiffres) porté par le **MODULE** (`modules.php`). | Sur session composée, les modules portent **plusieurs** `num_programme_dpc` différents. `is_master_module=0` partout → l'API ne désigne pas « le bon » seule. |
| 3 | **EPP amont/aval connecté** | Module amont = **`id_categorie_module=22`**, aval = **`21`** (stable /18 sessions). Champ heures connectées = **`c_nombre_dheures_connectees`** (sur `modules.php`). | La règle « connectées > 0 » **est valide et discriminante** (exemples réels des deux côtés). Confirmer la sémantique « connecté ». |
| 4 | **URL suivi-signatures** | `id_action_de_formation=2656` = bien CBCT. Patron confirmé. | RAS. web_base = `https://pro.dendreo.com/nes_formation` (sans `/api`). |

---

## 1. FORMAT — nouvelle colonne « Format »

### Le champ existe au niveau SESSION
`actions_de_formation.php` renvoie **`mode_organisation`** directement sur l'ADF
(pas besoin de le dériver des modules).

### Valeurs DISTINCTES réelles (chevauchement d'année) + counts

| `mode_organisation` (session) | 2025 (n=1014) | 2026 (n=680) |
|---|---|---|
| `elearning_async` | 547 | 321 |
| `mixte`           | 376 | 335 |
| `presentiel`      | 55  | 14  |
| `elearning_sync`  | 36  | 10  |

→ **exactement 4 valeurs**, jamais vide. Aucune valeur `distanciel` n'existe.

### Mapping proposé vers les 4 libellés (à CONFIRMER par Justine)

| Libellé cible | Valeur Dendreo | Confiance |
|---|---|---|
| **Présentiel** | `presentiel` | ✅ certain |
| **Mixte** | `mixte` | ✅ certain |
| **E-learning** | `elearning_async` | 🟢 fort (async = e-learning en autonomie) |
| **Classe virtuelle** | `elearning_sync` | 🟡 **candidat fort, à confirmer** |

**⚠️ Ambiguïté « classe virtuelle » — je ne tranche pas :**
- Dendreo ne porte **pas** de valeur `distanciel` ni `classe_virtuelle`. Le seul
  « distanciel synchrone » disponible est **`elearning_sync`**.
- **Corroboration observée** (point 2/3) : les modules cœur des sessions CBCT
  s'appellent `2026_CBCT_CV_7h` (**CV = Classe Virtuelle**) et portent
  `mode_organisation = elearning_sync`. ⇒ chez Médéré, `elearning_sync` ≈ « CV ».
- **Décision demandée** : `elearning_sync` = « Classe virtuelle » ? (mon hypothèse),
  et `elearning_async` = « E-learning » ?

### Session suffit-elle, ou dériver des modules ?
**La session suffit — et elle est même plus riche.** Au niveau module
(`lams.php`), on ne voit que `elearning_async` / `elearning_sync` / `presentiel`
(97 modules échantillonnés) — **jamais `mixte`**. « Mixte » est un **agrégat de
session** (session mélangeant plusieurs modalités) qu'on **perdrait** si on
dérivait des modules. ⇒ **Utiliser `actions_de_formation.mode_organisation`.**

---

## 2. N° COMPTE PRODUIT « gris » (session CBCT)

### La prémisse « ADF sans numero_comptable » est le CAS GÉNÉRAL
- `actions_de_formation.numero_comptable` est **VIDE** pour :
  - **984 / 1014** sessions 2025 (dont 907 avec `num_session_dpc` rempli),
  - **679 / 680** sessions 2026 (dont 637 avec `num_session_dpc` rempli).
- ⇒ Le « numéro en gris » est la **norme**, pas l'exception.

### Où est porté le numéro « gris » : le MODULE
Le numéro 11 chiffres (« Numéro de programme » / N° d'action DPC) est porté par
le **module catalogue** (`modules.php`), champ exact :

- **`num_programme_dpc`** = ex. `92622425420` (identique à `modules.php.numero_comptable`).

Preuve — session témoin **`ADF_20240257` (id=2408, `num_session_dpc=24.001`, `numero_comptable` VIDE)** :

| module | `id_categorie_module` | `num_programme_dpc` |
|---|---|---|
| `2026_Dermatoscopie_EPP amont_2h` | 22 | `92622425382` |
| `2026_Dermatoscopie_EPP aval_2h` | 21 | `92622425382` |
| `2024_Dermatoscopie_PRES_3h` (cœur) | 3 | `92622425368` |

### Champ EXACT à lire quand l'ADF n'a pas `numero_comptable`
> **`modules.php` → `num_programme_dpc`** du module de la session.
> (À défaut, `modules.php.numero_comptable`, valeur identique.)

### ⚠️ Ambiguïté que je NE tranche pas
1. **Plusieurs numéros sur une même session** : une session composée porte des
   modules aux `num_programme_dpc` **différents** (dermato : cœur `…368` vs EPP `…382`).
2. **`is_master_module = 0` sur TOUS les modules** → l'API ne désigne **pas** un
   module « maître » pour choisir « le » numéro de la session.
3. Cas CBCT plus simple : les 4 modules de `id=2895` (CBCT, comptable vide) portent
   **tous** `92622425420` → pas d'ambiguïté **pour CBCT**.

**Hypothèse (à valider contre l'affichage Dendreo, PAS à figer) :** le gris =
`num_programme_dpc` du module **cœur** (celui dont la catégorie n'est **pas** EPP
amont/aval, `id_categorie_module ∉ {21,22}`). Pour CBCT → `…420`, pour dermato → `…368`.
→ **Déthié : peux-tu me dire quel numéro s'affiche en gris sur la fiche
`id=2408` et sur une CBCT ? Cela confirme (ou infirme) la règle « module cœur ».**

*(NB : la session `id=2656` visée par l'URL du point 4 a, elle, `numero_comptable`
RENSEIGNÉ = `92622425420` = valeur de ses modules ; c'est l'unique CBCT ainsi.)*

---

## 3. EPP AMONT / EPP AVAL CONNECTÉ (2 futures cases à cocher)

Session témoin : `id=2656` (CBCT) + échantillon de **18 sessions EPP** (repérées
via `documentName` « EPP amont/aval » dans le miroir `signatures` : **400 sessions
avec amont**, 159 avec aval).

### Identifier de façon FIABLE le module amont / aval
Discriminant **stable et primaire** (100 % concordant sur 36 modules / 18 sessions) :

- **EPP amont = `id_categorie_module = 22`**
- **EPP aval = `id_categorie_module = 21`**

⚠️ **`id_categorie_module` n'est PAS renvoyé par `lams.php`** (il vaut `undefined`) —
il faut le lire sur **`modules.php`** (via `id_module`).
Discriminant secondaire concordant : **`modules.php.intitule_court`** contient
`EPP amont` / `EPP aval` (ex. `2026_CBCT_EPP Amont_2h`).
⚠️ Le champ `intitule` (long) du LAM peut afficher « **Audit clinique amont/aval** »
(vocabulaire DPC) au lieu de « EPP » — d'où l'intérêt de la **catégorie 21/22**.

### Champ « Nombre d'heures connectées » (nom EXACT)
- **`c_nombre_dheures_connectees`** ✅ (confirmé, sur `modules.php`).
- Pendant : `c_nombre_dheures_non_connectees` (déjà vu en S0).
- ⚠️ Ces deux champs sont sur **`modules.php`** (catalogue), **pas** sur `lams.php`.
  ⇒ ils sont une propriété du **programme/module**, identique pour toutes les
  sessions qui l'utilisent (stable par programme, pas par session).

### La règle cible EST valide et discriminante (exemples réels)
Contrairement à ce qu'un seul cas (CBCT) laissait croire, `connectées > 0`
distingue bien les programmes : **6 / 36** modules EPP ont `c_nombre_dheures_connectees > 0`.

| Cas | Session | Module | `c_nombre_dheures_connectees` | `..._non_connectees` |
|---|---|---|---|---|
| **Amont CONNECTÉ** | `id=2714` (Cannabis) | cat 22 | **1** | 0 |
| **Amont CONNECTÉ** | `id=2711` (Peau foncée) | cat 22 | **2** | 0 |
| **Amont NON connecté** | `id=2656` (CBCT) | cat 22 | 0 | 2 |
| **Aval CONNECTÉ** | `id=2703/2704` (TDAH) | cat 21 | **2** | 0 |
| **Aval CONNECTÉ** | `id=2698/2699` (Path. apicales) | cat 21 | **1** | 2 |
| **Aval NON connecté** | `id=2656` (CBCT) | cat 21 | 0 | 2 |

Observations utiles :
- Les 2 sens sont **indépendants** : ex. `id=2698` a amont non-connecté (0) mais
  aval connecté (1) → **2 cases distinctes** justifiées.
- Le partage est en général **exclusif** (soit connectées>0, soit non_connectées>0).

### Règle cible → prête à valider
> **Case « EPP amont connecté »** = module `id_categorie_module=22` présent
> ET `c_nombre_dheures_connectees > 0`.
> **Case « EPP aval connecté »** = module `id_categorie_module=21` présent
> ET `c_nombre_dheures_connectees > 0`.

**À confirmer (sémantique, je ne tranche pas)** : « connecté » = « heures tracées
par la plateforme e-learning » (lecture DPC/ANDPC). Si Justine entend autre chose
par « connecté » (ex. attestation e-signée présente), la règle change → à valider.

---

## 4. ESPACE DE STOCKAGE SIGNATURES — URL

- **`2656` == `id_action_de_formation`** de la session CBCT : ✅ **confirmé**
  (`actions_de_formation.php?id=2656` → `numero_complet=ADF_20240505`,
  `intitule="Formation Cone Beam CT (CBCT)"`).
  ⚠️ **Nuance de nommage** : cette session est `num_session_dpc = **25.006**`
  (pas 25.005). L'idAdf `2656` reste le bon pour l'URL.
- **web_base exact** : **`https://pro.dendreo.com/nes_formation`** (SANS `/api`).
  (dérivé de `DENDREO_BASE_URL = https://pro.dendreo.com/nes_formation/api`.)
- **Patron confirmé** :
  ```
  {web_base}/formations/{idAdf}/suivi-signatures
  ```
  Exemple : `https://pro.dendreo.com/nes_formation/formations/2656/suivi-signatures`
  ⇒ le segment `formations/{n}` utilise bien **`id_action_de_formation`**.

---

## 5. Coût & sécurité de cette discovery
- ~**120 requêtes GET** cumulées (lecture seule), 0 écriture, 0 POST/PUT/DELETE.
- Firestore : `.get()` seulement sur `signatures` (champs `idAdf`, `documentName`).
- Clé jamais imprimée ; aucun nom/PII participant imprimé.

## 6. Champs à retenir (récap machine)
| Besoin | Endpoint | Champ |
|---|---|---|
| Format session | `actions_de_formation.php` | `mode_organisation` (4 valeurs) |
| N° programme DPC (gris) | `modules.php` | `num_programme_dpc` (11 chiffres) |
| N° comptable ADF (souvent vide) | `actions_de_formation.php` | `numero_comptable` |
| N° session DPC | `actions_de_formation.php` | `num_session_dpc` (NN.NNN) |
| EPP amont / aval | `modules.php` | `id_categorie_module` = 22 / 21 |
| Heures connectées | `modules.php` | `c_nombre_dheures_connectees` |
| Heures non connectées | `modules.php` | `c_nombre_dheures_non_connectees` |
| URL suivi-signatures | — | `{web_base}/formations/{id_action_de_formation}/suivi-signatures` |
