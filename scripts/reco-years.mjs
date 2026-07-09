// scripts/reco-years.mjs — imprime les années à réconcilier (utilisé par le cron).
//   node/tsx scripts/reco-years.mjs nightly   → "2025 2026"
//   node/tsx scripts/reco-years.mjs monthly   → "2025 2026 …"
// Utilise l'horloge réelle (new Date()) ; la logique pure est dans src/reco/years.ts.
import { monthlyYears, nightlyYears } from '../src/reco/years';

const mode = process.argv[2];
const years =
  mode === 'nightly' ? nightlyYears(new Date()) : mode === 'monthly' ? monthlyYears(new Date()) : null;

if (!years) {
  console.error('usage: reco-years.mjs <nightly|monthly>');
  process.exit(1);
}
console.log(years.join(' '));
