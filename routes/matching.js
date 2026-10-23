// petia-backend/routes/matching.js
// Matching animal ↔ familles d'accueil
//   POST  /api/matching/:animalId        → (re)lance le matching, renvoie les matchs
//   GET   /api/matching/:animalId        → matchs enregistrés pour l'animal
//   PATCH /api/matching/match/:matchId   → { statut: 'accepte' | 'refuse' }
// Variables d'env : SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY (optionnelle)

const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { analyserMatch, iaDisponible } = require('../services/claude');
const { calculerMatchs } = require('../services/matching');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY // clé serveur : nécessaire avec RLS activé
);

// Colonnes famille utiles au matching (jamais password_hash, tokens, notes internes)
const COLONNES_FAMILLE_MATCHING = [
  'id', 'type_logement', 'superficie', 'jardin', 'hauteur_cloture', 'escaliers', 'etage',
  'vehicule', 'nb_adultes', 'enfants', 'animaux_actuels', 'fumeur', 'heures_seul',
  'presence_journee', 'balades_par_jour', 'duree_balade', 'lieux_promenade', 'experience_chien',
  'nb_accueils', 'note_moyenne', 'peut_accueillir', 'taille_acceptee', 'age_accepte',
  'duree_accueil', 'disponible_le', 'situation_absence', 'situation_destruction',
  'situation_grogne', 'situation_urgence', 'situation_morsure', 'situation_reactivite',
  'situation_consignes', 'situation_decouragement', 'situation_limite', 'situation_nuits',
  'refus', 'experiences_gerees', 'engagement', 'nac_acceptes', 'criteres_especes'
].join(',');

// Ce que le refuge voit de la famille dans la liste des matchs
const COLONNES_FAMILLE_AFFICHAGE =
  'prenom, ville, code_postal, type_logement, jardin, nb_accueils, note_moyenne, disponible_le, experience_chien';

// Session : contrôle commun (exige le code si la double authentification est activée)
const requireAuth = require('../middleware/session').requireUser;

async function animalDuRefuge(animalId, refugeId) {
  const { data } = await supabase.from('animaux').select('*').eq('id', animalId).single();
  return data && data.refuge_id === refugeId ? data : null;
}

async function listerMatchs(animalId) {
  const { data, error } = await supabase
    .from('matchs')
    .select(`id, score, recommandation, incompatibilites, details_score, bonus_urgence, statut, created_at,
             famille:familles_accueil(${COLONNES_FAMILLE_AFFICHAGE})`)
    .eq('animal_id', animalId)
    .order('score', { ascending: false });
  if (error) throw error;
  return data || [];
}

// ─── Moteur : calcule et enregistre les matchs d'un animal ───────────────────
async function lancerMatching(animal) {
  const { data: familles, error } = await supabase
    .from('familles_accueil')
    .select(COLONNES_FAMILLE_MATCHING)
    .eq('statut_dossier', 'valide');
  if (error) throw error;

  // Familles déjà engagées (acceptée, refusée, en cours…) : on ne les repropose pas
  const { data: existants } = await supabase
    .from('matchs').select('famille_id, statut').eq('animal_id', animal.id);
  const dejaTraitees = new Set((existants || []).filter(m => m.statut !== 'propose').map(m => m.famille_id));

  const calcul = await calculerMatchs(
    animal,
    (familles || []).filter(f => !dejaTraitees.has(f.id)),
    { analyserIA: iaDisponible() ? analyserMatch : null }
  );

  // On remplace les anciennes propositions par les nouvelles
  await supabase.from('matchs').delete().eq('animal_id', animal.id).eq('statut', 'propose');
  if (calcul.resultats.length) {
    const { error: insErr } = await supabase.from('matchs').insert(
      calcul.resultats.map(r => ({ ...r, animal_id: animal.id, statut: 'propose' }))
    );
    if (insErr) throw insErr;
  }

  return {
    familles_validees: calcul.total,
    exclues_par_regles: calcul.exclues,
    eligibles: calcul.eligibles,
    ia_utilisee: iaDisponible(),
  };
}

// ─── Routes ──────────────────────────────────────────────────────────────────
router.post('/:animalId', requireAuth, async (req, res) => {
  try {
    const animal = await animalDuRefuge(req.params.animalId, req.user.id);
    if (!animal) return res.status(404).json({ message: 'Animal introuvable.' });
    const stats = await lancerMatching(animal);
    return res.json({ ...stats, matchs: await listerMatchs(animal.id) });
  } catch (e) {
    console.error('POST /matching error:', e);
    return res.status(500).json({ message: 'Erreur lors du matching.' });
  }
});

router.get('/:animalId', requireAuth, async (req, res) => {
  try {
    const animal = await animalDuRefuge(req.params.animalId, req.user.id);
    if (!animal) return res.status(404).json({ message: 'Animal introuvable.' });
    return res.json({ matchs: await listerMatchs(animal.id) });
  } catch (e) {
    console.error('GET /matching error:', e);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

router.patch('/match/:matchId', requireAuth, async (req, res) => {
  try {
    const { statut } = req.body || {};
    if (!['accepte', 'refuse'].includes(statut))
      return res.status(400).json({ message: 'Statut invalide.' });

    const { data: match } = await supabase
      .from('matchs').select('id, animal_id').eq('id', req.params.matchId).single();
    if (!match || !(await animalDuRefuge(match.animal_id, req.user.id)))
      return res.status(404).json({ message: 'Match introuvable.' });

    const { error } = await supabase
      .from('matchs').update({ statut, updated_at: new Date().toISOString() }).eq('id', match.id);
    if (error) throw error;
    return res.json({ message: statut === 'accepte' ? 'Match validé.' : 'Match refusé.' });
  } catch (e) {
    console.error('PATCH /matching error:', e);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

module.exports = router;
module.exports.lancerMatching = lancerMatching;
