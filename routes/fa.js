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

module.exports = router;
