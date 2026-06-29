# docs/dendreo-api.md — Référence technique API Dendreo (vérifiée)

> Source de vérité technique. Tout ce qui est ici a été lu dans la doc officielle
> (`developers.dendreo.com` + `doc.dendreo.com`). Ce qui reste à confirmer par appel réel
> est explicitement marqué **[À VÉRIFIER EN S0]**. Ne rien supposer au-delà.

---

## 1. Accès & authentification

- **Base URL** : `https://pro.dendreo.com/nes_formation/api/{ressource}.php`
- **Auth par token**, deux formes possibles :
  - Header : `Authorization: Token token="LA_CLE"` (forme recommandée, évite la clé dans l'URL/les logs).
  - ou query : `?key=LA_CLE` (à éviter : finit dans les logs).
- Clé absente/invalide → `401 Unauthorized`. Permissions par endpoint (lecture/écriture) → un endpoint sans droit renvoie aussi `401`.
- **Notre clé est en lecture seule.** On n'appelle que des GET.
- Réponses **JSON uniquement**.

## 2. Quotas & throttling (abonnement Or)

- **Burst** : 100 requêtes max / 10 secondes.
- **Quotidien** : 100 000 requêtes / jour (plafond global, tous plans).
- **Mensuel** : dépend de l'abonnement → **Or = quota limité** (pas illimité ; seul Platine est illimité). Chiffre exact à surveiller via la page de config API Dendreo. **[À VÉRIFIER EN S0 : marge de quota restante]**
- Dépassement → `429 HTTP_TOO_MANY_REQUESTS`.

**Règles de frugalité (à appliquer partout) :**
- Batcher les IDs : la plupart des endpoints acceptent `?id=1,2,3,...` (plusieurs objets en une requête).
- Restreindre les champs : `?fields=col1,col2` réduit la charge.
- Ne poller que les **sessions actives** (étape « Réalisation » / prévisionnelle pertinente), pas tout l'historique.
- Stocker en **Firestore** (miroir) et lire Firestore côté UI — l'API Dendreo n'est appelée que par la couche de sync.
- Privilégier les **webhooks** (push) au polling quand c'est possible.

## 3. Conventions de requête

- **INDEX** (liste) : `GET /xxx.php` → tableau. **SHOW** (détail) : `GET /xxx.php?id=12` → objet.
- Multi-ID : `?id=12,14,16`.
- `?fields=...` : limite les champs (INDEX et SHOW).
- `?include=...` : ajoute des objets liés (voir chaque endpoint).
- `?show=date_add,date_edit,date_delete` : affiche des champs cachés par défaut.
- **Filtres date** (sur les objets qui les supportent) :
  - `created_after/before`, `updated_after/before`, `nb_jours` (format `YYYY-MM-DD`).
  - Pour `ActionDeFormation`, `Lam`, `Creneaux` : aussi `started_after/before`, `ended_after/before`.
- ⚠️ **Piège majeur** : `actions_de_formation.php` ne renvoie **par défaut que la dernière année**. Toujours passer un filtre de dates explicite (`started_after`/`ended_after`) pour cadrer la période voulue.

## 4. Modèle de données (la chaîne)

```
ActionDeFormation (ADF)  = une SESSION
   │  id_action_de_formation, numero_complet (ADF_2026xxxx), type (inter/intra),
   │  intitule, date_debut, date_fin, id_etape_process, id_centre_de_formation,
   │  total_participants ...
   │
   ├── LAM  (lams.php)  = programmation d'un MODULE dans la session
   │     id_lam, id_module, intitule, mode_organisation, master_lam_id ...
   │     → pour les MODULES COMPOSÉS, voir §6 (module_parent)
   │
   ├── LAP  (laps.php)  = INSCRIPTION d'un participant à la session
   │     id_lap, id_participant, id_entreprise, status ...
   │     include=participant → infos participant ; include=lmps → modules suivis
   │
   ├── LMP  (lmps.php)  = lien Participant × Module dans la session
   │     id_lmp, id_lap, id_lam, status (inscrit au module ou non) ...
   │
   └── Créneau (creneaux.php) → LCP (lcps.php) = présence/émargement par créneau
```

Objets « tâches » rattachés au participant : émargement (`esignature`), **signature de document (`esignature-doc`)**, satisfaction, auto-positionnement.

## 5. Endpoints qu'on utilise (lecture seule)

### 5.1 `actions_de_formation.php` — les sessions
- Liste cadrée : `GET .../actions_de_formation.php?started_after=2026-01-01&ended_before=2026-12-31&type=inter`
- Champs utiles : `id_action_de_formation`, `numero_complet`, `intitule`, `date_debut`, `date_fin`, `id_etape_process`, `id_centre_de_formation`, `total_participants`.
- `include=modules,participants,etapeProcess` enrichit la réponse.
- Filtres : `type`, `id_module`, `id_centre_de_formation`, `numero_complet`, `search`, + filtres date (§3).

### 5.2 `lams.php` — les modules d'une session
- `GET .../lams.php?id_action_de_formation=XXX`
- Champs utiles : `id_lam`, `id_module`, `intitule`, `mode_organisation` (`presentiel`, `elearning_sync`, `mixte`, `elearning_async`, `stage`), `master_lam_id`.
- `include=participants,module,lmps,creneaux,lieux`.
- **C'est ici (ou via `actions_de_formation?include=modules`) qu'on lit la structure des 3 sous-modules.** Voir §6 pour les modules composés.

### 5.3 `laps.php` — inscriptions/participants d'une session
- `GET .../laps.php?id_action_de_formation=XXX&include=participant`
- Donne la **liste des participants** de la session (= signataires potentiels) avec `id_participant`, nom, prénom, email.
- `include=lmps` → quels modules chaque participant suit (utile pour ne cibler que les « non connectés »).

### 5.4 `taches.php` — signatures EN ATTENTE (le cœur « à relancer »)
- `GET .../taches.php?id={liste_id_participants}&types=esignature-doc`
- IDs participants batchables : `?id=17,18,19`.
- Renvoie, **par participant**, les **signatures de documents encore en attente** (= **PAS signées**) :
  ```json
  { "type": "esignature-doc",
    "intitule": "Signature électronique d'un document",
    "id_media": "779",          // le document concerné
    "date": "2024-04-18 15:06:02", // date d'envoi de la demande
    "id_adf": "340",            // la session
    "url": "https://extranet.../signatures/.../779/viewer" }
  ```
- ⇒ **PENDING = ce que renvoie taches.php pour esignature-doc.** L'ancienneté = `date` → priorité de relance.

### 5.5 `fichiers.php` — espace de stockage / GED  **[À VÉRIFIER EN S0]**
- Section « Fichiers » de la doc : `Afficher un fichier`, `Rechercher un fichier`, `Filtre avancé sur les cibles`, `Ajouter un fichier`, **`Liste des cibles et collection_name correspondants`**.
- Hypothèse à confirmer : on liste les fichiers d'une **cible = Action de Formation**, dans la **collection « Signature électronique »**, pour obtenir les documents **signés ET en attente** avec leur statut/date.
- **À capturer en S0 (par appel réel)** : la requête exacte (paramètres `cible` / `collection_name`), et les **noms de champs** (existe-t-il un flag « signé » ? une `date_signature` ? le lien participant ?).
- Cette source est le **complément/contrôle direct** du calcul par déduction (§7).

### 5.6 Référentiels
- `centres_de_formation.php` — vérifier mono/multi-centres.
- `etapes.php` — libellés d'étapes (`Réalisation`, etc.).
- `participants.php` — détail participant si besoin (`extranet_code`, etc.).
- `modules.php` — fiche module catalogue (`mode_organisation`, `id_categorie_module`, `eligible_dpc`…).

## 6. Modules composés (le point qui débloque tout)

La FAQ dit que les **Modules Composés** ne sont pas gérables via l'API — mais c'est vrai **en écriture seulement**. **En lecture, ils sont accessibles** :

> Sur `actions_de_formation.php?include=modules`, si la session est faite de modules composés, la liste renvoyée est celle des **sous-modules simples**, et pour chacun les infos du **module parent** figurent dans la clé **`module_parent`**.

⇒ On peut donc lire la structure « 3 sous-modules » d'une session, avec leur parent. **C'est ce qui permet d'identifier les sous-modules « non connectés ».** (Reste à confirmer à quel champ correspond « connecté/non connecté » → inconnue n°1, S0.)

## 7. Logique du statut signature (cœur métier)

Pour une session donnée et le document de signature « même nom » :

- **EN ATTENTE (à relancer)** = participants renvoyés par `taches.php?types=esignature-doc` pour ce document (`id_media` / modèle correspondant).
- **SIGNÉ** = **signataires attendus − en attente**.
  - *Signataires attendus* = participants de la session (via `laps.php`) inscrits au(x) sous-module(s) « non connecté(s) » concerné(s) (via `lmps.php`/`include=lmps`).
- **Source directe de contrôle** = `fichiers.php` (collection « Signature électronique », §5.5) **[À VÉRIFIER]** + le webhook « document signé » (§8) pour le temps réel.

> Cette double approche (déduction + source directe) garantit qu'on est robuste même si `fichiers.php` n'expose pas tout : le dashboard est faisable dès maintenant par déduction, et `fichiers.php`/webhook le rendent plus direct et instantané.

## 8. Webhooks (temps réel)

- Dendreo POST en JSON vers une URL qu'on configure, à chaque événement.
- **Sécurité** : signature **HMAC** dans le header, à vérifier avec la **clé secrète** fournie par Dendreo → on valide que le POST vient bien de Dendreo.
- **Relances** : si notre endpoint ne répond pas / renvoie une erreur, Dendreo renvoie **5 fois** avec backoff (~10s, ~1min, ~15min, ~2h30, ~24h). Notre receveur doit être **idempotent**.
- Multi-centres : un webhook posé depuis un sous-centre ne se déclenche que pour ce sous-centre.
- **Sandbox disponible** (article Dendreo « Utiliser une Sandbox ») — à privilégier pour tester sans toucher le prod.

**Événements pertinents pour nous :**
- **Document → « Un document est signé »** ← notre brique temps réel signature. **[À VÉRIFIER EN S0 : payload exact]**
- Document → « Un document a été uploadé depuis l'Extranet Participant » (cas du dépôt manuel d'un signé).
- Action de Formation → « Un Participant est ajouté à une ADF (LAP) », « inscrit/désinscrit d'un Module (LMP) » → maintenir la liste des signataires attendus à jour.
- Action de Formation → « Un Émargement est fait » (présence — utile plus tard, pas pour la signature doc).

## 9. Les 3 inconnues à lever en S0 (rappel)

| # | Inconnue | Comment la lever |
|---|----------|------------------|
| 1 | À quoi correspond **« connecté / non connecté »** sur les sous-modules ? | Lire une vraie session « 3 Modules » (`include=modules`), inspecter `mode_organisation`, `id_categorie_module`, `module_parent`, et tout autre champ ; croiser avec là où apparaissent les `esignature-doc`. + Confirmation de Justine. |
| 2 | Comment `fichiers.php` expose le **statut signé** (champs, `collection_name`, cible) ? | Appel réel `fichiers.php` sur une session ; capturer le JSON brut. |
| 3 | Quel **Modèle/`id_media`** = le document « même nom » ? | Repérer l'`id_media` renvoyé par `taches.php` + recouper avec `fichiers.php`/le nom du modèle. |

Tant que ces 3 points ne sont pas confirmés par des données réelles, on ne fige pas la logique métier.
