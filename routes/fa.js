// petia-backend/routes/fa.js
// Espace famille d'accueil
//   PUT /api/fa/questionnaire → enregistre le questionnaire (et éventuellement le profil)
//       Authentification : session de la famille (Authorization: Bearer …)
//       ou jeton d'inscription remis à l'inscription ({ jeton_inscription }).

const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { requireUser } = require('../middleware/session');
const { nettoyerProfil, nettoyerQuestionnaire, lireJetonInscription } = require('../services/profilFA');

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Session normale OU jeton d'inscription
function identifierFamille(req, res, next) {
  const userId = lireJetonInscription(req.body?.jeton_inscription);
  if (userId) { req.famId = userId; return next(); }
  return requireUser(req, res, () => { req.famId = req.user.id; next(); });
}

router.put('/questionnaire', identifierFamille, async (req, res) => {
  try {
    const { data: fa } = await supabaseAdmin
      .from('familles_accueil').select('id, statut_dossier').eq('id', req.famId).maybeSingle();
    if (!fa) return res.status(404).json({ message: 'Profil famille introuvable.' });

    const maj = { ...nettoyerProfil(req.body.profil || {}), ...nettoyerQuestionnaire(req.body) };
    if (!maj.peut_accueillir?.length)
      return res.status(400).json({ message: 'Indiquez quels animaux vous pouvez accueillir.' });
    if (!maj.motivation)
      return res.status(400).json({ message: 'La question « Pourquoi souhaitez-vous devenir FA ? » est obligatoire.' });

    maj.questionnaire_soumis_le = new Date().toISOString();
    maj.updated_at = maj.questionnaire_soumis_le;
    // Un dossier incomplet passe en attente de validation dès que le questionnaire est rempli
    if (!fa.statut_dossier || fa.statut_dossier === 'incomplet') maj.statut_dossier = 'en_attente';

    const { error } = await supabaseAdmin.from('familles_accueil').update(maj).eq('id', fa.id);
    if (error) throw error;
    return res.json({ message: 'Questionnaire enregistré.', statut_dossier: maj.statut_dossier || fa.statut_dossier });
  } catch (e) {
    console.error('PUT /fa/questionnaire error:', e);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ═══ ESPACE FAMILLE (session obligatoire) ═══════════════════════════════════

// La session doit appartenir à une famille d'accueil
async function requireFamille(req, res, next) {
  requireUser(req, res, async () => {
    const { data } = await supabaseAdmin.from('familles_accueil').select('id').eq('id', req.user.id).maybeSingle();
    if (!data) return res.status(403).json({ message: 'Espace réservé aux familles d\'accueil.' });
    req.famId = data.id;
    next();
  });
}

// Ce que la famille voit d'elle-même (jamais les notes internes ni les secrets)
const COLONNES_MOI = [
  'id', 'prenom', 'nom', 'email', 'telephone', 'ville', 'code_postal', 'type_logement', 'jardin', 'hauteur_cloture',
  'escaliers', 'etage', 'vehicule', 'enfants', 'animaux_actuels', 'heures_seul', 'presence_journee', 'balades_par_jour',
  'duree_balade', 'lieux_promenade', 'duree_accueil', 'disponible_le', 'nb_accueils', 'note_moyenne', 'previsitee',
  'statut_dossier', 'decision_motif', 'questionnaire_soumis_le', 'peut_accueillir', 'nac_acceptes', 'criteres_especes',
  'experience_chien', 'experiences_gerees', 'refus', 'engagement', 'motivation', 'attachement', 'duree_longue',
  'situation_nuits', 'situation_destruction', 'situation_absence', 'situation_reactivite', 'situation_morsure',
  'situation_consignes', 'situation_decouragement', 'situation_grogne', 'situation_limite', 'autres_infos', 'questionnaire',
].join(',');

// ─── GET /api/fa/moi ─────────────────────────────────────────────────────────
router.get('/moi', requireFamille, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('familles_accueil').select(COLONNES_MOI).eq('id', req.famId).single();
    if (error) throw error;
    return res.json({ famille: data });
  } catch (e) {
    console.error('GET /fa/moi error:', e);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ─── PATCH /api/fa/disponibilite — { disponible_le } ─────────────────────────
router.patch('/disponibilite', requireFamille, async (req, res) => {
  const v = req.body?.disponible_le;
  if (!['maintenant', 'cette_semaine', 'ce_mois', 'non_dispo'].includes(v))
    return res.status(400).json({ message: 'Disponibilité invalide.' });
  const { error } = await supabaseAdmin.from('familles_accueil')
    .update({ disponible_le: v, updated_at: new Date().toISOString() }).eq('id', req.famId);
  if (error) { console.error('PATCH /fa/disponibilite error:', error); return res.status(500).json({ message: 'Erreur serveur.' }); }
  return res.json({ message: 'Disponibilité mise à jour.', disponible_le: v });
});

// Ce que la famille voit d'un animal proposé (pas la puce ni les notes internes)
const COLONNES_ANIMAL_FA =
  'id, nom, espece, sous_espece, race, age_annees, age_mois, sexe, poids_kg, sterilise, urgence, statut, ' +
  'compatible_enfants, compatible_chiens, compatible_chats, temps_seul_max, balades_min_jour, niveau_exercice, ' +
  'description, comportement, historique, besoins_specifiques, details, photo_url, ' +
  'refuge:refuges(nom, ville, code_postal, telephone, email, statut)';

// ─── GET /api/fa/propositions ────────────────────────────────────────────────
// Uniquement les propositions validées par le refuge (et la suite de l'accueil)
router.get('/propositions', requireFamille, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('matchs')
      .select(`id, score, recommandation, statut, reponse_fa, date_reponse_fa, date_debut_accueil, date_fin_accueil, created_at, updated_at, details_score,
               animal:animaux(${COLONNES_ANIMAL_FA})`)
      .eq('famille_id', req.famId)
      .in('statut', ['accepte', 'en_cours', 'termine'])
      .order('updated_at', { ascending: false });
    if (error) throw error;
    // Les animaux d'un refuge suspendu ou refusé n'apparaissent plus
    const propositions = (data || []).filter(m => m.animal?.refuge?.statut === 'actif').map(m => {
      if (m.animal?.refuge) delete m.animal.refuge.statut;
      if (m.animal?.details?.commun) {
        const { puce, ...commun } = m.animal.details.commun;
        m.animal.details = { ...m.animal.details, commun };
      }
      // Coordonnées du refuge seulement une fois la proposition acceptée
      if (m.animal?.refuge && m.reponse_fa !== 'oui') { delete m.animal.refuge.telephone; delete m.animal.refuge.email; }
      return { ...m, resume_ia: m.details_score?.resume_ia || null, details_score: undefined };
    });
    return res.json({ propositions });
  } catch (e) {
    console.error('GET /fa/propositions error:', e);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ─── PATCH /api/fa/propositions/:id — { reponse: 'oui' | 'non' } ─────────────
router.patch('/propositions/:id', requireFamille, async (req, res) => {
  try {
    const reponse = req.body?.reponse;
    if (!['oui', 'non'].includes(reponse)) return res.status(400).json({ message: 'Réponse invalide.' });
    const { data: m } = await supabaseAdmin.from('matchs')
      .select('id, famille_id, statut, reponse_fa').eq('id', req.params.id).maybeSingle();
    if (!m || m.famille_id !== req.famId || m.statut !== 'accepte')
      return res.status(404).json({ message: 'Proposition introuvable ou plus ouverte.' });
    const maintenant = new Date().toISOString();
    const { error } = await supabaseAdmin.from('matchs')
      .update({ reponse_fa: reponse, date_reponse_fa: maintenant, updated_at: maintenant }).eq('id', m.id);
    if (error) throw error;
    return res.json({ message: reponse === 'oui' ? 'Proposition acceptée.' : 'Proposition déclinée.', reponse_fa: reponse });
  } catch (e) {
    console.error('PATCH /fa/propositions error:', e);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

module.exports = router;
