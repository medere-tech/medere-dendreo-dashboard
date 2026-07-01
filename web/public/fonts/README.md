# Polices Aileron (auto-hébergées)

Déposer ici les fichiers Aileron `.ttf` **avec ces noms exacts** (référencés par
`src/app/globals.css`) :

- `Aileron-Light.ttf` (300)
- `Aileron-Regular.ttf` (400)
- `Aileron-SemiBold.ttf` (600)
- `Aileron-Bold.ttf` (700)

Tant qu'un fichier manque, la pile de polices système prend le relais (défini
dans `tailwind.config.ts`) et le build ne casse pas.

Si tes fichiers portent d'autres noms, dis-le : j'adapte les `@font-face`.
Police licenciée (TipoType) — ne pas redistribuer hors de ce projet.
