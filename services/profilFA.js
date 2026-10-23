// petia-backend/services/profilFA.js
// Nettoyage des réponses d'une famille d'accueil avant enregistrement :
// liste blanche des champs, valeurs contrôlées, textes bornés.

const crypto = require('crypto');

const ENUMS = {
  type_logement: ['maison', 'appartement', 'autre'],
  hauteur_cloture: ['aucune', 'moins1m', '1m', '1m50', '2m_plus'],
  escaliers: ['non', 'oui_peu', 'oui_etage'],
  etage: ['non', '1_2', '3_plus'],
  vehicule: ['oui', 'parfois', 'non'],
  heures_seul: ['0_2', '2_4', '4_6', '6_8', '8_10', '10_plus'],
  presence_journee: ['oui_toujours', 'oui_parfois', 'non'],
  balades_par_jour: ['1', '2', '3_plus'],
  duree_balade: ['moins15', '15_30', '30_60', '1h_plus'],
  disponible_le: ['maintenant', 'cette_semaine', 'ce_mois', 'non_dispo'],
  experience_chien: ['jamais', 'enfance', '1_2_ans', '3_5_ans', '5_plus_ans'],
};
const LISTES = {
  lieux_promenade: ['jardin_seul', 'quartier_laisse', 'parc_laisse', 'foret_laisse', 'foret_libre'],
  animaux_actuels: ['chien', 'chat', 'autre'],
  duree_accueil: ['quelques_jours', '1_2_semaines', '1_3_mois', 'jusqu_adoption'],
  experiences_gerees: ['chiot', 'traumatise', 'reactif_congeneres', 'reactif_humains', 'anxiete_separation'],
  refus: ['grand_chien', 'tres_energique', 'chiot', 'age', 'soins', 'non_propre', 'malinois', 'staff', 'categorie'],
};
const TEXTES = [
  'motivation', 'attachement', 'duree_longue', 'situation_nuits', 'situation_destruction', 'situation_absence',
  'situation_reactivite', 'situation_morsure', 'situation_consignes', 'situation_decouragement',
  'situation_grogne', 'situation_limite', 'autres_infos',
];

const texte = (v, max = 3000) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

// Champs « logement & quotidien » (page d'inscription)
function nettoyerProfil(b = {}) {
  const out = {};
  for (const [k, vals] of Object.entries(ENUMS)) {
    if (k === 'experience_chien') continue;
    if (b[k] !== undefined) out[k] = vals.includes(b[k]) ? b[k] : null;
  }
  for (const k of ['lieux_promenade', 'animaux_actuels', 'duree_accueil']) {
    if (Array.isArray(b[k])) out[k] = [...new Set(b[k].filter(v => LISTES[k].includes(v)))];
  }
  if (typeof b.jardin === 'boolean') out.jardin = b.jardin;
  if (Array.isArray(b.enfants)) out.enfants = b.enfants.map(v => texte(v, 40)).filter(Boolean).slice(0, 6);
  return out;
}

// Réponses du questionnaire
function nettoyerQuestionnaire(b = {}) {
  const out = {};
  for (const k of TEXTES) if (b[k] !== undefined) out[k] = texte(b[k]);
  if (b.experience_chien !== undefined)
    out.experience_chien = ENUMS.experience_chien.includes(b.experience_chien) ? b.experience_chien : null;
  for (const k of ['experiences_gerees', 'refus']) {
    if (Array.isArray(b[k])) out[k] = [...new Set(b[k].filter(v => LISTES[k].includes(v)))];
  }
  const eng = parseInt(b.engagement, 10);
  if (b.engagement !== undefined) out.engagement = eng >= 1 && eng <= 10 ? eng : null;
  if (b.questionnaire && typeof b.questionnaire === 'object' && !Array.isArray(b.questionnaire)) {
    const json = JSON.stringify(b.questionnaire);
    if (json.length <= 60000) out.questionnaire = b.questionnaire;
  }
  return out;
}

// ─── Jeton d'inscription : permet d'envoyer le questionnaire juste après
// l'inscription, avant toute connexion. Signé par le serveur, valable 24 h,
// utilisable uniquement pour le questionnaire de ce compte.
const SECRET = () => 'petia-questionnaire:' + (process.env.SUPABASE_SERVICE_KEY || '');

function creerJetonInscription(userId, dureeMs = 24 * 3600 * 1000) {
  const payload = Buffer.from(JSON.stringify({ sub: userId, exp: Date.now() + dureeMs })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function lireJetonInscription(jeton) {
  if (typeof jeton !== 'string' || !jeton.includes('.')) return null;
  const [payload, sig] = jeton.split('.');
  const attendu = crypto.createHmac('sha256', SECRET()).update(payload).digest('base64url');
  if (!sig || sig.length !== attendu.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(attendu))) return null;
  try {
    const { sub, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return sub && exp > Date.now() ? sub : null;
  } catch { return null; }
}

module.exports = { nettoyerProfil, nettoyerQuestionnaire, creerJetonInscription, lireJetonInscription, LISTES, ENUMS };
