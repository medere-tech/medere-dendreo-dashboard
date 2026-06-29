# docs/projet-brief.md — Le besoin métier

## 1. Le besoin (mots de Justine)

> « Les modules sont créés en 3 sous-modules (lesquels sont précisés "connectés" ou "non connectés"). Et dans chaque session de ces modules, pour chaque module "non connecté" nous envoyons (à la fin de celui-ci) un document en signature numérique (il porte toujours le même nom). Une fois qu'ils sont envoyés, ils sont regroupés (dans chaque session) dans l'espace de stockage, et cela nous permet de voir qui a signé son document et qui doit être relancé pour la signature. Aujourd'hui nous faisons des exports à la main + des check et mise à jour de Google Sheet en ouvrant toutes les sessions, c'est ultra chronophage de construire ce dashboard. Tu pourrais automatiser tout ça ? »

## 2. Traduction opérationnelle

- Une **formation** est structurée en **3 sous-modules**, chacun marqué **« connecté »** ou **« non connecté »** (terminologie interne Médéré — voir inconnue n°1).
- Pour chaque sous-module **« non connecté »**, à la fin du module, Médéré envoie au participant un **document à signer numériquement** (toujours le **même nom**).
- Ces documents atterrissent dans le **dossier « Signature électronique » de l'espace de stockage de la session** (côté Dendreo).
- Le besoin : voir **d'un coup d'œil, sur TOUTES les sessions**, **qui a signé** et **qui reste à relancer** — sans ouvrir chaque session manuellement.

## 3. Ce qui se passe aujourd'hui (la douleur)

Exports manuels session par session → vérification → mise à jour d'un Google Sheet. Ultra chronophage. C'est précisément ce qu'on supprime.

## 4. La cible

Un **dashboard interne premium** :
- **Temps réel** (mise à jour automatique, sans rafraîchissement manuel).
- **UX/UI soignée**, niveau SaaS haut de gamme.
- **Responsive mobile**.
- **Lecture seule** sur Dendreo (aucune écriture).
- Vue **transverse toutes sessions** (le truc impossible à faire à la main) + détail par session.

Pour chaque session : nom du document, nombre de signataires attendus, signés, et la **liste des « à relancer » triée par ancienneté** (= priorité de relance), avec accès direct au lien de relance/visualisation.

## 5. Utilisateurs

- **Pôle opérationnel**
- **Pôle CSM**

(À confirmer : périmètre de visibilité par utilisateur — tout le monde voit tout, ou filtré ? Question ouverte, non bloquante pour S0.)

## 6. Volume réel (constaté sur captures Dendreo, juin 2026)

- Centre : **SAS MEDERE** (vérifier en S0 si multi-centres).
- **~659 Actions de Formation INTER** sur la période 01/01/2026 → 31/12/2026, étape « Réalisation ».
- **~4906 participants**.
- Sessions souvent en **« 3 Modules »** (cohérent avec la structure 3 sous-modules).
- Une colonne **« Suivi Signatures »** existe déjà nativement dans le tableau des ADF Dendreo (preuve que la donnée est suivie au niveau session — on la rend transverse et automatique).

→ Ce volume impose une **sync frugale** en requêtes API (voir `docs/dendreo-api.md`, §quotas), d'autant que l'abonnement est **Or** (quota mensuel limité, pas illimité).

## 7. Contraintes

- **Abonnement Dendreo : Or** → quota de requêtes mensuel à respecter. Architecture pensée pour minimiser les appels (miroir Firestore + webhooks + polling ciblé).
- **Fermeture Médéré : 10 → 21 août 2026 inclus** (reprise le 24). À garder en tête pour le planning de livraison.
- **Sécurité** : lecture seule, secrets en `.env.local`, clé jamais loggée.

## 8. Critères de succès

1. Le dashboard affiche, pour chaque session active, le statut signature exact (signés / en attente) du document « non connecté » — **conforme à ce qu'on lit en ouvrant la session dans Dendreo**.
2. La vue transverse permet d'identifier en quelques secondes **tous les participants à relancer**, toutes sessions confondues.
3. Mise à jour temps réel (webhook « document signé » + réconciliation périodique).
4. Zéro écriture vers Dendreo. Zéro fuite de secret.
5. Gain de temps mesurable vs le process Google Sheet manuel (objectif : supprimer la tâche manuelle).
