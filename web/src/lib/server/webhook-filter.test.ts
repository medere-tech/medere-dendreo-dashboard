import { describe, it, expect } from 'vitest';
import { decideWebhook, isAttestationName, type DendreoWebhookPayload } from './webhook-filter';

/** Payload "media.signed" valide, avec surcharge du media. */
const evt = (media: Record<string, unknown> = {}): DendreoWebhookPayload => ({
  event: 'media.signed',
  media: { cible: 'action-de-formation', id_cible: '2691', name: 'Attestation_honneur_EPP amont_2025', ...media },
});

describe('decideWebhook', () => {
  it('media.signed + ADF + attestation → process(idAdf)', () => {
    expect(decideWebhook(evt())).toEqual({ action: 'process', idAdf: '2691' });
  });
  it('Convention (nom ≠ attestation) → ignore, aucun idAdf', () => {
    const d = decideWebhook(evt({ name: 'Convention_Participant_Formation_Medere' }));
    expect(d.action).toBe('ignore');
  });
  it('cible ≠ action-de-formation → ignore', () => {
    expect(decideWebhook(evt({ cible: 'participant' })).action).toBe('ignore');
  });
  it('event ≠ media.signed → ignore', () => {
    expect(decideWebhook({ event: 'media.uploaded', media: evt().media }).action).toBe('ignore');
    expect(decideWebhook({}).action).toBe('ignore');
  });
  it('id_cible manquant → ignore', () => {
    expect(decideWebhook(evt({ id_cible: '' })).action).toBe('ignore');
  });
  it('id_cible numérique coercé en string', () => {
    expect(decideWebhook(evt({ id_cible: 2691 as unknown as string })).action === 'process').toBe(true);
  });
});

describe('isAttestationName (règle normalizeDocName partagée)', () => {
  it('accent/case-insensible + préfixe "attestation"', () => {
    expect(isAttestationName("Attestation sur l'honneur PI_2026")).toBe(true);
    expect(isAttestationName('Attestation_honneur_EPP aval_2025')).toBe(true);
    expect(isAttestationName('Convention_Participant_Formation_Medere')).toBe(false);
    expect(isAttestationName('LettredeMission_Form')).toBe(false);
    expect(isAttestationName(undefined)).toBe(false);
  });
});
