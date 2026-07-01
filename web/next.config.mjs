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
};

export default nextConfig;
