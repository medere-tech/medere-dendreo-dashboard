# docs/ui-spec.md — Spécification UI (MVP dashboard ops/CSM)

> « Premium » défini opérationnellement, sinon le mot est vide. Réf. charte : `docs/design-system.md`.
> Le front lit **Firestore** en temps réel (jamais Dendreo directement).

---

## 1. Définition de « premium » (le standard, non négociable)

- **Rapidité perçue** : après le 1er chargement, rien ne « charge » visiblement. Recherche / filtre / tri **instantanés (<50 ms)** sur données déjà en mémoire. Skeletons au 1er load, jamais de spinner qui saute.
- **Temps réel** : `onSnapshot` Firestore → les changements arrivent seuls, sans refresh, mise à jour **douce** (pas de flash, pas de saut de scroll).
- **Intuitif** : compréhensible sans notice ; une action évidente par écran ; le « à relancer » saute aux yeux (accent orange).
- **Ergonomie** : raccourci clavier `/` = focus recherche ; navigation clavier ; feedback immédiat sur chaque action.
- **Sobriété** : charte Médéré (neutres + orange unique), **Aileron**, zéro dégradé, zéro superflu, densité maîtrisée.
- **Responsive mobile-first** : parfait sur téléphone (ops/CSM en déplacement), puis desktop.
- **Finitions** : transitions 150-200 ms, alignements au pixel, focus visibles (a11y AA), aucun à-coup.

## 2. Stack front

- **Next.js (App Router) + TypeScript + Tailwind** (tokens Médéré en CSS variables / config Tailwind).
- **Firebase Web SDK** : Auth (Google) + Firestore (`onSnapshot`).
- **Aileron** auto-hébergée (`public/fonts/` + `@font-face`).
- Déploiement **Vercel** (compte Déthié).
- ⚠️ Cohabitation repo : garder le back-office existant (`src/dendreo`, `src/firebase` Admin SDK, `scripts/`) **séparé** de l'app Next — pas de conflit de build ni de tsconfig. L'app Next ne doit pas embarquer l'Admin SDK côté client.

## 3. Auth — SSO Google, verrou `@medere.fr`

- Écran `/login` : un seul bouton « Se connecter avec Google ». Provider Google Firebase, paramètre **`hd=medere.fr`**.
- Après connexion : si l'email **ne finit pas par `@medere.fr`** OU non vérifié → **déconnexion immédiate** + message « Accès réservé aux comptes @medere.fr ».
- **Double verrou** : (1) garde applicatif ci-dessus, (2) règles Firestore déjà en place (lecture = `@medere.fr` + `email_verified`). Le SSO Google fournit un email vérifié.
- Toutes les routes du dashboard derrière un **garde d'auth** (redirection `/login` si non connecté). Session persistée. Déconnexion accessible (menu).

## 4. Écrans MVP

### 4.1 Accueil — vue transverse « Sessions » (le cockpit)
Tableau premium de toutes les sessions **2025+**. Colonnes (socle garanti ; le reste selon cahier Justine) :
`N° session DPC (26.001)` · `N° compte produit (92622525478)` · `Intitulé` · `Début` · `Fin` · `Étape` · `Nb participants` · bloc **Signatures**.

**Bloc Signatures (cf. `docs/signature-rule.md`)** : trois chiffres **aérés, jamais tassés/superposés** — **Envoyés** · **Signés** (neutre) · **À relancer** (orange si > 0) — + le nombre de **participants concernés**. Chaque chiffre est **cliquable** → ouvre le drawer (§4.5).

Fonctions : **recherche instantanée** (tous champs) · **filtres** (période, étape, « a des relances ») · **tri** (colonnes + tri **urgence** par défaut : plus d'à-relancer en haut) · **pagination premium** (« 1-25 sur N »).

### 4.5 Drawer « clic → liste » (fonctionnalité premium, demandée par Justine)
Un clic sur un compteur (Envoyés / Signés / À relancer) d'une session ouvre un **panneau glissant** listant les participants concernés par ce chiffre :
- **Signés** → participant · date de signature · lien de visualisation.
- **À relancer** → participant · depuis quand · **lien direct de relance**.
- **Envoyés** → tous les destinataires.
Premium : slide-in fluide, **aucun rechargement**, recherche dans la liste, lien direct par ligne, fermeture au clavier (**Échap**) + clic hors panneau. C'est le geste quotidien ops/CSM.

### 4.2 Vue transverse « À relancer » (la valeur n°1)
Liste de **tous les participants à relancer**, toutes sessions, **triée par ancienneté** (plus vieux d'abord). Colonnes : participant · session (n° + intitulé) · date d'envoi · ancienneté · **lien de visualisation direct**. Recherche + filtre (session / période).

### 4.3 Détail session
Infos de la session + liste de ses participants avec statut (signé / à relancer / [non envoyé]), date, lien.

### 4.4 Mobile
Mêmes données en **cartes empilées**, « à relancer » en évidence, recherche accessible.

## 5. États (obligatoires)

- **Chargement** : skeletons (jamais de spinner brut).
- **Vide** : message clair + visuel sobre (« Aucune relance en attente »).
- **Erreur** : message clair + action « Réessayer ».
- **Temps réel** : mise à jour douce, sans flash ni re-scroll.

## 6. Données & performance

- **Working set MVP (2025+)** : ~1 200 sessions, ~800 « à relancer » → chargés via Firestore (queries indexées) et gardés **en mémoire** pour recherche / tri / filtre **instantanés**. Pagination à l'affichage.
- `onSnapshot` sur le working set pour le temps réel.
- Si le volume grossit (tout l'historique) : bascule vers pagination/filtre **côté Firestore** (index déjà prévus au modèle). Noté, hors MVP.

## 7. Hors scope MVP (phases suivantes)

- Webhooks « document signé » (le temps réel MVP = `onSnapshot` sur le miroir, rafraîchi par backfill/sync).
- Champs « coûteux » multi-endpoints (facturation, remplissage, présence) — phase 2 selon cahier.
- Export, rôles fins, notifications.
