import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // La racine de l'app est web/ (le repo contient un 2e lockfile à la racine,
  // pour le back-office). On fixe la racine de tracing pour éviter le warning
  // "inferred workspace root" et garder un démarrage sans avertissement.
  outputFileTracingRoot: __dirname,
  // firebase-admin (Admin SDK, requires dynamiques + gRPC) : externalisé → non
  // bundlé, requis au runtime depuis node_modules (tracé depuis web/).
  serverExternalPackages: ['firebase-admin'],
  // Le code serveur du webhook vit dans ../src (partagé avec le backfill, source
  // UNIQUE). webpack le bundle bien (cf. resolve.modules), MAIS le tsc intégré au
  // `next build` ne sait pas résoudre les types de firebase-admin pour un fichier
  // HORS de web/ (résolution relative à ../src, pas de resolve.modules côté tsc).
  // Le type-check est assuré par le script dédié `npm run typecheck` + le hook
  // husky pre-push (tsc), qui résolvent ../src via le node_modules racine.
  typescript: { ignoreBuildErrors: true },
  webpack: (config) => {
    // Le code serveur du webhook est importé via @shared (= ../src, HORS de web/).
    // Ses imports "bare" (firebase-admin) sont résolus relativement à leur PROPRE
    // emplacement (racine du repo) → invisibles sur Vercel qui isole le build dans
    // web/. On ajoute web/node_modules au chemin de résolution GLOBAL pour que ces
    // fichiers trouvent les deps installées dans web/. Build isolé → vert.
    const webNodeModules = path.resolve(__dirname, 'node_modules');
    const existing = config.resolve.modules ?? ['node_modules'];
    config.resolve.modules = [webNodeModules, ...existing.filter((m) => m !== webNodeModules)];
    return config;
  },
};

export default nextConfig;
