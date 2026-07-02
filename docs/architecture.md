# docs/architecture.md — Architecture validée (post-S0)

> Tout ici découle de faits **prouvés en S0** par appels réels (voir `docs/recon-findings.md`).
> Les rares paramètres encore à confirmer sont marqués **[À CONFIRMER]**.

---

## 1. Décisions verrouillées par S0

> ⚠️ **RÈGLE SIGNATURE À JOUR : voir `docs/signature-rule.md` (fait autorité).** Le point 3 ci-dessous
> (« doctype 111 ») et le statut « notSent » du §4 sont **remplacés** : on suit désormais **tout document
> dont le nom commence par « Attestation »** (cible Participant), statuts **signé / à relancer** uniquement.

1. **Source primaire = `fichiers.php`.** Un seul appel par session donne tout :
   `GET /fichiers.php?cible=action-de-formation&id_cible={id_adf}&collection_name=signature`
   → retourne les documents de signature de la session, **signés ET en attente**, avec le participant, la date et le lien de visualisation.
2. **Statut SIGNÉ** = champ **`signature_date` non vide**. **EN ATTENTE** = fichier présent, `signature_date` vide. (Prouvé sur 14 signés / 6 en attente réels.)
3. **Document suivi = la Convention** `Convention_Participant_Formation_Médéré`, **`doctype_id = 111`**. Clé stable et fiable. **[À CONFIRMER avec Justine : est-ce le seul doc, ou existe-t-il aussi une attestation sur l'honneur distincte ?]**
4. **Granularité** : le doc est **par participant × session**, **pas par sous-module**. ⇒ On n'a PAS besoin de résoudre « connecté/non connecté » pour le dashboard. (Pour mémoire S0 : « non connecté » ≈ `c_nombre_dheures_non_connectees > 0`, EPP/audit clinique — info conservée mais non utilisée ici.)
5. **Centre** : mono-centre effectif (SAS MEDERE). Multi-centres **latent** → on paramètre `id_centre_de_formation` proprement dès le départ pour ne pas se faire piéger plus tard.

## 2. Périmètre de données : HISTORIQUE COMPLET

**On récupère tout l'historique depuis le début de Dendreo, pas seulement 2026.**
Raison métier : des Conventions de **2025 (et avant)** sont **encore non signées** — ce sont précisément des gens à relancer.

⚠️ Rappel technique : `actions_de_formation.php` ne renvoie **par défaut que la dernière année**. Pour balayer tout l'historique, on **paginera par fenêtres annuelles** via `started_after`/`ended_after` :
```
pour chaque année Y de {première année Dendreo} à {année courante} :
   GET /actions_de_formation.php?started_after=Y-01-01&started_before=Y-12-31&fields=...
```
La **première année** se découvre empiriquement (la fenêtre la plus ancienne qui renvoie des sessions).

## 3. Composants

```
[Dendreo API]  ──(lecture seule, GET)──►  [Couche de sync]  ──►  [Firestore (miroir)]  ──►  [UI Next.js]
                                              ▲                                                  (temps réel)
[Webhook "document signé"] ───────────────────┘
```

1. **Client Dendreo** (TypeScript, typé, lecture seule) : header `Authorization`, **clé jamais loggée**, conscient du rate-limit (backoff sur `429`), pagination.
2. **Backfill (one-shot)** : balaie **toutes** les sessions de l'historique (pagination annuelle), et pour chacune appelle `fichiers.php` (collection `signature`) → upsert Firestore. Coût : ~1 appel/session, **une seule fois**.
3. **Miroir Firestore** : collections `sessions` et `signatures`. Le dashboard lit Firestore (pas Dendreo) → temps réel + quota protégé. Last-write-wins.
4. **Sync permanent** :
   - **Webhook global** `« Un document est signé »` → bascule instantanée en « signé » (vérif HMAC, receveur **idempotent**, voir `docs/dendreo-api.md` §8).
   - **Réconciliation quotidienne** des **sessions actives** uniquement (étape Réalisation/prévisionnelle).
   - Webhooks LAP/LMP (participant ajouté/inscrit) → garder à jour la liste des signataires attendus.
5. **UI** : Next.js (App Router) mobile-first, lit Firestore en temps réel, accès **Firebase Auth** réservé Médéré.

## 4. Statuts affichés

- 🟩 **Signé** — `signature_date` présente.
- 🟧 **À relancer** — fichier présent, `signature_date` vide. Ancienneté = date d'envoi → priorité de relance.
- ⬜ **Pas encore envoyé** — participant **attendu** (présent dans `laps.php`) **sans aucun** fichier de signature. **CONFIRMÉ (Justine via Déthié) : oui, on l'affiche** — c'est le suivi global des 3 cas.
  → Calcul : *attendus* = participants inscrits de la session (`laps.php?id_action_de_formation={id}&include=participant`) ; *pas encore envoyé* = attendus **moins** ceux qui ont un fichier dans `fichiers.php`.
  → **[Lié à Q1]** : on suppose que **tout participant de la session** est attendu pour la Convention. À confirmer avec Justine (si seuls certains modules déclenchent la Convention, on affinera avec `lmps.php`).

> Côté UI : **une seule couleur d'accent** (orange) pour « à relancer ». « Signé » et « pas encore envoyé » = neutres (icône + libellé). Voir `docs/design-system.md`.

## 5. Quota (abonnement Or) — chiffres réels

- **Plafond mensuel Or : 150 000 requêtes/mois.** Conso actuelle de Médéré : **~3 205 sur 30 jours** (relevé UI Dendreo, juin 2026). → Énorme marge.
- **Backfill** : ~1 appel / session historique, **une seule fois** (plus 1 `laps.php`/session pour les « pas encore envoyé »). Même plusieurs milliers de sessions = loin sous les 150 000.
- **Régime permanent** : réconciliation quotidienne des sessions actives + webhooks ≈ **~11 k requêtes/mois**. Avec les 3 k déjà consommés ailleurs, on reste très en dessous de 150 k. **Aucune contrainte quota.**

## 6. Angles morts S0 → comment on les traite

- **Docs Formateur mêlés** dans `fichiers.php` → filtrer `entite_liee.type = "Participant"`.
- **Doublons de doc par participant** → dédupliquer (clé : participant × session × `doctype_id`, garder le plus récent / le signé s'il existe).
- **`taches.php` est par participant, pas par session** → on **n'en dépend pas** : `fichiers.php` (par session) est la source. `taches.php` reste un contrôle d'appoint.
- **Multi-centres latent** → paramétrer `id_centre_de_formation` partout dès maintenant.
- **PII lourde** (`fichiers.php`/`laps.php` contiennent noms, emails de PS) → on ne stocke dans Firestore que ce que le dashboard affiche, accès **Firebase Auth** obligatoire, pas d'export non protégé.

## 7. Paramètres ouverts (non bloquants pour démarrer S1)

| # | Param | Statut |
|---|-------|--------|
| A | `doctype_id` du doc suivi (111 par défaut, prouvé) | ⏳ Justine confirme s'il y a un 2ᵉ doc ; sinon 111 suffit |
| B | Afficher le statut « pas encore envoyé » ? | ✅ **OUI** (Déthié) — les 3 statuts |
| C | Plafond mensuel Or | ✅ **150 000/mois** (conso ~3,2 k/30j) — marge énorme |

Aucun de ces points ne bloque le **cœur de lecture** (S1) : il est identique quelle que soit leur réponse (au pire, un `doctype_id` ajouté = une constante).
