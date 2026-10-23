// petia-backend/services/especes.js
// Référentiel des espèces et nettoyage des réponses propres à chaque espèce.
// Premier temps : chien, chat, NAC. Équidés et ferme sont déjà prévus en base.

const ESPECES = ['chien', 'chat', 'nac'];            // ouvertes à la saisie
const SOUS_ESPECES = {
  nac: ['lapin', 'cobaye', 'rat', 'souris', 'hamster', 'chinchilla', 'furet', 'oiseau', 'tortue', 'reptile', 'autre_nac'],
};
// Petits animaux « proies » : vigilance avec un chat ou un chien au foyer
const NAC_PROIES = ['lapin', 'cobaye', 'rat', 'souris', 'hamster', 'chinchilla', 'oiseau'];

const DETAILS = {
  commun: {
    puce: 'texte', categorie_legale: 'texte', duree_accueil: 'texte', etat_sante: 'texte', problemes_sante: 'liste',
    morsure: 'texte', appartement_ok: ['oui', 'non', 'inc'], jardin_obligatoire: ['oui', 'non', 'inc'],
    tolere_solitude_6h: ['oui', 'non', 'inc'], fa_debutante_ok: ['oui', 'non', 'inc'], date_limite: 'texte',
  },
  chat: {
    exterieur: ['interieur_strict', 'balcon_securise', 'exterieur_requis', 'indifferent'],
    tests: ['negatif', 'fiv', 'felv', 'non_teste'],
    congenere: ['oui', 'prefere', 'seul', 'indifferent'],
    biberon: ['oui', 'non'],
  },
  nac: {
    groupe: ['obligatoire', 'prefere', 'seul', 'indifferent'],
    installation: ['cage', 'grand_enclos', 'enclos_exterieur', 'terrarium', 'voliere', 'liberte'],
    sortie: ['quotidienne', 'occasionnelle', 'non'],
    manipulation: ['facile', 'precautions', 'difficile'],
    dimensions: 'texte', alimentation: 'texte',
  },
};

function nettoyerBloc(bloc, schema) {
  if (!bloc || typeof bloc !== 'object') return undefined;
  const out = {};
  for (const [k, type] of Object.entries(schema)) {
    const v = bloc[k];
    if (v == null || v === '') continue;
    if (type === 'texte' && typeof v === 'string') out[k] = v.trim().slice(0, 1000);
    else if (type === 'liste' && Array.isArray(v)) out[k] = v.filter(x => typeof x === 'string').map(x => x.slice(0, 60)).slice(0, 20);
    else if (Array.isArray(type) && type.includes(v)) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

// Ne garde que les blocs pertinents pour l'espèce
function nettoyerDetailsAnimal(espece, details = {}) {
  const out = {};
  const commun = nettoyerBloc(details.commun, DETAILS.commun);
  if (commun) out.commun = commun;
  if (DETAILS[espece] && espece !== 'commun') {
    const bloc = nettoyerBloc(details[espece], DETAILS[espece]);
    if (bloc) out[espece] = bloc;
  }
  return Object.keys(out).length ? out : null;
}

module.exports = { ESPECES, SOUS_ESPECES, NAC_PROIES, DETAILS, nettoyerDetailsAnimal };
