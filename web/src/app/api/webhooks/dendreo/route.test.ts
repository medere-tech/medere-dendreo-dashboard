import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeSignature } from '@/lib/server/webhook-verify';

// Mock de la synchro (Dendreo + Firestore Admin) → tests hermétiques, aucun I/O.
vi.mock('@shared/dendreo/sync', () => ({
  syncSession: vi.fn(async (idAdf: string) => ({ idAdf, found: true, attestations: 3 })),
}));

import { syncSession } from '@shared/dendreo/sync';
import { POST } from './route';

const SECRET = 'whsec-route-test';

const ATTESTATION = {
  event: 'media.signed',
  media: { id: '111703', cible: 'action-de-formation', id_cible: '2691', name: 'Attestation_honneur_EPP aval_2025', url: 'https://x' },
  signatures: [{ signataire: 'p1', date: '2026-07-08', destinataire_type: 'Participant', destinataire_id: '450439' }],
  timestamp: '2026-07-08T10:00:00Z',
};

/** Construit une requête POST signée (par défaut avec le bon secret). */
function req(payload: unknown, opts: { secret?: string; sig?: string } = {}): Request {
  const raw = JSON.stringify(payload);
  const sig = opts.sig ?? computeSignature(raw, opts.secret ?? SECRET);
  return new Request('https://app/api/webhooks/dendreo', { method: 'POST', body: raw, headers: { Signature: sig } });
}
const withMedia = (over: Record<string, unknown>) => ({ ...ATTESTATION, media: { ...ATTESTATION.media, ...over } });

describe('POST /api/webhooks/dendreo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DENDREO_WEBHOOK_SECRET = SECRET;
  });

  it('signature valide + attestation → 200 + syncSession(idAdf)', async () => {
    const res = await POST(req(ATTESTATION));
    expect(res.status).toBe(200);
    expect(syncSession).toHaveBeenCalledTimes(1);
    expect(syncSession).toHaveBeenCalledWith('2691');
    expect(await res.json()).toMatchObject({ ok: true, idAdf: '2691' });
  });

  it('Convention → 200 ignoré, AUCUN sync', async () => {
    const res = await POST(req(withMedia({ name: 'Convention_Participant_Formation_Medere' })));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(syncSession).not.toHaveBeenCalled();
  });

  it('cible ≠ action-de-formation → 200 ignoré, AUCUN sync', async () => {
    const res = await POST(req(withMedia({ cible: 'participant' })));
    expect(res.status).toBe(200);
    expect(syncSession).not.toHaveBeenCalled();
  });

  it('signature invalide → 401, AUCUN sync', async () => {
    const res = await POST(req(ATTESTATION, { sig: 'deadbeef' }));
    expect(res.status).toBe(401);
    expect(syncSession).not.toHaveBeenCalled();
  });

  it('body altéré (mauvais secret) → 401, AUCUN sync', async () => {
    const res = await POST(req(ATTESTATION, { secret: 'mauvais-secret' }));
    expect(res.status).toBe(401);
    expect(syncSession).not.toHaveBeenCalled();
  });

  it('rejeu (5 retries Dendreo) → 200 chaque fois, même idAdf (idempotent par clés déterministes)', async () => {
    const r1 = await POST(req(ATTESTATION));
    const r2 = await POST(req(ATTESTATION));
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(syncSession).toHaveBeenCalledTimes(2);
    expect(syncSession).toHaveBeenNthCalledWith(1, '2691');
    expect(syncSession).toHaveBeenNthCalledWith(2, '2691');
    // pas de doublon : upsert par sessions/{idAdf} + signatures/{idAdf}_{idParticipant}_{doctypeId}
  });
});
