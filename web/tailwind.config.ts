import type { Config } from 'tailwindcss';

/**
 * Design tokens Médéré (réf. docs/design-system.md).
 * Contrainte non négociable : échelle de NEUTRES + UNE seule couleur d'accent
 * (orange #F19953 = "à relancer"). Aucun dégradé, aucune autre couleur vive.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Neutres officiels Médéré
        canvas: '#F9F5F2', //  fond app (Neutral 10)
        surface: '#FFFFFF', // cartes / surfaces (Neutral 0)
        hairline: '#DBD6CD', // bordures (30)
        'hairline-soft': '#F0EAE5', // séparateurs légers (20)
        ink: '#302D2D', // texte principal (100)
        'ink-soft': '#3F3B3C', // texte fort alt (90)
        muted: '#686162', // texte secondaire (60)
        'muted-2': '#807778', // texte secondaire alt (50)
        faint: '#9C9494', // méta / désactivé (40)

        // Accent UNIQUE — "à relancer" / action
        accent: '#F19953',
      },
      fontFamily: {
        sans: [
          'Aileron',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Helvetica',
          'Arial',
          'sans-serif',
        ],
      },
      transitionDuration: {
        DEFAULT: '180ms',
      },
    },
  },
  plugins: [],
};

export default config;
