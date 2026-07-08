# docs/webhook-recon.md — Recon Webhooks Dendreo (S8.0)

> Recon **lecture seule** (doc Dendreo + FAQ). Aucun code, aucun appel d'écriture.
> Objectif : décider l'archi temps réel pour la mise à jour du miroir signatures.
> **Verdict : OUI, Dendreo propose des webhooks**, adaptés à notre besoin signature.
>
> ⚠️ Le portail développeur `developers.dendreo.com` est une SPA : sa section
> « Webhooks » n'est **pas extractible en HTTP** (contenu chargé en JS). Les points
> marqués **[À CONFIRMER]** se lèvent dans l'UI Dendreo (navigateur) ou via
> « Tester ce Webhook ». Sources en bas de page.

---

## 1. Événements (events)

**Confirmé** — Dendreo « permet de s'abonner aux différentes actions effectuées sur
le compte » et **POST en JSON temps réel** vers une URL configurée. Events
**Documents / e-signature** confirmés (FAQ art. 545) :

| Event | Usage pour nous |
|---|---|
| **« Un document est signé »** | ✅ **brique temps réel** : attestation signée → bascule miroir |
| « Un document a été uploadé depuis l'**Extranet Participant** » | dépôt manuel d'un signé (cas réel vu en S5, ex. attestation re-uploadée) |
| « Un document a été uploadé depuis l'Extranet **Formateur** » | hors scope participant (LettreDeMission) |
| « Un document a été uploadé depuis l'Extranet **Entreprise** » | hors scope |

**[À CONFIRMER]** — Le **catalogue complet** (notamment *Action de Formation* :
participant ajouté à une ADF = **LAP**, inscrit/désinscrit d'un module = **LMP**,
**émargement**) n'est **pas énuméré dans la FAQ publique**. Dendreo indique que « la
liste s'enrichit continuellement » et se lit dans le **menu déroulant** de la page
de config. Option **« tous les events (existants et futurs) »** disponible.

---

## 2. Payload + Authentification

### Payload — **[À CONFIRMER]**
- La FAQ dit seulement : **JSON**, **temps réel**, via **HTTP POST**.
- **Noms de champs NON documentés** publiquement : `idAdf` ? `idParticipant` ?
  `doctype` ? `statut` ? `dates` ? → inconnu.
- On ne sait pas encore si le payload contient l'**objet complet** ou **juste un id
  à re-fetch**. → **Sans impact sur l'archi choisie** (voir §5 : on re-fetch de toute façon).
- **Comment lever** : bouton **« Tester ce Webhook »** dans l'UI (simule l'event avec
  un payload d'exemple) → capturer le JSON réel.

### Authentification / vérification d'origine — **partiellement confirmé**
- **Confirmé** : Dendreo fournit une **clé secrète** ; il **signe** chaque POST et
  place la **signature dans un header** ; on **valide avec le secret** que le POST
  vient bien de Dendreo (FAQ art. 545).
- **[À CONFIRMER]** : le **nom exact du header** et l'**algorithme** (très
  probablement **HMAC-SHA256** sur le **body brut**, standard du marché — à lire dans
  la section Webhooks du portail dev / l'UI de config).
- **IP whitelisting** : existe pour l'**API** (restreindre à une liste d'IP, art. 543)
  mais **pas mentionné pour les webhooks entrants** → on s'appuie sur la **signature
  HMAC** (+ éventuel filtrage IP si Dendreo publie ses IP sortantes).

### Robustesse (confirmé, FAQ art. 545)
- Si notre endpoint ne répond pas / renvoie une erreur → **5 renvois** avec backoff :
  **~10 s → ~1 min → ~15 min → ~2 h 30 → ~24 h**.
- ⇒ **receveur idempotent OBLIGATOIRE** (un même event peut arriver plusieurs fois).

---

## 3. Abonnement (s'abonner)

**Confirmé — via l'UI** (aucun endpoint API de création documenté → *a priori* UI-only) :
1. Page de config Webhooks → **« Ajouter un Webhook »**.
2. (Titre optionnel) + **URL** de réception.
3. Sélectionner **un ou plusieurs events** (ou cocher **« tous »**).
4. Valider ; **« Tester ce Webhook »** pour simuler avant mise en prod.
5. La **clé secrète** (vérif signature) est fournie sur cette page.

**Multi-centres** (noté S0) : un webhook posé depuis un **sous-centre** ne se
déclenche que pour ce sous-centre → à poser au bon niveau (centre principal
SAS MEDERE, cf. recon S0).

---

## 4. Retries (rappel synthétique)

| Tentative | Délai approx. |
|---|---|
| 1 (initiale) | immédiat |
| 2 | ~10 s |
| 3 | ~1 min |
| 4 | ~15 min |
| 5 | ~2 h 30 |
| 6 | ~24 h |

→ Un webhook manqué (endpoint down < 24 h) est **rattrapé** par les retries ; au-delà,
c'est le **filet backfill** (§5) qui rattrape.

---

## 5. Reco d'architecture (pour décider S8.1)

**Pattern retenu : webhook = déclencheur → re-fetch → upsert idempotent.**

1. **Endpoint public** (Vercel) abonné à **« Un document est signé »**
   (+ **« uploadé depuis l'Extranet Participant »** pour le dépôt manuel d'un signé).
2. **Vérifier la signature HMAC** (rejeter tout POST non signé/invalide) **avant tout
   traitement**. Répondre **2xx rapidement** (accuser réception), traiter derrière.
3. Comme le **payload exact est incertain**, **re-fetch `fichiers.php`** de la session
   concernée (`cible=action-de-formation&id_cible={idAdf}&collection_name=signature`)
   puis **recalcul + upsert idempotent** du miroir (mêmes clés déterministes qu'au
   backfill). ⇒ **robuste que le payload contienne tout ou juste un id.**
4. **Idempotence garantie** par les clés déjà en place :
   `sessions/{idAdf}` et `signatures/{idAdf}_{idParticipant}_{doctypeId}` (last-write-wins).

**Filet de sécurité (à conserver) :**
- **Réconciliation quotidienne** (backfill des sessions actives) → rattrape tout
  webhook perdu au-delà des 5 retries, ou un event non couvert.
- Coût maîtrisé (cf. recon S0 : quota Or 150 k/mois, très large marge).

**Sécurité endpoint (rappel §4 CLAUDE.md) :**
- Le secret HMAC vit dans **`.env.local`** / variables Vercel, **jamais commité, jamais loggé**.
- **Aucune écriture Dendreo** : l'endpoint ne fait que **GET** (re-fetch) + écrire **notre** Firestore.
- Endpoint **read-side only** côté Dendreo ; validation stricte + rejet silencieux des POST non signés.

---

## 6. À lever AVANT de coder S8.1 (tout via l'UI Dendreo, lecture seule — par Déthié)

1. **Payload exact** de « Un document est signé » (via *Tester ce Webhook*) : quels
   champs (idAdf ? idParticipant ? doctype ? date ? statut ?) → confirme si un re-fetch
   est nécessaire ou si le payload suffit.
2. **Nom du header** de signature + **algorithme HMAC** (SHA256 ?) + **sur quoi** porte
   la signature (body brut ? body + timestamp ?).
3. **Liste réelle** des events dans le menu déroulant (confirmer LAP / LMP / émargement
   si on veut tenir à jour la liste des « attendus »).
4. **Sandbox** disponible pour tester sans toucher le prod (article Dendreo « Utiliser
   une Sandbox ») → à privilégier pour S8.1.
5. **IP sortantes** de Dendreo (si publiées) → filtrage IP optionnel en complément du HMAC.

> Tant que le point 1 (payload) et le point 2 (header/HMAC) ne sont pas capturés, on
> **ne fige pas** le vérificateur de signature ni le parsing — on part sur le pattern
> **re-fetch + upsert** qui ne dépend pas du contenu exact du payload.

---

## 7. Sources

- **[Présentation des Webhooks — Dendreo FAQ (art. 545)](https://doc.dendreo.com/article/545-presentation-webhooks)** — events documents/signature, clé secrète + signature dans le header, retries 5×, abonnement UI, « Tester ce Webhook ».
- **[Dois-je utiliser l'API ou un Webhook ? (art. 546)](https://doc.dendreo.com/article/546-utiliser-api-ou-webhook)** — cas d'usage « être prévenu de la signature du document ».
- **[Introduction à l'API et aux Webhooks (art. 544)](https://doc.dendreo.com/article/544-introduction-a-lapi)** — s'abonner aux actions du compte.
- **[Configurer l'API (art. 543)](https://doc.dendreo.com/article/543-configurer-api)** — clés API, permissions par endpoint, **IP whitelisting (API)**.
- **[Portail développeur Dendreo](https://developers.dendreo.com/)** — section Webhooks (SPA non extractible en HTTP ; à lire dans le navigateur pour payload/HMAC exacts).

> Recon menée le : **2026-07-08**. Statut : verdict posé (webhooks OUI), archi recommandée
> (re-fetch + upsert idempotent + filet backfill), 5 points à confirmer avant S8.1.
