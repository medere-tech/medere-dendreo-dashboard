# docs/sprint-0-reconnaissance.md — Sprint S0

## Objectif

Lever les **3 inconnues** (voir `docs/dendreo-api.md` §9) par des **appels réels en lecture seule**, puis **s'arrêter et rapporter**. **On ne construit pas le dashboard en S0.** Aucune écriture vers Dendreo, aucune UI, aucune base de données.

## Périmètre

**Ce qu'on livre en S0 :**
- Le repo initialisé (`medere-dendreo-dashboard`) avec `.gitignore` (incluant `.env.local`), `package.json`, `tsx` installé.
- `.env.local` (non commité) avec `DENDREO_API_KEY` et `DENDREO_BASE_URL`.
- **Un seul script jetable** : `scripts/recon.mjs` (lecture seule, GET uniquement) qui exécute les sondes ci-dessous et imprime des résultats structurés, **clé rédigée** (`***`) dans toute sortie.
- Un fichier de résultats : `docs/recon-findings.md` (que tu rédiges à partir des sorties réelles).

**Hors scope explicite :**
- ❌ Toute écriture Dendreo (POST/PUT/DELETE).
- ❌ Firestore, Firebase Auth, Next.js, UI.
- ❌ Webhooks en réception (on lit juste la doc/le payload de test).
- ❌ Toute logique métier figée avant validation des findings.

## Sécurité (rappel, S0)

- `.env.local` dans `.gitignore` **avant** d'y mettre la clé.
- `recon.mjs` lit la clé via `process.env.DENDREO_API_KEY`, l'envoie en header `Authorization: Token token="..."`, et **ne l'imprime jamais** (rédaction `***` systématique, y compris dans les URLs loggées et les erreurs).
- **GET uniquement.** Si une sonde semble nécessiter autre chose qu'un GET, tu t'arrêtes et tu demandes.
- Les sorties peuvent contenir des **données personnelles** (noms/emails de PS) : dans `docs/recon-findings.md`, anonymise les exemples (initiales) sauf si Déthié dit le contraire.

## Les sondes (read-only, dans l'ordre)

1. **Connexion + auth + centre(s)**
   `GET /centres_de_formation.php` → confirmer `200`, lister les centres (mono ou multi-centres ?).

2. **Volume & étapes des sessions 2026**
   `GET /actions_de_formation.php?started_after=2026-01-01&ended_before=2026-12-31&fields=id_action_de_formation,numero_complet,intitule,date_debut,date_fin,id_etape_process,total_participants`
   → compter, échantillonner, repérer les étapes présentes (croiser avec `etapes.php`).

3. **Anatomie d'une vraie session « 3 Modules »** (inconnue n°1)
   Choisir une ADF multi-modules réelle (ex. depuis la capture : *Accompagnement* `26.001` = `ADF_20260316`, ou toute ADF marquée « 3 Modules »).
   `GET /actions_de_formation.php?numero_complet=ADF_20260316&include=modules,participants`
   et/ou `GET /lams.php?id_action_de_formation={id}&include=module`
   → pour **chaque sous-module** : capturer `intitule`, `mode_organisation`, `id_categorie_module`, `module_parent`, et **tout champ** qui pourrait porter la notion « connecté/non connecté ». Noter ce qui distingue les sous-modules entre eux.

4. **Participants de cette session**
   `GET /laps.php?id_action_de_formation={id}&include=participant,lmps`
   → liste des signataires potentiels + à quels sous-modules ils sont inscrits.

5. **Signatures en attente de ces participants** (cœur)
   `GET /taches.php?id={ids_participants_batch}&types=esignature-doc`
   → capturer `id_media`, `date`, `id_adf`, `intitule`. Noter le **nom du document** et son `id_media`.

6. **Espace de stockage / `fichiers.php`** (inconnue n°2)
   D'abord lire la section « Fichiers » de `https://developers.dendreo.com/#fichiers` (notamment **« Liste des cibles et collection_name correspondants »**).
   Puis appel réel pour lister les fichiers de la session (cible = ADF) dans la collection « Signature électronique ».
   → capturer le **JSON brut** : noms de champs, présence d'un flag/d'une `date` de signature, lien vers le participant, `collection_name` exact.

7. **Mapping du document « même nom »** (inconnue n°3)
   Recouper l'`id_media` de l'étape 5 avec le(s) fichier(s) de l'étape 6 et le nom du modèle → établir comment identifier **de façon fiable et répétable** le bon document de signature.

8. **Marge de quota API**
   Noter, via la page de config API Dendreo (UI) ou tout header/endpoint d'usage disponible, la **consommation et la marge mensuelle** (abonnement Or). Estimer le coût en requêtes d'une sync complète des ~659 sessions.

## Livrable : `docs/recon-findings.md`

Tu y réponds **avec des données réelles** (échantillons JSON bruts à l'appui, PII anonymisée) :
- Mono ou multi-centres ? Combien de centres ?
- Volume sessions 2026 + étapes.
- **Inconnue 1** : « connecté/non connecté » = quel champ exactement ? (avec preuve : le JSON des sous-modules d'une vraie session)
- **Inconnue 2** : comment `fichiers.php` donne le statut signé (requête exacte + champs).
- **Inconnue 3** : comment identifier le document « même nom » (id_media / modèle).
- Coût requêtes estimé d'une sync complète + marge quota Or.
- Tout angle mort / surprise.

Puis **STOP** : tu rapportes à Déthié, qui transmet à l'architecte. **On valide ensemble avant de construire quoi que ce soit (S1).**

## Scénarios pré-arbitrés (inconnue n°1)

- 🟢 **A — « connecté/non connecté » = un champ Dendreo natif et net** (ex. `mode_organisation` : e-learning vs présentiel/mixte, OU une `id_categorie_module` dédiée). → On fige la règle de filtre en S1, sereinement.
- 🟡 **B — c'est un proxy imparfait** (ex. ça corrèle avec `mode_organisation` mais pas à 100 %). → On capture la règle réelle + les exceptions, et on demande à Justine de confirmer la correspondance avant de coder.
- 🔴 **C — aucun champ API ne porte l'info** (c'est une convention purement humaine / un libellé maison non exposé). → On bascule sur le plan B robuste : on **identifie le document par son nom de modèle** (le « même nom ») via `taches.php`/`fichiers.php`, indépendamment de la structure module. Le dashboard reste 100 % faisable. On documente ce choix.

Dans les 3 cas, le projet avance. L'objectif de S0 est juste de **savoir** laquelle de ces réalités on a, avec des données réelles en main.
