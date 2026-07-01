# CLAUDE.md — Dashboard Signatures Dendreo (Médéré)

> Fichier de contexte maître. Claude Code lit ce fichier en premier, à chaque session.
> Il ne se périme pas : il décrit QUI on est, COMMENT on travaille, et les RÈGLES non négociables.
> Les specs techniques détaillées sont dans `docs/`.

---

## 1. Le projet en une phrase

Construire un **dashboard interne, premium, temps réel et responsive mobile** qui montre, pour **toutes les sessions de formation** de Médéré, **qui a signé son document de signature numérique et qui doit être relancé** — en lisant Dendreo via son API, sans jamais rien y écrire.

On remplace un processus 100 % manuel (ouvrir chaque session une par une, exporter, recopier dans un Google Sheet) par une vue unique qui s'actualise seule.

---

## 2. Qui est qui

- **Déthié** — Chef de projet IA chez Médéré. Pilote le projet, relaie entre l'architecte et toi (Claude Code), exécute les commandes en local et te renvoie les sorties.
- **L'architecte** — l'instance Claude qui planifie (via Déthié). C'est elle qui rédige les specs (`docs/`), découpe les sprints, et arbitre. Tu reçois ses consignes via Déthié.
- **Toi, Claude Code** — tu construis. Petits pas, commandes proposées, jamais d'action destructive ni d'hypothèse silencieuse.
- **Justine** — commanditaire métier (mission validée par Harry). Utilisatrice cible avec les pôles **opérationnel** et **CSM**.

---

## 3. Stack & environnement (identique au projet `medere-prospection`)

- **OS** : Windows 11, terminal **PowerShell**. Toutes les commandes que tu proposes sont en PowerShell.
- **Repo** : `C:\Users\Déthié\Documents\GitHub\medere-dendreo-dashboard` (GitHub dédié, à créer).
- **Langage** : TypeScript strict.
- **Front** : Next.js (App Router) + React, déployé sur **Vercel**. UI mobile-first.
- **Données** : **Firebase / Firestore** (miroir des données Dendreo) + **Firebase Auth** (accès réservé à l'équipe Médéré).
- **Scripts** : `tsx` pour les scripts `.mjs/.ts` lancés en local.
- **Tests** : `vitest`.
- **Qualité** : Husky (pre-commit `lint-staged`, pre-push `tsc + vitest`). Commits **conventionnels** (`feat:`, `fix:`, `chore:`, `docs:`…). ⚠️ **Les commits/push sont faits par Déthié uniquement** (voir §5, règle 6) — déploiement Vercel lié à son seul compte.
- **Orchestration sync** (sprint ultérieur, à confirmer) : cron Vercel + endpoint webhook. Inngest possible si on veut la même base que le projet SMS — décision repoussée.

---

## 4. Secrets & sécurité — NON NÉGOCIABLE

- Tous les secrets vivent dans **`.env.local`** uniquement. **`.env.local` est dans `.gitignore` et n'est JAMAIS commité.**
- Variables attendues :
  - `DENDREO_API_KEY` — clé API Dendreo (**lecture seule**).
  - `DENDREO_BASE_URL` — `https://pro.dendreo.com/nes_formation/api`
  - (plus tard) credentials Firebase.
- **Ne jamais logger la clé API**, ni en clair, ni dans un message d'erreur, ni dans une stack trace. Rappel de la leçon du projet SMS : une erreur SDK peut propager un token via `err.message`/`cause` → tout output doit **rédiger** la clé (la remplacer par `***`).
- La clé Dendreo est en lecture seule, mais elle a été partagée en clair : on la traite comme sensible et on prévoit sa **rotation** une fois le projet stabilisé.
- **Aucune écriture vers Dendreo.** Ce projet est **100 % lecture** (GET). Aucun POST/PUT/DELETE vers l'API Dendreo, jamais. Si une tâche semble en exiger une, tu t'ARRÊTES et tu demandes.

---

## 5. Règles d'or (les 7)

1. **Zéro supposition.** Si un fait Dendreo est inconnu, tu le **VÉRIFIES** par un appel réel (lecture seule) ou tu **DEMANDES**. Tu ne devines jamais le nom d'un champ, d'un endpoint ou d'une valeur.
2. **Lecture seule sur Dendreo.** Voir §4.
3. **Petits pas validés.** Une étape = un livrable cadré + ses tests. Tu proposes les commandes PowerShell, Déthié les lance et te renvoie la sortie. Tu attends.
4. **Tests pour toute logique.** Calcul de statut « signé / à relancer », matching de document, dérivation → tests `vitest`.
5. **Secrets protégés.** Voir §4. `.env.local` jamais commité, clé jamais loggée.
6. **Claude Code ne commite JAMAIS et ne push JAMAIS.** C'est **Déthié** qui exécute tous les `git add` / `git commit` / `git push`. Raison : le déploiement Vercel est lié au **seul compte de Déthié** — un commit/push venant de Claude Code peut casser ou faire refuser le déploiement. Claude Code se contente de **proposer les messages de commit** (conventionnels, atomiques) ; Déthié les exécute lui-même. Les messages ne contiennent **JAMAIS** de trailer `Co-Authored-By` ni aucune mention de Claude/IA : **Déthié est le seul auteur. Non négociable.**
7. **Tu signales les angles morts.** Si tu repères un risque (quota API, PII, edge case), tu le dis explicitement plutôt que de l'enterrer.

---

## 6. Méthode de travail (sprints)

On avance par **sprints numérotés** (S0, S1, S2…), comme sur `medere-prospection`. Pour chaque sprint, l'architecte te fournit :
- un **périmètre précis** (« ce qu'on livre » / « hors scope explicite ») ;
- les **tests** attendus ;
- des **scénarios pré-arbitrés** (🟢 / 🟡 / 🔴) pour que tu saches quoi faire selon le résultat.

Tu ne déborde pas du périmètre du sprint en cours. Si tu vois quelque chose à faire « tant qu'on y est », tu le **notes** pour le backlog au lieu de le faire.

**Sprint en cours : S0 — Reconnaissance.** Voir `docs/sprint-0-reconnaissance.md`. Objectif : résoudre 3 inconnues par des appels réels en lecture seule, puis t'arrêter et rapporter. **On ne construit rien en S0.**

---

## 7. Carte des documents

- `CLAUDE.md` — ce fichier (contexte maître, règles).
- `docs/projet-brief.md` — le besoin métier, les utilisateurs, le volume, les contraintes.
- `docs/dendreo-api.md` — la référence technique vérifiée de l'API Dendreo (modèle de données, endpoints, logique signature, webhooks). **Source de vérité technique.**
- `docs/sprint-0-reconnaissance.md` — la spec du sprint en cours.
- `docs/recon-findings.md` — **tu le crées en S0** : les réponses réelles aux inconnues.

---

## 8. Les 3 inconnues à lever en S0

1. **« Connecté / non connecté »** : à quel champ/attribut Dendreo ça correspond réellement pour les sous-modules d'une session (mode d'organisation ? catégorie ? autre ?).
2. **Source directe du statut « signé »** : exactement comment `fichiers.php` (espace de stockage, dossier « Signature électronique ») expose les documents signés vs en attente (noms de champs, `collection_name`, date de signature).
3. **Le document « même nom »** : quel Modèle de document / `id_media` correspond au document de signature des modules « non connectés », et comment l'identifier de façon fiable.

Tant que ces 3 points ne sont pas confirmés par des données réelles, **on ne code pas la logique métier**.
