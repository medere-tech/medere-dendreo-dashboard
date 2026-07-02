// test/signatures.test.ts — Règle ATTESTATION (docs/signature-rule.md) sur fixture
// RÉELLE sanitisée + cas synthétiques. Aucun appel réseau : fonction PURE.

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { computeSignatureStatus, isTrackedAttestation, normalizeDocName } from '../src/dendreo/signatures';
import type { DendreoFichier } from '../src/dendreo/types';

function loadFixture<T>(name: string): T {
  const url = new URL(`./fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as T;
}

/** Fabrique un fichier signature de test (défauts = attestation Participant en attente). */
function mkFichier(over: Partial<DendreoFichier> & { name: string }): DendreoFichier {
  return {
    id: over.id ?? 'x',
    collection_name: over.collection_name ?? 'signature',
    name: over.name,
    doctype_id: over.doctype_id ?? '177',
    signature_date: over.signature_date ?? '',
    created_at: over.created_at ?? '2026-01-01T00:00:00.000000Z',
    cible: over.cible ?? 'action-de-formation',
    id_cible: over.id_cible ?? '999',
    public_url: over.public_url ?? 'https://extranet.example/viewer/x',
    entite_liee:
      over.entite_liee !== undefined ? over.entite_liee : { Participant: { id_participant: 'p1', prenom: 'A', nom: 'B' } },
  };
}
const participant = (id: string) => ({ Participant: { id_participant: id, prenom: 'A', nom: 'B' } });

// ---------------------------------------------------------------------------
describe('normalizeDocName / isTrackedAttestation', () => {
  it('normalise (minuscules + sans accents + trim)', () => {
    expect(normalizeDocName("  Attestation sur l'honneur PI_2026 ")).toBe("attestation sur l'honneur pi_2026");
  });
  it('tracke un nom commençant par "Attestation" ciblant un Participant', () => {
    expect(isTrackedAttestation(mkFichier({ name: 'Attestation EPP amont' }))).toBe(true);
  });
  it('exclut Convention (ne commence pas par attestation)', () => {
    expect(isTrackedAttestation(mkFichier({ name: 'Convention_Participant_Formation_Médéré' }))).toBe(false);
  });
  it('exclut une "Attestation" ciblant un Formateur', () => {
    expect(
      isTrackedAttestation(mkFichier({ name: 'Attestation X', entite_liee: { Formateur: { id_participant: 'f1' } } })),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('fixture RÉELLE ADF_20250540 (idAdf 3356) — oracle §6 : 6 / 5 / 1', () => {
  const fichiers = loadFixture<DendreoFichier[]>('attestations-3356.signature.json');
  const res = computeSignatureStatus('3356', fichiers);

  it('la fixture contient 7 docs (1 LettredeMission Formateur + 6 attestations)', () => {
    expect(fichiers).toHaveLength(7);
  });

  it('compteurs = oracle 6/5/1 + participants 6/1', () => {
    expect(res.counts).toEqual({
      envoyes: 6,
      signes: 5,
      nonSignes: 1,
      participantsConcernes: 6,
      participantsARelancer: 1,
    });
  });

  it('invariant signes + nonSignes == envoyes', () => {
    expect(res.counts.signes + res.counts.nonSignes).toBe(res.counts.envoyes);
  });

  it('exclut le doc Formateur (doctype 79 / LettredeMission)', () => {
    expect(res.attestations).toHaveLength(6);
    expect(res.attestations.every((a) => a.doctypeId === '177')).toBe(true);
    expect(res.attestations.every((a) => normalizeDocName(a.documentName).startsWith('attestation'))).toBe(true);
    expect(res.attestations.some((a) => a.idParticipant === 'p1')).toBe(false); // p1 = le formateur
  });

  it('les signées ont une signatureDate ; la seule pending a signatureDate null + sentDate présent', () => {
    const signed = res.attestations.filter((a) => a.status === 'signed');
    const pending = res.attestations.filter((a) => a.status === 'pending');
    expect(signed).toHaveLength(5);
    expect(signed.every((a) => a.signatureDate && a.viewerUrl)).toBe(true);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.signatureDate).toBeNull();
    expect(typeof pending[0]?.sentDate).toBe('string');
  });
});

// ---------------------------------------------------------------------------
describe('dédup (idAdf, idParticipant, doctypeId) — garde le signé', () => {
  it('même participant × doctype, un signé + un en attente → 1 ligne signée', () => {
    const res = computeSignatureStatus('S', [
      mkFichier({ name: 'Attestation PI', entite_liee: participant('p9'), doctype_id: '177', signature_date: '' }),
      mkFichier({ name: 'Attestation PI', entite_liee: participant('p9'), doctype_id: '177', signature_date: '2026-05-01T10:00:00.000000Z' }),
    ]);
    expect(res.counts.envoyes).toBe(1);
    expect(res.attestations).toHaveLength(1);
    expect(res.attestations[0]?.status).toBe('signed');
  });

  it('doublon même statut → garde le created_at le plus récent', () => {
    const res = computeSignatureStatus('S', [
      mkFichier({ name: 'Attestation PI', entite_liee: participant('p9'), created_at: '2026-04-01T00:00:00.000000Z' }),
      mkFichier({ name: 'Attestation PI', entite_liee: participant('p9'), created_at: '2026-04-09T00:00:00.000000Z' }),
    ]);
    expect(res.attestations).toHaveLength(1);
    expect(res.attestations[0]?.sentDate).toBe('2026-04-09T00:00:00.000000Z');
  });
});

// ---------------------------------------------------------------------------
describe('granularité PAR attestation (pas par participant)', () => {
  it('même participant : signé sur un module, à relancer sur un autre → 2 lignes, 1 concerné, 1 à relancer', () => {
    const res = computeSignatureStatus('S', [
      mkFichier({ name: 'Attestation EPP amont', entite_liee: participant('p1'), doctype_id: '165', signature_date: '2026-05-01T10:00:00.000000Z' }),
      mkFichier({ name: 'Attestation EPP aval', entite_liee: participant('p1'), doctype_id: '166', signature_date: '' }),
    ]);
    expect(res.counts).toEqual({
      envoyes: 2,
      signes: 1,
      nonSignes: 1,
      participantsConcernes: 1,
      participantsARelancer: 1,
    });
  });
});

// ---------------------------------------------------------------------------
describe('filtre : rien à suivre', () => {
  it('aucune attestation (que des Conventions) → compteurs à zéro', () => {
    const res = computeSignatureStatus('S', [
      mkFichier({ name: 'Convention_Participant_Formation_Médéré', doctype_id: '111', signature_date: '2026-05-01T10:00:00.000000Z' }),
    ]);
    expect(res.attestations).toHaveLength(0);
    expect(res.counts).toEqual({ envoyes: 0, signes: 0, nonSignes: 0, participantsConcernes: 0, participantsARelancer: 0 });
  });
});
