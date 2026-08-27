// test/enrich.test.ts — dérivations d'enrichissement S5.1b (PURES).
// Cas ancrés sur données réelles (docs/recon-s5-findings.md + verify-compte-produit).

import { describe, it, expect } from 'vitest';
import {
  computeFacturableAnneeN,
  deriveEligibleDpc,
  deriveNumeroCompteProduit,
  eppConnecte,
  extractDatesSynchrones,
  formatLabel,
  hasEpp,
  isACheval,
  parseHeures,
  type SessionModuleView,
} from '../src/dendreo/enrich';

const mod = (categorie: string, heuresConnectees: number, numProgrammeDpc = '', eligibleDpc = '1'): SessionModuleView => ({
  categorie,
  heuresConnectees,
  numProgrammeDpc,
  eligibleDpc,
});

describe('formatLabel', () => {
  it('mappe les 4 valeurs prouvées', () => {
    expect(formatLabel('presentiel')).toBe('Présentiel');
    expect(formatLabel('mixte')).toBe('Mixte');
    expect(formatLabel('elearning_async')).toBe('E-learning');
    expect(formatLabel('elearning_sync')).toBe('Classe virtuelle');
  });
  it('valeur inconnue → renvoyée telle quelle ; vide/null → ""', () => {
    expect(formatLabel('autre_mode')).toBe('autre_mode');
    expect(formatLabel('')).toBe('');
    expect(formatLabel(null)).toBe('');
    expect(formatLabel(undefined)).toBe('');
  });
});

describe('isACheval', () => {
  it('true si années différentes (ex. idAdf 2408 : 2024→2025)', () => {
    expect(isACheval('2024-09-25T00:00:00', '2025-01-09T23:59:59')).toBe(true);
  });
  it('false si même année (ex. idAdf 2656 : 2025→2025)', () => {
    expect(isACheval('2025-02-09T00:00:00', '2025-05-31T23:59:59')).toBe(false);
  });
  it('date manquante → false (prudent)', () => {
    expect(isACheval('', '2025-01-01')).toBe(false);
    expect(isACheval('2025-01-01', '')).toBe(false);
    expect(isACheval(null, null)).toBe(false);
  });
});

describe('parseHeures', () => {
  it('parse nombres, virgule décimale, vide/null → 0', () => {
    expect(parseHeures('3.5')).toBe(3.5);
    expect(parseHeures('2')).toBe(2);
    expect(parseHeures('1,5')).toBe(1.5);
    expect(parseHeures('')).toBe(0);
    expect(parseHeures(null)).toBe(0);
    expect(parseHeures(undefined)).toBe(0);
  });
});

describe('eppConnecte (2 booléens indépendants)', () => {
  it('amont connecté (cat 22, h>0) ; aval non (cat 21, h=0) — cas idAdf 2714', () => {
    const mods = [mod('22', 1), mod('13', 7), mod('21', 0)];
    expect(eppConnecte(mods, 'amont')).toBe(true);
    expect(eppConnecte(mods, 'aval')).toBe(false);
  });
  it('aval connecté, amont non — cas idAdf 2691', () => {
    const mods = [mod('22', 0), mod('4', 4), mod('21', 1)];
    expect(eppConnecte(mods, 'amont')).toBe(false);
    expect(eppConnecte(mods, 'aval')).toBe(true);
  });
  it('aucun EPP connecté (h=0 partout) — cas CBCT idAdf 2656', () => {
    const mods = [mod('22', 0), mod('15', 3.5), mod('21', 0)];
    expect(eppConnecte(mods, 'amont')).toBe(false);
    expect(eppConnecte(mods, 'aval')).toBe(false);
  });
  it('pas de module EPP du tout → false', () => {
    expect(eppConnecte([mod('15', 3.5)], 'amont')).toBe(false);
  });
});

describe('hasEpp / deriveEligibleDpc', () => {
  it('hasEpp : ∃ module cat 22 ou 21', () => {
    expect(hasEpp([mod('22', 0), mod('15', 3.5)])).toBe(true);
    expect(hasEpp([mod('15', 3.5), mod('21', 0)])).toBe(true);
    expect(hasEpp([mod('15', 3.5)])).toBe(false); // pas d'EPP
    expect(hasEpp([])).toBe(false);
  });
  it('deriveEligibleDpc : eligible_dpc="1" du module CŒUR', () => {
    // cœur cat 15 = "1" → éligible (les EPP à "0" ne comptent pas)
    expect(deriveEligibleDpc([mod('22', 0, '', '0'), mod('15', 3.5, '', '1'), mod('21', 0, '', '0')])).toBe(true);
    // cœur cat 3 = "0" → non éligible
    expect(deriveEligibleDpc([mod('3', 0, '', '0'), mod('22', 0, '', '1')])).toBe(false);
    // pas de cœur → repli sur le 1er module
    expect(deriveEligibleDpc([mod('22', 0, '', '1')])).toBe(true);
    expect(deriveEligibleDpc([])).toBe(false);
  });
});

describe('deriveNumeroCompteProduit', () => {
  it('ADF renseigné → gardé tel quel (idAdf 2656)', () => {
    const mods = [mod('22', 0, '92622425420'), mod('15', 3.5, '92622425420')];
    expect(deriveNumeroCompteProduit('92622425420', mods)).toBe('92622425420');
  });
  it('ADF vide → num du module CŒUR, PAS l\'EPP (idAdf 2408 : cœur ...368 vs EPP ...382)', () => {
    const mods = [mod('22', 0, '92622425382'), mod('3', 0, '92622425368'), mod('21', 0, '92622425382')];
    expect(deriveNumeroCompteProduit('', mods)).toBe('92622425368');
    expect(deriveNumeroCompteProduit(null, mods)).toBe('92622425368');
  });
  it('ADF vide, modules à num unique (composée CBCT 2895) → ce num', () => {
    const mods = [mod('22', 0, '92622425420'), mod('15', 3.5, '92622425420'), mod('21', 0, '92622425420')];
    expect(deriveNumeroCompteProduit('', mods)).toBe('92622425420');
  });
  it('aucun cœur avec num → repli sur 1er module portant un num', () => {
    expect(deriveNumeroCompteProduit('', [mod('22', 0, '999')])).toBe('999');
  });
  it('aucun num nulle part → null', () => {
    expect(deriveNumeroCompteProduit('', [mod('15', 3.5, '')])).toBeNull();
    expect(deriveNumeroCompteProduit('', [])).toBeNull();
  });
});

// LAM façon lams.php?include=module,creneaux (S12.1 corrigé). `day` = jour Paris naïf.
// ⚠ Le mode du LAM n'entre PLUS dans le calcul : on datte tout créneau, le filtre est le
// FORMAT de la SESSION (2e argument). On force donc des modes de LAM variés/absents.
const lam = (mode: string | undefined, ...days: string[]) => ({
  mode_organisation: mode,
  creneaux: days.map((day) => ({ day })),
});

describe('extractDatesSynchrones (S12.1 corrigé — règle niveau session)', () => {
  it('session mixte avec créneaux → TOUS les jours datés, triés + dédupliqués', () => {
    // LAM de modes variés (présentiel, sync, async, vide) : tous leurs créneaux comptent
    const lams = [
      lam('presentiel', '2026-03-19'),
      lam('elearning_async'), // module async sans créneau
      lam('elearning_sync', '2026-03-12'),
      lam(undefined, '2026-03-19'), // même jour qu'un autre LAM → dédup
    ];
    expect(extractDatesSynchrones(lams, 'mixte')).toEqual(['2026-03-12', '2026-03-19']);
  });

  it('session elearning_sync (CV) avec créneaux → ses jours', () => {
    const lams = [lam('presentiel', '2026-05-02', '2026-01-08'), lam('elearning_sync', '2026-03-30')];
    expect(extractDatesSynchrones(lams, 'elearning_sync')).toEqual(['2026-01-08', '2026-03-30', '2026-05-02']);
  });

  it('session PRÉSENTIEL avec créneaux datés → [] (format hors CV/Mixte) — cas idAdf 3586', () => {
    const lams = [lam('presentiel', '2026-02-10'), lam('presentiel', '2026-02-11'), lam('presentiel', '2026-02-12')];
    expect(extractDatesSynchrones(lams, 'presentiel')).toEqual([]);
  });

  it('session elearning_async → []', () => {
    expect(extractDatesSynchrones([lam('elearning_async'), lam(undefined, '2026-04-01')], 'elearning_async')).toEqual([]);
    // mode session inconnu/vide → [] aussi (prudent)
    expect(extractDatesSynchrones([lam('elearning_sync', '2026-04-01')], '')).toEqual([]);
    expect(extractDatesSynchrones([lam('elearning_sync', '2026-04-01')], null)).toEqual([]);
  });

  it('dédup matin/aprem le même jour → 1 jour', () => {
    // 2 créneaux le même jour dans un LAM, ou répartis sur 2 LAM → 1 seule date
    expect(extractDatesSynchrones([lam('presentiel', '2026-01-19', '2026-01-19')], 'mixte')).toEqual(['2026-01-19']);
    expect(extractDatesSynchrones([lam('presentiel', '2026-01-19'), lam('elearning_sync', '2026-01-19')], 'elearning_sync')).toEqual(['2026-01-19']);
  });

  it('robuste : LAM null, day vide/invalide, creneaux absents → ignorés (jamais de crash)', () => {
    const lams = [
      null,
      { mode_organisation: 'presentiel' }, // aucun créneau
      { mode_organisation: 'presentiel', creneaux: [{ day: '' }, { day: 'pas-une-date' }, {}] },
      lam('presentiel', '2026-02-14'),
    ];
    expect(extractDatesSynchrones(lams, 'mixte')).toEqual(['2026-02-14']);
  });

  it('tolère creneau singulier (objet unique)', () => {
    expect(extractDatesSynchrones([{ mode_organisation: 'presentiel', creneau: { day: '2026-04-01' } }], 'mixte')).toEqual(['2026-04-01']);
  });
});

// --- S18 : computeFacturableAnneeN -------------------------------------------
describe('computeFacturableAnneeN (S18)', () => {
  const TODAY = '2026-08-25'; // jour de référence FIGÉ → tests déterministes

  /** LAM tel que Dendreo le renvoie : catégorie sur le MODULE inclus, date_fin sur le LAM. */
  const lam = (idLam: string, categorie: string, dateFin: string | null) => ({
    id_lam: idLam,
    date_fin: dateFin,
    module: { id_module: `m${idLam}`, id_categorie_module: categorie, intitule: `module ${idLam}` },
  });

  // Cas RÉEL 3818 : amont + cœur finis le 2026-07-08, aval le 2027-01-15.
  const LAMS_3818 = [
    lam('8087', '22', '2026-07-08 23:59:59'), // EPP amont
    lam('8088', '13', '2026-07-08 23:59:59'), // cœur (catégorie NON stable : 13 ici)
    lam('8089', '21', '2027-01-15 23:59:59'), // EPP aval → hors année N
  ];

  it('3818 réel : amont + cœur passés, aval futur → true', () => {
    expect(computeFacturableAnneeN(LAMS_3818, TODAY)).toBe(true);
  });

  it('un seul module non-aval encore à venir → false', () => {
    const lams = [...LAMS_3818, lam('9000', '15', '2026-12-01 23:59:59')]; // cœur "15", futur
    expect(computeFacturableAnneeN(lams, TODAY)).toBe(false);
  });

  it('tout dans le futur → false', () => {
    const lams = [lam('1', '22', '2026-11-01'), lam('2', '13', '2026-12-15'), lam('3', '21', '2027-02-01')];
    expect(computeFacturableAnneeN(lams, TODAY)).toBe(false);
  });

  it('QUE des modules aval (21) → false (rien à facturer côté année N)', () => {
    expect(computeFacturableAnneeN([lam('1', '21', '2025-01-01'), lam('2', '21', '2025-02-01')], TODAY)).toBe(false);
  });

  it('aucun module → false', () => {
    expect(computeFacturableAnneeN([], TODAY)).toBe(false);
  });

  it('BORNE STRICTE : un module qui finit AUJOURD\'HUI n\'est pas passé → false', () => {
    expect(computeFacturableAnneeN([lam('1', '13', `${TODAY} 23:59:59`)], TODAY)).toBe(false);
    // ...et la veille, oui.
    expect(computeFacturableAnneeN([lam('1', '13', '2026-08-24 23:59:59')], TODAY)).toBe(true);
  });

  it('date_fin absente / vide / malformée sur un module non-aval → false (jamais true par défaut)', () => {
    for (const mauvaise of [null, '', '   ', 'pas-une-date', '08/07/2026']) {
      expect(computeFacturableAnneeN([lam('1', '13', mauvaise as string | null)], TODAY)).toBe(false);
    }
    // une seule date illisible suffit à faire tomber une session par ailleurs finie
    expect(computeFacturableAnneeN([lam('1', '13', '2025-01-01'), lam('2', '22', null)], TODAY)).toBe(false);
  });

  it('catégorie portée par le LAM (et non le module) → même résultat', () => {
    const lamsCatSurLam = [
      { id_lam: '1', id_categorie_module: '13', date_fin: '2025-06-01' },
      { id_lam: '2', id_categorie_module: '21', date_fin: '2027-01-15' }, // aval → ignoré
    ];
    expect(computeFacturableAnneeN(lamsCatSurLam, TODAY)).toBe(true);
  });

  it('date_fin portée par le module (et non le LAM) → même résultat', () => {
    const lamsDateSurModule = [
      { id_lam: '1', module: { id_categorie_module: '13', date_fin: '2025-06-01' } },
      { id_lam: '2', module: { id_categorie_module: '21', date_fin: '2027-01-15' } },
    ];
    expect(computeFacturableAnneeN(lamsDateSurModule, TODAY)).toBe(true);
  });

  it('LAM SANS objet module (donc sans catégorie) : IGNORÉ, il ne bloque pas', () => {
    // Sa date est FUTURE et il ne fait pas tomber le flag : le cœur (13) est fini, ça suffit.
    expect(computeFacturableAnneeN([lam('1', '13', '2025-01-01'), { id_lam: '2', date_fin: '2027-05-01' }], TODAY)).toBe(true);
    // Passé : il ne change rien non plus.
    expect(computeFacturableAnneeN([lam('1', '13', '2025-01-01'), { id_lam: '2', date_fin: '2025-05-01' }], TODAY)).toBe(true);
  });

  it('catégorie RÉSOLUE mais VIDE → ignorée ; seule, elle n\'identifie aucune partie N → false', () => {
    expect(computeFacturableAnneeN([{ id_lam: '1', module: { id_categorie_module: '' }, date_fin: '2027-01-01' }], TODAY)).toBe(false);
    // Même passée : un module sans catégorie ne FONDE pas la facturation.
    expect(computeFacturableAnneeN([{ id_lam: '1', module: { id_categorie_module: '' }, date_fin: '2020-01-01' }], TODAY)).toBe(false);
  });

  it('catégorie vide sur le MODULE : pas de repli vers le LAM (la valeur résolue fait autorité)', () => {
    // Le module dit "" (= pas de catégorie) alors que le LAM porte "13". Le module fait foi
    // → module IGNORÉ → aucune partie N identifiée → false. Sans cette règle, le repli
    // lirait "13", classerait le module en partie N et sa date future bloquerait tout.
    const lamAvecCatVideSurModule = { id_lam: '1', id_categorie_module: '13', module: { id_categorie_module: '' }, date_fin: '2027-05-01' };
    expect(computeFacturableAnneeN([lamAvecCatVideSurModule], TODAY)).toBe(false);
    // Le repli LAM fonctionne toujours quand le module N'A PAS la clé (cf. test dédié plus haut).
  });

  it('la catégorie 21 est la SEULE borne : 3, 13, 15, 22… comptent tous en année N', () => {
    const passes = ['3', '13', '15', '22', '99'].map((c, i) => lam(String(i), c, '2025-01-01'));
    expect(computeFacturableAnneeN([...passes, lam('z', '21', '2027-01-01')], TODAY)).toBe(true);
  });

  it('robuste : LAM null / non-objet ignorés, jamais de crash', () => {
    expect(computeFacturableAnneeN([null, undefined, 'x', 42, lam('1', '13', '2025-01-01')], TODAY)).toBe(true);
    expect(computeFacturableAnneeN([null, undefined], TODAY)).toBe(false); // plus aucun module → false
  });

  it('`today` invalide → false (jamais de comparaison hasardeuse)', () => {
    for (const mauvais of ['', 'aujourd\'hui', '2026-8-25', '2026-08-25T10:00:00']) {
      expect(computeFacturableAnneeN([lam('1', '13', '2020-01-01')], mauvais)).toBe(false);
    }
  });

  // --- Correctif 3474 : les modules SANS catégorie ne bloquent plus -----------
  describe('modules sans catégorie (correctif 3474)', () => {
    /** Module de support annexe : présent dans lams.php, mais AUCUNE catégorie. */
    const sansCategorie = (idLam: string, dateFin: string) => ({
      id_lam: idLam,
      date_fin: dateFin,
      module: { id_module: `m${idLam}`, id_categorie_module: '', intitule: 'telechargements' },
    });

    it('1. cas 3474 RÉEL : amont + 2 cœur finis + "telechargements" (sans cat., fin FUTURE) + aval futur → true', () => {
      const lams3474 = [
        lam('a', '22', '2026-07-15 23:59:59'), // EPP amont — fini
        lam('b', '15', '2026-07-15 23:59:59'), // cœur (cat 15) — fini
        lam('c', '15', '2026-08-01 23:59:59'), // 2e cœur — fini
        sansCategorie('d', '2026-12-31 23:59:59'), // support annexe, fin future → NE BLOQUE PLUS
        lam('e', '21', '2027-01-15 23:59:59'), // EPP aval — hors année N
      ];
      expect(computeFacturableAnneeN(lams3474, TODAY)).toBe(true);
    });

    it('2. le même module sans catégorie mais fin PASSÉE → true aussi (cohérent : il est ignoré)', () => {
      const lams = [
        lam('a', '22', '2026-07-15 23:59:59'),
        lam('b', '15', '2026-07-15 23:59:59'),
        sansCategorie('d', '2025-01-01 23:59:59'), // passé
        lam('e', '21', '2027-01-15 23:59:59'),
      ];
      expect(computeFacturableAnneeN(lams, TODAY)).toBe(true);
    });

    it('3. UNIQUEMENT des modules sans catégorie (aucun amont/cœur) → false', () => {
      expect(computeFacturableAnneeN([sansCategorie('d', '2025-01-01')], TODAY)).toBe(false);
      expect(computeFacturableAnneeN([sansCategorie('d', '2025-01-01'), sansCategorie('e', '2025-02-01')], TODAY)).toBe(false);
      // ...même accompagnés d'un aval : toujours aucune partie N identifiée.
      expect(computeFacturableAnneeN([sansCategorie('d', '2025-01-01'), lam('e', '21', '2027-01-15')], TODAY)).toBe(false);
    });

    it('4. un VRAI cœur non fini bloque TOUJOURS, même en présence d\'un module sans catégorie', () => {
      const lams = [
        lam('a', '22', '2026-07-15 23:59:59'), // amont fini
        lam('b', '15', '2026-12-01 23:59:59'), // cœur PAS fini → bloque
        sansCategorie('d', '2026-12-31 23:59:59'),
        lam('e', '21', '2027-01-15 23:59:59'),
      ];
      expect(computeFacturableAnneeN(lams, TODAY)).toBe(false);
    });

    it('5. NON-RÉGRESSION 3818-like : amont + cœur finis, AUCUN module sans catégorie → true', () => {
      const lams = [
        lam('a', '22', '2026-07-08 23:59:59'),
        lam('b', '15', '2026-07-08 23:59:59'),
        lam('c', '21', '2027-01-15 23:59:59'),
      ];
      expect(computeFacturableAnneeN(lams, TODAY)).toBe(true);
    });
  });
});
