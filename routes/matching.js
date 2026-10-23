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
    .select(`id, score, recommandation, incompatibilites, details_score, bonus_urgence, statut, reponse_fa, date_reponse_fa, date_debut_accueil, date_fin_accueil, created_at,
             famille:familles_accueil(${COLONNES_FAMILLE_AFFICHAGE})`)
    .eq('animal_id', animalId)
    .order('score', { ascending: false });
  if (error) throw error;
  return data || [];
}

// ─── Moteur : calcule et enregistre les matchs d'un animal ───────────────────
async function lancerMatching(animal) {
  // Pas de proposition pour l'animal d'un refuge non validé
  const { data: refuge } = await supabase.from('refuges').select('statut').eq('id', animal.refuge_id).maybeSingle();
  if (refuge?.statut !== 'actif')
    return { familles_validees: 0, exclues_par_regles: 0, eligibles: 0, ia_utilisee: false, refuge_non_valide: true };

  const { data: familles, error } = await supabase
    .from('familles_accueil')
    .select(COLONNES_FAMILLE_MATCHING)
    .eq('statut_dossier', 'valide');
  if (error) throw error;

  // Familles déjà engagées (acceptée, refusée, en cours…) : on ne les repropose pas
  const { data: existants } = await supabase
    .from('matchs').select('famille_id, statut').eq('animal_id', animal.id);
  // « annule » = proposition close parce que l'animal était placé ailleurs : la famille redevient éligible
  const dejaTraitees = new Set((existants || []).filter(m => !['propose', 'annule'].includes(m.statut)).map(m => m.famille_id));

  const calcul = await calculerMatchs(
    animal,
    (familles || []).filter(f => !dejaTraitees.has(f.id)),
    { analyserIA: iaDisponible() ? analyserMatch : null }
  );

  // On remplace les anciennes propositions par les nouvelles
  await supabase.from('matchs').delete().eq('animal_id', animal.id).in('statut', ['propose', 'annule']);
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
      .from('matchs').select('id, animal_id, statut').eq('id', req.params.matchId).single();
    const animal = match && await animalDuRefuge(match.animal_id, req.user.id);
    if (!match || !animal)
      return res.status(404).json({ message: 'Match introuvable.' });
    // Seulement les propositions encore ouvertes, pour un animal toujours disponible
    if (!['propose', 'accepte'].includes(match.statut))
      return res.status(409).json({ message: 'Ce match n\'est plus modifiable.' });
    if (statut === 'accepte' && animal.statut !== 'disponible')
      return res.status(409).json({ message: 'L\'animal n\'est plus disponible.' });

    const { error } = await supabase
      .from('matchs').update({ statut, updated_at: new Date().toISOString() }).eq('id', match.id);
    if (error) throw error;
    return res.json({ message: statut === 'accepte' ? 'Match validé.' : 'Match refusé.' });
  } catch (e) {
    console.error('PATCH /matching error:', e);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ═══ ACCUEIL : arrivée chez la famille, puis fin de l'accueil ═══════════════

// Date « AAAA-MM-JJ » raisonnable (un an en arrière à deux mois en avant), sinon aujourd'hui
function dateAccueil(v) {
  const auj = new Date().toISOString().slice(0, 10);
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return auj;
  const d = new Date(v + 'T12:00:00Z').getTime(), now = Date.now();
  return d >= now - 366 * 86400000 && d <= now + 61 * 86400000 ? v : auj;
}

async function matchDuRefuge(matchId, refugeId) {
  const { data: m } = await supabase.from('matchs')
    .select('id, animal_id, famille_id, statut, reponse_fa, date_debut_accueil').eq('id', matchId).maybeSingle();
  if (!m) return null;
  const animal = await animalDuRefuge(m.animal_id, refugeId);
  return animal ? { m, animal } : null;
}

// ─── PATCH /api/matching/match/:id/arrivee — { date_debut? } ─────────────────
router.patch('/match/:matchId/arrivee', requireAuth, async (req, res) => {
  try {
    const r = await matchDuRefuge(req.params.matchId, req.user.id);
    if (!r) return res.status(404).json({ message: 'Match introuvable.' });
    const { m, animal } = r;
    if (m.statut !== 'accepte' || m.reponse_fa !== 'oui')
      return res.status(409).json({ message: 'La famille doit d\'abord accepter la proposition.' });
    if (animal.statut !== 'disponible')
      return res.status(409).json({ message: 'L\'animal est déjà en accueil ou n\'est plus disponible.' });

    const maintenant = new Date().toISOString();
    const debut = dateAccueil(req.body?.date_debut);
    const { error: e1 } = await supabase.from('matchs')
      .update({ statut: 'en_cours', date_debut_accueil: debut, updated_at: maintenant }).eq('id', m.id);
    if (e1) throw e1;
    const { error: e2 } = await supabase.from('animaux')
      .update({ statut: 'en_accueil', updated_at: maintenant }).eq('id', animal.id);
    if (e2) throw e2;
    // Les autres propositions pour cet animal sont closes
    await supabase.from('matchs').update({ statut: 'annule', updated_at: maintenant })
      .eq('animal_id', animal.id).neq('id', m.id).in('statut', ['propose', 'accepte']);

    return res.json({ message: 'Arrivée confirmée.', date_debut_accueil: debut });
  } catch (e) {
    console.error('PATCH /matching/arrivee error:', e);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ─── PATCH /api/matching/match/:id/fin — { issue: 'adopte'|'retour'|'transfere', date_fin? }
router.patch('/match/:matchId/fin', requireAuth, async (req, res) => {
  try {
    const statutsAnimal = { adopte: 'adopte', retour: 'disponible', transfere: 'transfere' };
    const issue = req.body?.issue;
    if (!statutsAnimal[issue]) return res.status(400).json({ message: 'Issue de l\'accueil invalide.' });
    const r = await matchDuRefuge(req.params.matchId, req.user.id);
    if (!r) return res.status(404).json({ message: 'Match introuvable.' });
    const { m, animal } = r;
    if (m.statut !== 'en_cours') return res.status(409).json({ message: 'Aucun accueil en cours pour ce match.' });

    const maintenant = new Date().toISOString();
    let fin = dateAccueil(req.body?.date_fin);
    if (m.date_debut_accueil && fin < m.date_debut_accueil) fin = m.date_debut_accueil;
    const { error: e1 } = await supabase.from('matchs')
      .update({ statut: 'termine', date_fin_accueil: fin, updated_at: maintenant }).eq('id', m.id);
    if (e1) throw e1;
    const { error: e2 } = await supabase.from('animaux')
      .update({ statut: statutsAnimal[issue], updated_at: maintenant }).eq('id', animal.id);
    if (e2) throw e2;
    // Un accueil de plus au compteur de la famille
    const { data: fam } = await supabase.from('familles_accueil').select('nb_accueils').eq('id', m.famille_id).maybeSingle();
    if (fam) await supabase.from('familles_accueil').update({ nb_accueils: (fam.nb_accueils || 0) + 1 }).eq('id', m.famille_id);
    // Retour au refuge : l'animal peut à nouveau être proposé
    if (issue === 'retour') lancerMatching({ ...animal, statut: 'disponible' }).catch(err => console.error('Rematch après retour:', err));

    return res.json({ message: 'Accueil terminé.', date_fin_accueil: fin, statut_animal: statutsAnimal[issue] });
  } catch (e) {
    console.error('PATCH /matching/fin error:', e);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

module.exports = router;
module.exports.lancerMatching = lancerMatching;
