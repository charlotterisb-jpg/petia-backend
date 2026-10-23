// petia-backend/services/matching.js
// Logique de matching animal ↔ famille d'accueil (sans accès base, testable seule).
//
// 1. Règles éliminatoires : une famille qui ne respecte pas une contrainte
//    impérative de l'animal est écartée.
// 2. Score « règles » (0-100) calculé sur les critères connus.
// 3. Score IA (optionnel) sur un profil réduit aux seuls critères utiles :
//    aucun nom, e-mail, téléphone, adresse ni coordonnées GPS n'est transmis.

// ─── Échelles ordonnées ──────────────────────────────────────────────────────
const HEURES = ['0_2', '2_4', '4_6', '6_8', '8_10', '10_plus'];
const CLOTURE = { aucune: 0, moins1m: 0, '1m': 1, '1m50': 2, '2m': 3, '2m_plus': 3 };
const EXPERIENCE_CHIEN = { jamais: 0, enfance: 1, '1_2_ans': 2, '3_5_ans': 3, '5_plus_ans': 4 };
const BALADES = { '1': 1, '2': 2, '3_plus': 3 };

const RECOMMANDATIONS = ['FORT_MATCH', 'BON_MATCH', 'MATCH_POSSIBLE', 'DECONSEILLE', 'INCOMPATIBLE'];

const contient = (liste, mot) =>
  Array.isArray(liste) && liste.some(v => String(v).toLowerCase().includes(mot));

const nonVide = (liste) => Array.isArray(liste) && liste.filter(Boolean).length > 0;

function experienceFamille(f) {
  return Math.max(EXPERIENCE_CHIEN[f.experience_chien] ?? 0, (f.nb_accueils || 0) > 0 ? 3 : 0);
}

// ─── 1. Règles éliminatoires ─────────────────────────────────────────────────
// Renvoie la liste des raisons d'exclusion (vide = famille éligible).
// Une information manquante côté famille n'exclut pas : elle est signalée
// dans les points d'attention et pèse sur le score.
function reglesEliminatoires(animal, f) {
  const raisons = [];

  if (f.disponible_le === 'non_dispo') raisons.push('Famille indisponible');

  // Espèce acceptée
  if (nonVide(f.peut_accueillir) && animal.espece && !contient(f.peut_accueillir, animal.espece))
    raisons.push(`N'accueille pas : ${animal.espece}`);

  // Refus déclarés par la famille dans son questionnaire
  for (const r of refusApplicables(animal, f)) raisons.push(r);

  // Temps seul
  if (animal.temps_seul_max && animal.temps_seul_max !== 'flexible' && f.heures_seul) {
    if (HEURES.indexOf(f.heures_seul) > HEURES.indexOf(animal.temps_seul_max))
      raisons.push('Animal laissé seul trop longtemps');
  }

  // Présence constante
  if (animal.presence_constante === 'oui' && f.presence_journee && f.presence_journee !== 'oui_toujours')
    raisons.push('Présence humaine constante requise');

  // Enfants / congénères
  if (animal.compatible_enfants === false && nonVide(f.enfants))
    raisons.push('Animal non compatible avec des enfants');
  if (animal.compatible_chiens === false && contient(f.animaux_actuels, 'chien'))
    raisons.push('Animal non compatible avec les chiens');
  if (animal.compatible_chats === false && contient(f.animaux_actuels, 'chat'))
    raisons.push('Animal non compatible avec les chats');

  // Clôture
  if (animal.cloture_min && animal.cloture_min !== 'aucune') {
    const hauteur = CLOTURE[f.hauteur_cloture] ?? null;
    if (animal.cloture_min === 'cloture_obligatoire') {
      if (f.jardin === false || hauteur === 0) raisons.push('Jardin clôturé obligatoire');
    } else if (f.jardin === false) {
      raisons.push(`Clôture ${animal.cloture_min} requise (pas de jardin)`);
    } else if (hauteur !== null && hauteur < CLOTURE[animal.cloture_min]) {
      raisons.push(`Clôture ${animal.cloture_min} minimum requise`);
    }
  }

  // Escaliers
  if (animal.escaliers === 'impossible' && (f.escaliers === 'oui_etage' || ['1_2', '3_plus'].includes(f.etage)))
    raisons.push('Animal ne peut pas monter d\'escaliers');
  if (animal.escaliers === 'difficile' && f.etage === '3_plus')
    raisons.push('Trop d\'étages pour l\'animal');

  // Véhicule
  if (animal.vehicule_requis === 'obligatoire' && f.vehicule === 'non')
    raisons.push('Véhicule obligatoire');

  // Expérience
  if (['confirme', 'expert'].includes(animal.experience_fa_requise) &&
      (f.experience_chien || f.nb_accueils != null) && experienceFamille(f) < 3)
    raisons.push('Famille expérimentée obligatoire');

  return raisons;
}

// Refus du questionnaire FA → caractéristiques de l'animal.
// Ne s'appliquent qu'aux chiens (le questionnaire parle de chiens).
const RACES = {
  malinois: /malinois|berger belge/i,
  staff: /staff|amstaff|staffordshire/i,
  categorie: /pit ?bull|boerbull|tosa|rottweiler|amstaff|american staffordshire|mastiff/i,
};
function refusApplicables(animal, f) {
  const refus = Array.isArray(f.refus) ? f.refus : [];
  if (!refus.length || animal.espece !== 'chien') return [];
  const ageMois = (animal.age_annees || 0) * 12 + (animal.age_mois || 0);
  const ageConnu = animal.age_annees != null || animal.age_mois != null;
  const race = animal.race || '';
  const out = [];
  if (refus.includes('grand_chien') && Number(animal.poids_kg) > 25) out.push('La famille refuse les grands chiens (>25 kg)');
  if (refus.includes('tres_energique') && animal.niveau_exercice === 'tres_eleve') out.push('La famille refuse les chiens très énergiques');
  if (refus.includes('chiot') && ageConnu && ageMois < 6) out.push('La famille refuse les chiots');
  if (refus.includes('age') && animal.age_annees > 10) out.push('La famille refuse les chiens âgés (>10 ans)');
  if (refus.includes('non_propre') && /non propre/i.test(animal.comportement || '')) out.push('La famille refuse les chiens non propres');
  for (const k of ['malinois', 'staff', 'categorie'])
    if (refus.includes(k) && RACES[k].test(race)) out.push(`Race refusée par la famille (${race})`);
  return [...new Set(out)];
}

// ─── 2. Score « règles » ─────────────────────────────────────────────────────
function scoreRegles(animal, f) {
  let score = 60;
  const attention = [];

  // Disponibilité
  if (f.disponible_le === 'maintenant') score += 10;
  else if (f.disponible_le === 'cette_semaine') score += 6;
  else if (f.disponible_le === 'ce_mois') score += 2;
  else attention.push('Disponibilité non renseignée');

  // Expérience
  const exp = experienceFamille(f);
  if (animal.experience_fa_requise === 'intermediaire') {
    score += exp >= 2 ? 8 : -8;
    if (exp < 2) attention.push('Expérience préférable pour cet animal');
  } else {
    score += Math.min(exp, 3) * 2;
  }
  if ((f.nb_accueils || 0) > 0) score += 4;
  if (f.note_moyenne) score += Math.round((Number(f.note_moyenne) - 3) * 3);

  // Balades
  const besoin = BALADES[animal.balades_min_jour];
  const offre = BALADES[f.balades_par_jour];
  if (besoin && offre) {
    score += offre >= besoin ? 6 : -10;
    if (offre < besoin) attention.push('Moins de balades que le besoin de l\'animal');
  }

  // Exercice élevé : jardin + longues balades
  if (['eleve', 'tres_eleve'].includes(animal.niveau_exercice)) {
    if (f.jardin) score += 4;
    if (['30_60', '1h_plus'].includes(f.duree_balade)) score += 4;
    else if (f.duree_balade) { score -= 6; attention.push('Balades courtes pour un animal très actif'); }
  }

  // Présence partielle
  if (animal.presence_constante === 'partiel' && f.presence_journee === 'non') {
    score -= 6; attention.push('Peu de présence en journée');
  }

  // Véhicule souhaitable
  if (animal.vehicule_requis === 'souhaitable' && f.vehicule === 'non') {
    score -= 4; attention.push('Pas de véhicule (souhaitable)');
  }

  // Soins réguliers : impossible à détecter avec certitude, on signale
  if (Array.isArray(f.refus) && f.refus.includes('soins') && animal.besoins_specifiques)
    attention.push('La famille préfère éviter les soins réguliers');
  // Expérience déjà vécue avec ce type de difficulté
  const vecu = Array.isArray(f.experiences_gerees) ? f.experiences_gerees : [];
  if (/anxi/i.test(animal.comportement || '') && vecu.includes('anxiete_separation')) score += 4;
  if (/réactiv|reactiv/i.test(animal.comportement || '') && (vecu.includes('reactif_congeneres') || vecu.includes('reactif_humains'))) score += 4;
  if (animal.age_annees === 0 && (animal.age_mois || 0) < 6 && vecu.includes('chiot')) score += 3;
  if (f.engagement) score += Math.round((f.engagement - 5) * 0.8);

  // Compatibilités inconnues : on signale
  if (animal.compatible_enfants == null && nonVide(f.enfants)) attention.push('Compatibilité enfants inconnue');
  if (animal.compatible_chiens == null && contient(f.animaux_actuels, 'chien')) attention.push('Compatibilité chiens inconnue');
  if (animal.compatible_chats == null && contient(f.animaux_actuels, 'chat')) attention.push('Compatibilité chats inconnue');

  // Profil famille incomplet
  const manquants = ['type_logement', 'heures_seul', 'presence_journee', 'experience_chien'].filter(k => f[k] == null);
  if (manquants.length) { score -= manquants.length * 3; attention.push('Profil famille incomplet'); }

  return { score: borne(score), attention };
}

function bonusUrgence(animal) {
  return animal.urgence === 'critique' ? 10 : animal.urgence === 'haute' ? 5 : 0;
}

function borne(n) { return Math.max(0, Math.min(100, Math.round(n))); }

function recommandationDepuisScore(score) {
  if (score >= 85) return 'FORT_MATCH';
  if (score >= 70) return 'BON_MATCH';
  if (score >= 50) return 'MATCH_POSSIBLE';
  return 'DECONSEILLE';
}

// ─── 3. Profils minimisés envoyés à l'IA ─────────────────────────────────────
// Liste blanche : seuls ces champs sortent. Aucun identifiant ni coordonnée.
const CHAMPS_ANIMAL = [
  'espece', 'race', 'age_annees', 'age_mois', 'sexe', 'poids_kg', 'sterilise', 'urgence',
  'compatible_enfants', 'compatible_chiens', 'compatible_chats', 'temps_seul_max',
  'presence_constante', 'balades_min_jour', 'niveau_exercice', 'escaliers', 'cloture_min',
  'sortie_sans_laisse', 'vehicule_requis', 'experience_fa_requise', 'comportement',
  'besoins_specifiques', 'description', 'historique'
];
const CHAMPS_FAMILLE = [
  'type_logement', 'superficie', 'jardin', 'hauteur_cloture', 'escaliers', 'etage', 'vehicule',
  'nb_adultes', 'fumeur', 'heures_seul', 'presence_journee', 'balades_par_jour', 'duree_balade',
  'lieux_promenade', 'experience_chien', 'nb_accueils', 'note_moyenne', 'taille_acceptee',
  'age_accepte', 'duree_accueil', 'disponible_le', 'situation_absence', 'situation_destruction',
  'situation_grogne', 'situation_urgence', 'situation_morsure', 'situation_reactivite',
  'situation_consignes', 'situation_decouragement', 'situation_limite', 'situation_nuits',
  'refus', 'experiences_gerees', 'engagement'
];

function profil(obj, champs) {
  const out = {};
  for (const k of champs) {
    const v = obj[k];
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
    out[k] = typeof v === 'string' && v.length > 500 ? v.slice(0, 500) + '…' : v;
  }
  return out;
}

function profilFamille(f) {
  const p = profil(f, CHAMPS_FAMILLE);
  // Enfants et animaux : on transmet le fait, pas le détail
  p.enfants_au_foyer = nonVide(f.enfants);
  p.chien_au_foyer = contient(f.animaux_actuels, 'chien');
  p.chat_au_foyer = contient(f.animaux_actuels, 'chat');
  return p;
}

const profilAnimal = (a) => profil(a, CHAMPS_ANIMAL);

// Nettoie la réponse de l'IA
function normaliserReponseIA(r) {
  if (!r || typeof r !== 'object') return null;
  const score = Number(r.score);
  if (!Number.isFinite(score)) return null;
  return {
    score: borne(score),
    recommandation: RECOMMANDATIONS.includes(r.recommandation) ? r.recommandation : null,
    points_attention: Array.isArray(r.points_attention) ? r.points_attention.map(String).slice(0, 5) : [],
    resume: typeof r.resume === 'string' ? r.resume.slice(0, 300) : null,
  };
}

// ─── Calcul complet ──────────────────────────────────────────────────────────
// analyserIA : async (profilAnimal, profilFamille) => réponse brute, ou null.
async function calculerMatchs(animal, familles, { analyserIA = null, maxIA = 10, maxResultats = 5 } = {}) {
  const eligibles = [];
  let exclues = 0;

  for (const f of familles) {
    if (reglesEliminatoires(animal, f).length) { exclues++; continue; }
    const r = scoreRegles(animal, f);
    eligibles.push({ famille: f, scoreRegles: r.score, attention: r.attention });
  }

  eligibles.sort((a, b) => b.scoreRegles - a.scoreRegles);
  const candidats = eligibles.slice(0, maxIA);
  const pa = profilAnimal(animal);

  const resultats = await Promise.all(candidats.map(async (c) => {
    let ia = null;
    if (analyserIA) {
      try { ia = normaliserReponseIA(await analyserIA(pa, profilFamille(c.famille))); }
      catch (e) { ia = null; }
    }
    const base = ia ? Math.round(0.4 * c.scoreRegles + 0.6 * ia.score) : c.scoreRegles;
    const bonus = bonusUrgence(animal);
    const score = borne(base + bonus);
    const attention = [...new Set([...(ia?.points_attention || []), ...c.attention])].slice(0, 6);
    return {
      famille_id: c.famille.id,
      score,
      // L'étiquette suit le score final, sauf alerte explicite de l'IA
      recommandation: ['DECONSEILLE', 'INCOMPATIBLE'].includes(ia?.recommandation)
        ? ia.recommandation
        : recommandationDepuisScore(score),
      incompatibilites: attention,
      bonus_urgence: bonus,
      details_score: {
        score_regles: c.scoreRegles,
        score_ia: ia ? ia.score : null,
        resume_ia: ia?.resume || null,
      },
    };
  }));

  resultats.sort((a, b) => b.score - a.score);
  return {
    total: familles.length,
    exclues,
    eligibles: eligibles.length,
    resultats: resultats.slice(0, maxResultats),
  };
}

module.exports = {
  calculerMatchs, reglesEliminatoires, scoreRegles, profilAnimal, profilFamille,
  normaliserReponseIA, recommandationDepuisScore,
};
