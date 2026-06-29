// test/signatures.test.ts — Tests déterministes sur fixtures S0 réelles (sanitisées).
// Aucun appel réseau : on alimente la fonction PURE avec les JSON capturés.

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { computeSignatureStatus } from '../src/dendreo/signatures';
import type { DendreoFichier, DendreoLap } from '../src/dendreo/types';

function loadFixture<T>(name: string): T {
  const url = new URL(`./fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as T;
}

const f3686 = loadFixture<DendreoFichier[]>('fichiers-3686.signature.json');
const f3894 = loadFixture<DendreoFichier[]>('fichiers-3894.signature.json');
const laps3894 = loadFixture<DendreoLap[]>('laps-3894.json');

describe('fixture 3686 — sanity (témoin S0 brut)', () => {
  it('contient 20 docs : 14 signés (signature_date remplie) / 6 en attente', () => {
    expect(f3686).toHaveLength(20);
    const signed = f3686.filter((x) => x.signature_date.trim() !== '');
    const empty = f3686.filter((x) => x.signature_date.trim() === '');
    expect(signed).toHaveLength(14);
    expect(empty).toHaveLength(6);
  });
});

describe('computeSignatureStatus(3686) — après filtre Formateur + doctype + dédup', () => {
  const res = computeSignatureStatus('3686', f3686);

  it('renvoie 11 signés / 5 en attente', () => {
    expect(res.signed).toHaveLength(11);
    expect(res.pending).toHaveLength(5);
  });

  it('exclut le doc Formateur (doctype 79)', () => {
    const all = [...res.signed, ...res.pending];
    // le formateur n'a pas d'id_participant → absent du résultat
    expect(all.every((s) => s.idParticipant && s.idParticipant.length > 0)).toBe(true);
    // 14 signés bruts - 1 formateur signé - 2 doublons signés = 11
    expect(all).toHaveLength(16);
  });

  it('ne contient aucun participant en double (dédup participant×session×doctype)', () => {
    const ids = [...res.signed, ...res.pending].map((s) => s.idParticipant);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('garde le doc SIGNÉ le plus récent pour un participant signé 2× (450439 → 2026-04-12)', () => {
    const a = res.signed.find((s) => s.idParticipant === '450439');
    expect(a?.signatureDate).toBe('2026-04-12T07:02:39.000000Z');
  });

  it('garde le doc EN ATTENTE le plus récent pour un participant en attente 2× (451171 → 2026-04-07)', () => {
    const jw = res.pending.find((s) => s.idParticipant === '451171');
    expect(jw?.sentDate).toBe('2026-04-07T16:44:10.000000Z');
  });

  it('un participant signé 2× ne reste pas en attente (450439 absent de pending)', () => {
    expect(res.pending.some((s) => s.idParticipant === '450439')).toBe(false);
  });

  it('compose le nom = `prenom nom`', () => {
    const cd = res.signed.find((s) => s.idParticipant === '455004');
    expect(cd?.nom).toBe('Prenom455004 NOM455004');
  });

  it('expose le viewerUrl (public_url) sur chaque entrée', () => {
    expect([...res.signed, ...res.pending].every((s) => s.viewerUrl.startsWith('https://'))).toBe(true);
  });

  it('trie les "en attente" du plus ancien au plus récent (priorité de relance)', () => {
    const dates = res.pending.map((s) => Date.parse(s.sentDate));
    const sorted = [...dates].sort((a, b) => a - b);
    expect(dates).toEqual(sorted);
  });
});

describe('computeSignatureStatus(3894) — tous signés, laps réels', () => {
  const res = computeSignatureStatus('3894', f3894, laps3894);
  it('renvoie 3 signés / 0 en attente / 0 notSent (les 3 inscrits ont signé)', () => {
    expect(res.signed).toHaveLength(3);
    expect(res.pending).toHaveLength(0);
    expect(res.notSent).toHaveLength(0);
    expect(new Set(res.signed.map((s) => s.idParticipant)).size).toBe(3);
  });
});

describe('notSent — diff laps ↔ fichiers [test unitaire de la règle de diff]', () => {
  // Cas RÉEL : test/fixtures/laps-3686.json (capture read-only via scripts/capture-laps-3686.mjs).
  // En attendant cette capture, test unitaire déterministe : les 16 participants réels de
  // 3686 (qui ont un doc) + 2 inscrits SYNTHÉTIQUES actifs sans doc (900001/900002) → notSent = ces 2.
  const enrolledIds = [
    ...new Set(
      f3686
        .filter((x) => x.doctype_id === '111')
        .map((x) => x.entite_liee?.Participant?.id_participant)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const mkLap = (id: string): DendreoLap => ({
    id_participant: id, status: '1', lap_status_id: '2',
    participant: { id_participant: id, nom: `NOM${id}`, prenom: `Prenom${id}` },
  });
  const laps3686: DendreoLap[] = [...enrolledIds.map(mkLap), mkLap('900001'), mkLap('900002')];
  const res = computeSignatureStatus('3686', f3686, laps3686);

  it('classe en notSent uniquement les inscrits actifs/identifiés sans aucun fichier', () => {
    expect(res.notSent.map((p) => p.idParticipant).sort()).toEqual(['900001', '900002']);
  });

  it('ne touche pas signed/pending (11/5) et ne reclasse pas un inscrit ayant un doc', () => {
    expect(res.signed).toHaveLength(11);
    expect(res.pending).toHaveLength(5);
    const withFile = new Set([...res.signed, ...res.pending].map((s) => s.idParticipant));
    for (const ns of res.notSent) expect(withFile.has(ns.idParticipant)).toBe(false);
  });

  it('compose le nom des notSent = `prenom nom`', () => {
    expect(res.notSent.find((p) => p.idParticipant === '900001')?.nom).toBe('Prenom900001 NOM900001');
  });

  it('sans laps, notSent est vide (rétro-compatible)', () => {
    expect(computeSignatureStatus('3686', f3686).notSent).toHaveLength(0);
  });
});

describe('règle "attendu" par défaut — exclut non identifiés et inscriptions non actives', () => {
  const base = (over: Partial<DendreoLap>): DendreoLap => ({ status: '1', participant: { nom: 'X', prenom: 'Y' }, ...over });

  it('exclut les participants non identifiés (id absent / "" / "0")', () => {
    const laps: DendreoLap[] = [
      base({ id_participant: '', participant: { id_participant: '', nom: 'A', prenom: 'A' } }),
      base({ id_participant: '0', participant: { id_participant: '0', nom: 'B', prenom: 'B' } }),
      base({ participant: { nom: 'C', prenom: 'C' } }),
    ];
    expect(computeSignatureStatus('3686', f3686, laps).notSent).toHaveLength(0);
  });

  it('exclut les inscriptions non actives (status != "1")', () => {
    const laps: DendreoLap[] = [
      base({ id_participant: '900003', status: '2', participant: { id_participant: '900003', nom: 'D', prenom: 'D' } }),
      base({ id_participant: '900004', status: undefined, participant: { id_participant: '900004', nom: 'E', prenom: 'E' } }),
    ];
    expect(computeSignatureStatus('3686', f3686, laps).notSent).toHaveLength(0);
  });

  it('garde un inscrit identifié ET actif sans doc', () => {
    const laps: DendreoLap[] = [
      base({ id_participant: '900005', status: '1', participant: { id_participant: '900005', nom: 'F', prenom: 'F' } }),
    ];
    expect(computeSignatureStatus('3686', f3686, laps).notSent.map((p) => p.idParticipant)).toEqual(['900005']);
  });
});

describe('option isExpected — surcharge de la règle par défaut', () => {
  it('une règle custom remplace la règle par défaut (ici on accepte les non actifs)', () => {
    const laps: DendreoLap[] = [
      { id_participant: '900001', status: '2', participant: { id_participant: '900001', nom: 'A', prenom: 'A' } },
      { id_participant: '900002', status: '1', participant: { id_participant: '900002', nom: 'B', prenom: 'B' } },
    ];
    const res = computeSignatureStatus('3686', f3686, laps, { isExpected: () => true });
    expect(res.notSent.map((p) => p.idParticipant).sort()).toEqual(['900001', '900002']);
  });
});

describe('option doctypeId', () => {
  it('un doctype inexistant ne matche rien', () => {
    const res = computeSignatureStatus('3686', f3686, [], { doctypeId: '999' });
    expect(res.signed).toHaveLength(0);
    expect(res.pending).toHaveLength(0);
  });

  it('le doctype Formateur (79) ne ramène pas de Participant (entite_liee.Participant absent)', () => {
    const res = computeSignatureStatus('3686', f3686, [], { doctypeId: '79' });
    expect(res.signed).toHaveLength(0);
    expect(res.pending).toHaveLength(0);
  });
});
