// src/config.ts — Configuration & constantes Dendreo (lecture seule).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** Constantes prouvées en S0 (voir docs/recon-findings.md). */
export const DENDREO = {
  /** Valeur exacte de `cible` pour une Action de Formation (avec tirets). */
  CIBLE_ADF: 'action-de-formation',
  /** Collection des documents de signature. */
  COLLECTION_SIGNATURE: 'signature',
  /** doctype_id du document suivi par défaut : Convention participant. */
  DOCTYPE_CONVENTION: '111',
} as const;

export interface DendreoEnv {
  apiKey: string;
  baseUrl: string;
}

/**
 * Charge .env.local (si présent) sans dépendance, puis lit l'environnement.
 * Ne logge jamais la valeur de la clé.
 */
export function loadDendreoEnv(): DendreoEnv {
  loadEnvLocalOnce();
  const apiKey = process.env.DENDREO_API_KEY;
  const baseUrl = (process.env.DENDREO_BASE_URL ?? '').replace(/\/+$/, '');
  if (!apiKey) throw new Error('DENDREO_API_KEY manquante (.env.local).');
  if (!baseUrl) throw new Error('DENDREO_BASE_URL manquante (.env.local).');
  return { apiKey, baseUrl };
}

let envLoaded = false;
function loadEnvLocalOnce(): void {
  if (envLoaded) return;
  envLoaded = true;
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const raw = readFileSync(join(root, '.env.local'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2];
      if (key === undefined || val === undefined) continue;
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {
    // .env.local absent : on s'appuiera sur l'environnement déjà présent.
  }
}
