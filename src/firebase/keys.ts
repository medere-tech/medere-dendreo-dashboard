// src/firebase/keys.ts — Clés de documents DÉTERMINISTES (idempotence).

function assertKeyPart(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Clé Firestore invalide : ${name} vide`);
  }
  if (value.includes('/')) {
    throw new Error(`Clé Firestore invalide : ${name} contient '/'`);
  }
  return value;
}

export function sessionKey(idAdf: string): string {
  return assertKeyPart(idAdf, 'idAdf');
}

export function signatureKey(idAdf: string, idParticipant: string, doctypeId: string): string {
  return `${assertKeyPart(idAdf, 'idAdf')}_${assertKeyPart(idParticipant, 'idParticipant')}_${assertKeyPart(doctypeId, 'doctypeId')}`;
}
