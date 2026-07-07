// scripts/verify-compte-produit.mjs — VÉRIF read-only AVANT re-backfill (S5.1b).
// Applique la RÈGLE SHIPPÉE (src/dendreo/enrich.ts) sur 8 sessions variées (dont
// composées) et imprime : numeroComplet · modules {cat, num_programme_dpc, h_conn}
// · numéro choisi. Aucune écriture. À comparer à Dendreo avant de figer.
import { loadDendreoEnv } from '../src/config';
import { DendreoClient } from '../src/dendreo/client';
import { deriveNumeroCompteProduit, eppConnecte, formatLabel, isACheval, parseHeures } from '../src/dendreo/enrich';

const c = new DendreoClient(loadDendreoEnv());
const A = (j) => (Array.isArray(j) ? j : j && Array.isArray(j.data) ? j.data : j == null ? [] : [j]);

// 8 sessions variées : composées (EPP + cœur), CBCT comptable rempli vs vide, Ménopause, etc.
const IDS = [
  2656, // CBCT — numero_comptable RENSEIGNÉ (contrôle : la règle doit garder l'ADF)
  2895, // CBCT — comptable VIDE, composée (EPP 21/22 + cœur cat 15)
  2408, // Dermatoscopie — composée, cœur cat 3 (num différent des EPP) ⚠
  2714, // Cannabis — composée, EPP amont CONNECTÉ (h_conn>0)
  2691, // session du bug doctypeId — modules multiples
  3894, // Ménopause (S0) — composée elearning_async
  2734, // CBCT 25.014
  3921, // "Formation validante CBCT" — num_session_dpc vide
];

async function fetchModules(idAdf) {
  const lams = A(await c.get('lams.php', { id_action_de_formation: idAdf, include: 'module' }));
  const out = [];
  for (const l of lams) {
    const m = l.module;
    if (m && m.id_module) {
      out.push({
        idModule: String(m.id_module),
        categorie: String(m.id_categorie_module ?? ''),
        heuresConnectees: parseHeures(m.c_nombre_dheures_connectees),
        numProgrammeDpc: String(m.num_programme_dpc ?? '').trim(),
      });
    }
  }
  return out;
}

console.log('\n===== VÉRIFICATION N° COMPTE PRODUIT (règle enrich.ts) — AVANT re-backfill =====\n');
for (const id of IDS) {
  const adf = A(await c.get('actions_de_formation.php', {
    id, fields: 'id_action_de_formation,numero_complet,num_session_dpc,numero_comptable,mode_organisation,date_debut,date_fin',
  }))[0];
  if (!adf) { console.log(`idAdf=${id} : introuvable\n`); continue; }
  const mods = await fetchModules(id);
  const choisi = deriveNumeroCompteProduit(adf.numero_comptable, mods);
  const nums = new Set(mods.map((m) => m.numProgrammeDpc).filter(Boolean));
  const composee = nums.size > 1 || (mods.some((m) => m.categorie === '22' || m.categorie === '21') && mods.some((m) => m.categorie !== '22' && m.categorie !== '21'));

  console.log(`● ${adf.numero_complet}  (idAdf=${id}, dpc=${adf.num_session_dpc || '-'})  "${String(adf.intitule ?? '').slice(0, 40)}"`);
  console.log(`   ADF.numero_comptable = ${JSON.stringify(adf.numero_comptable)} ${adf.numero_comptable ? '(présent → utilisé tel quel)' : '(VIDE → dérivé du module cœur)'}`);
  console.log(`   format=${formatLabel(adf.mode_organisation)}  aCheval=${isACheval(adf.date_debut, adf.date_fin)}  ${composee ? '⟨COMPOSÉE⟩' : ''}`);
  console.log('   modules :');
  for (const m of mods) {
    const tag = m.categorie === '22' ? ' [EPP amont]' : m.categorie === '21' ? ' [EPP aval]' : ' [cœur]';
    console.log(`     cat=${String(m.categorie).padEnd(3)} num_programme_dpc=${(m.numProgrammeDpc || '∅').padEnd(13)} h_conn=${m.heuresConnectees}${tag}`);
  }
  console.log(`   eppAmontConnecte=${eppConnecte(mods, 'amont')}  eppAvalConnecte=${eppConnecte(mods, 'aval')}`);
  console.log(`   ➜ numeroCompteProduit CHOISI = ${JSON.stringify(choisi)}\n`);
}
console.log('===== FIN (aucune écriture, aucun re-backfill) =====');
