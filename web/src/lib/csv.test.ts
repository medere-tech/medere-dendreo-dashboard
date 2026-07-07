import { describe, it, expect } from 'vitest';
import { buildCsv, csvEscape } from './csv';

describe('csvEscape (séparateur ";")', () => {
  it('valeur simple → inchangée', () => {
    expect(csvEscape('Prévention')).toBe('Prévention');
  });
  it('contient ";" → mise entre guillemets', () => {
    expect(csvEscape('Dupont; Jean')).toBe('"Dupont; Jean"');
  });
  it('contient un guillemet → doublé + entouré', () => {
    expect(csvEscape('12" pouces')).toBe('"12"" pouces"');
  });
  it('contient un saut de ligne → entouré', () => {
    expect(csvEscape('ligne1\nligne2')).toBe('"ligne1\nligne2"');
  });
  it('respecte un séparateur alternatif', () => {
    expect(csvEscape('a,b', ',')).toBe('"a,b"');
    expect(csvEscape('a,b', ';')).toBe('a,b'); // "," non spécial si sép = ";"
  });
});

describe('buildCsv', () => {
  it('entêtes + lignes, séparateur ";" et fins CRLF', () => {
    const csv = buildCsv(['A', 'B'], [['1', '2'], ['3', '4']]);
    expect(csv).toBe('A;B\r\n1;2\r\n3;4');
  });
  it('échappe chaque cellule ; nulls déjà en "" en amont', () => {
    const csv = buildCsv(['X', 'Y'], [['a;b', 'c"d']]);
    expect(csv).toBe('X;Y\r\n"a;b";"c""d"');
  });
  it('sans lignes → juste l\'entête', () => {
    expect(buildCsv(['A', 'B'], [])).toBe('A;B');
  });
});
