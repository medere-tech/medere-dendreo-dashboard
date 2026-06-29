// src/dendreo/redact.ts — Rédaction de la clé API dans toute sortie.
// Règle non négociable : la clé Dendreo n'apparaît JAMAIS en clair (logs, erreurs).

/**
 * Crée une fonction de rédaction. Remplace la clé `secret` par *** partout,
 * et masque par sécurité les formes d'auth (token="...", ?key=...) même si la
 * valeur diffère.
 */
export function makeRedactor(secret?: string): (input: unknown) => string {
  return (input: unknown): string => {
    let s = typeof input === 'string' ? input : String(input);
    if (secret) s = s.split(secret).join('***');
    s = s.replace(/token="[^"]*"/gi, 'token="***"');
    s = s.replace(/([?&]key=)[^&\s]+/gi, '$1***');
    return s;
  };
}
