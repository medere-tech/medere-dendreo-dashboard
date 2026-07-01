# docs/design-system.md — Direction UI (charte Médéré réelle)

> Consigne Déthié : **intuitive, ≤ 2-3 couleurs Médéré, pas de dégradé, rien de superflu.**
> Charte officielle fournie (UI Kit Médéré + police Aileron). Valeurs réelles ci-dessous, plus rien à supposer.

---

## 1. Principes (non négociables)

- **Intuitif d'abord.** On comprend l'écran en 2 secondes, sans formation.
- **Sobre.** Pas de dégradé. Pas d'ombre tape-à-l'œil. Aucun élément décoratif sans fonction. Du plat, du propre.
- **≤ 3 couleurs.** Concrètement : l'échelle de **neutres** Médéré + **une seule couleur d'accent**. Point.
- **Mobile-first.** Parfait sur téléphone d'abord, puis extension desktop.
- **Hiérarchie claire.** Beaucoup de blanc, typo nette, une seule chose importante par zone.

## 2. Palette retenue (depuis l'UI Kit Médéré)

**Neutres (échelle officielle Médéré)** — c'est la base de toute l'interface :
| Rôle | Hex |
|------|-----|
| Fond app | `#F9F5F2` (Neutral 10) |
| Surfaces / cartes | `#FFFFFF` (Neutral 0) |
| Bordures / séparateurs | `#F0EAE5` (20) → `#DBD6CD` (30) |
| Texte principal | `#302D2D` (100) / `#3F3B3C` (90) |
| Texte secondaire | `#686162` (60) / `#807778` (50) |
| Texte désactivé / méta | `#9C9494` (40) |

**Accent unique — « action / à relancer » :** `#F19953` (l'orange Médéré).
- C'est la **seule** couleur vive de l'interface. Elle ne sert qu'à signaler **ce qui demande une action** (participants à relancer).

**Les 3 statuts (suivi global voulu par Déthié) :**
- 🟧 **À relancer** → **accent orange `#F19953`** (seule couleur vive). Le doc a été envoyé, pas signé → action.
- ✓ **Signé** → **neutre** (✓ + texte `#807778`). C'est « fait », ça ne doit pas attirer l'œil.
- ◌ **Pas encore envoyé** → **neutre** distinct (puce contour/grise + libellé), pas de remplissage coloré. Visible pour le suivi global, mais sans voler la vedette à l'orange.

⇒ Une **seule** couleur vive dans toute l'interface (l'orange = « à relancer »). Signé et pas-encore-envoyé restent en neutres, différenciés par **icône + libellé**.

**Boutons / CTA = NEUTRES.** L'orange n'est **jamais** un bouton, un lien de navigation, ni un CTA (connexion, filtres, actions). Un bouton premium = fond blanc/neutre, bordure fine, texte sombre, hover discret. L'orange ne sert **qu'à** signaler un statut « à relancer ». Cette discipline est ce qui rend l'interface premium : la couleur veut dire quelque chose.

⇒ Résultat : l'œil tombe **directement sur l'orange = le travail à faire**. Le reste est calme.

### ⚠️ Décision explicite : on n'utilise PAS la palette « Specialist »
L'UI Kit contient une rangée de couleurs par spécialité (General `#006E90`, Dentist `#FECA45`, Psychiatrist `#9F84BD`, Pediatrician `#17BEBB`, Gynecologist `#D87DA9`, Radiologist `#F19953`, Others `#2DA131`). **On ne s'en sert pas** pour ce dashboard : ce serait l'arc-en-ciel que Déthié refuse. (L'accent orange retenu se trouve être le `#F19953` de cette palette — cohérent avec la marque, mais utilisé seul.)

## 3. Typographie — Aileron (TipoType, licenciée)

- **Police unique : Aileron.** Fichiers fournis (`.ttf`), à **auto-héberger** dans `public/fonts/` + `@font-face` (pas de CDN, pas de Google Fonts).
- Graisses dispo : UltraLight → Thin → Light → Regular → SemiBold → Bold → Heavy (+ italiques).
- **Usage discipliné (3-4 graisses max en pratique) :**
  - Gros compteurs (« X à relancer ») : **Aileron Light/Regular**, grande taille.
  - Titres de section : **Aileron SemiBold / Bold**.
  - Corps / listes : **Aileron Regular**.
  - Labels / méta : **Aileron Regular**, petite taille, couleur secondaire.

## 4. Accessibilité

- Le statut n'est **jamais** porté uniquement par la couleur : toujours **libellé + icône** (✓ signé / ⏳ à relancer). Indispensable pour daltoniens et lisibilité mobile.
- Contraste texte sur fond conforme (texte `#302D2D` sur `#FFFFFF`/`#F9F5F2` = large marge).

## 5. Écrans (esquisse, à détailler au sprint UI)

1. **Vue transverse (accueil)** — toutes les sessions ; en tête, l'info clé : *combien de participants à relancer, au total et par session*. Tri « plus de retards » / ancienneté. Recherche + filtres simples (période, étape). LA vue impossible à faire à la main.
2. **Détail session** — liste des participants, statut (signé / à relancer / pas encore envoyé), date, **lien de visualisation** direct, ancienneté de la demande.
3. **Mobile** — mêmes infos en cartes empilées, le « à relancer » orange toujours en évidence.

## 6. Interdits

- ❌ Dégradés.
- ❌ La palette « Specialist » (arc-en-ciel).
- ❌ Plus d'une couleur d'accent.
- ❌ Décor sans fonction (illustrations gratuites, animations gadget).
- ❌ Statut porté uniquement par la couleur.
- ❌ Police autre qu'Aileron.
