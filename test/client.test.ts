// test/client.test.ts — Client Dendreo : 429 backoff + clé jamais loggée.
// Pas d'appel réseau réel : fetch et sleep sont injectés.

import { describe, it, expect, vi } from 'vitest';
import { DendreoClient, DendreoError } from '../src/dendreo/client';

const SECRET = 'SECRETKEY1234567890';
const BASE = 'https://pro.dendreo.com/nes_formation/api';

describe('DendreoClient — rate limit 429', () => {
  it('réessaie après un 429 puis renvoie le JSON', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      if (n === 1) return new Response('', { status: 429, headers: { 'retry-after': '0' } });
      return new Response(JSON.stringify([{ id: '1' }]), { status: 200 });
    });
    const client = new DendreoClient({ baseUrl: BASE, apiKey: SECRET, fetchImpl, sleep: async () => {} });
    const data = await client.get<Array<{ id: string }>>('fichiers.php', { id: '1' });
    expect(data).toEqual([{ id: '1' }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('abandonne après maxRetries avec une DendreoError 429', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 429, headers: { 'retry-after': '0' } }));
    const client = new DendreoClient({ baseUrl: BASE, apiKey: SECRET, fetchImpl, sleep: async () => {}, maxRetries: 2 });
    await expect(client.get('fichiers.php')).rejects.toBeInstanceOf(DendreoError);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // 1 + 2 retries
  });
});

describe('DendreoClient — sécurité de la clé', () => {
  it('n\'envoie jamais la clé dans l\'URL (header only)', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).not.toContain(SECRET);
      const auth = (init?.headers as Record<string, string>)?.Authorization ?? '';
      expect(auth).toContain('Token token=');
      return new Response('[]', { status: 200 });
    });
    const client = new DendreoClient({ baseUrl: BASE, apiKey: SECRET, fetchImpl, sleep: async () => {} });
    await client.get('fichiers.php', { cible: 'action-de-formation', id_cible: '3686' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('rédige la clé dans les messages d\'erreur (même si une couche la propage)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`boom Authorization: Token token="${SECRET}"`);
    });
    const client = new DendreoClient({ baseUrl: BASE, apiKey: SECRET, fetchImpl, sleep: async () => {} });
    await expect(client.get('fichiers.php')).rejects.toThrow(/\*\*\*/);
    await client.get('fichiers.php').catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toContain(SECRET);
    });
  });
});
