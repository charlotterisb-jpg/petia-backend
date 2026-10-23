// petia-backend/routes/animal.js
// Gestion des animaux — CRUD complet avec auth
// Variables d'env requises : SUPABASE_URL, SUPABASE_SERVICE_KEY

const express = require('express');
const router  = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Session : contrôle commun (exige le code si la double authentification est activée)
const requireAuth = require('../middleware/session').requireUser;
const { ESPECES, SOUS_ESPECES, nettoyerDetailsAnimal } = require('../services/especes');

// ─── POST /api/animal — Ajouter un animal ─────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  try {
    // Vérifier que l'utilisateur est bien un refuge/fourrière
    const { data: refuge, error: refugeErr } = await supabaseAdmin
      .from('refuges')
      .select('id, statut')
      .eq('id', req.user.id)
      .single();

    if (refugeErr || !refuge)
      return res.status(403).json({ message: 'Accès réservé aux refuges et fourrières.' });

    // Seul un refuge validé par l'équipe PetIA peut publier des animaux
    if (refuge.statut !== 'actif')
      return res.status(403).json({ message: refuge.statut === 'en_attente'
        ? 'Votre structure est en cours de validation par l\'équipe PetIA. Vous pourrez publier des animaux dès qu\'elle sera validée.'
        : 'Votre compte ne permet pas de publier des animaux.' });

    const {
      nom, espece, race, sous_espece, details,
      age_categorie, age_annees, age_mois, sexe, poids_kg, sterilise, vaccins,
      urgence, date_limite, duree_accueil,
      etat_sante, medicaments, historique, consignes,
      energie, proprete, destruction, anxiete,
      reactivite_congeneres, reactivite_humains, morsure,
      compat_enfants_3, compat_enfants_312, compat_chiens, compat_chats,
      compat_appartement, jardin_obligatoire, tolere_solitude, fa_debutante,
      experience_fa_requise,
      temps_seul_max, presence_constante, balades_min_jour, niveau_exercice,
      escaliers, cloture_min, sortie_sans_laisse, vehicule_requis,
      points_vigilance
    } = req.body;

    // Champs obligatoires
    if (!nom || !espece || !urgence)
      return res.status(400).json({ message: 'Nom, espèce et urgence sont obligatoires.' });

    // Espèce : uniquement les espèces ouvertes à la saisie
    const esp = String(espece).toLowerCase();
    if (!ESPECES.includes(esp))
      return res.status(400).json({ message: 'Espèce non prise en charge pour le moment.' });
    const sousEsp = SOUS_ESPECES[esp] ? (SOUS_ESPECES[esp].includes(sous_espece) ? sous_espece : null) : null;
    if (SOUS_ESPECES[esp] && !sousEsp)
      return res.status(400).json({ message: 'Précisez la sous-espèce.' });
    const estChien = esp === 'chien';
    const estChienOuChat = esp === 'chien' || esp === 'chat';

    // Âge : années / mois saisis directement (ancien format par catégorie accepté)
    const entier = (v, max) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 && n <= max ? n : null; };

    // Mapper l'âge catégorie → valeur numérique approximative
    const ageMap = {
      'Chiot (0–6 mois)':   { annees: 0, mois: 3 },
      'Jeune (6 mois–2 ans)': { annees: 1, mois: 0 },
      'Adulte (2–7 ans)':   { annees: 4, mois: 0 },
      'Senior (7–10 ans)':  { annees: 8, mois: 0 },
      'Très âgé (10+)':     { annees: 11, mois: 0 }
    };
    const age = (age_annees != null || age_mois != null)
      ? { annees: entier(age_annees, 40) ?? 0, mois: entier(age_mois, 11) ?? 0 }
      : (ageMap[age_categorie] || { annees: null, mois: null });

    // Mapper expérience FA (libellé formulaire → valeur Supabase)
    const experienceMap = (v) => {
      if (!v) return null;
      if (v.includes('Débutant'))     return 'debutant';
      if (v.includes('préférable'))   return 'intermediaire';
      if (v.includes('expérimentée')) return 'confirme';
      return null;
    };

    // Mapper urgence (lettre → libellé Supabase)
    const urgenceMap = { 'n': 'normale', 'e': 'haute', 'c': 'critique' };

    // Mapper compatibilités (oui/non/inc → true/false/null)
    const compat = (v) => v === 'oui' ? true : v === 'non' ? false : null;

    // Assembler le comportement en texte lisible
    const comportementParts = [
      energie, proprete, destruction, anxiete,
      reactivite_congeneres, reactivite_humains
    ].filter(Boolean);

    const { data, error } = await supabaseAdmin
      .from('animaux')
      .insert({
        refuge_id:            refuge.id,
        nom,
        espece:               esp,
        sous_espece:          sousEsp,
        details:              nettoyerDetailsAnimal(esp, details || {}),
        race:                 race || null,
        age_annees:           age.annees,
        age_mois:             age.mois,
        sexe:                 sexe === 'Mâle' ? 'male' : sexe === 'Femelle' ? 'femelle' : 'inconnu',
        poids_kg:             poids_kg ? parseFloat(poids_kg) : null,
        sterilise:            sterilise === 'Oui' ? true : sterilise === 'Non' ? false : null,
        vaccins:              vaccins === 'À jour' ? true : vaccins === 'Non' ? false : null,
        urgence:              urgenceMap[urgence] || 'normale',
        statut:               'disponible',
        // Un seul « non » suffit : l'animal n'est pas compatible avec des enfants
        compatible_enfants:   [compat(compat_enfants_3), compat(compat_enfants_312)].includes(false) ? false
                            : [compat(compat_enfants_3), compat(compat_enfants_312)].includes(true) ? true : null,
        compatible_chiens:    compat(compat_chiens),
        compatible_chats:     compat(compat_chats),
        // Questions réservées au chien (ou au chien et au chat)
        temps_seul_max:       estChienOuChat ? temps_seul_max || null : null,
        presence_constante:   estChienOuChat ? presence_constante || null : null,
        balades_min_jour:     estChien ? balades_min_jour || null : null,
        niveau_exercice:      estChien ? niveau_exercice || null : null,
        escaliers:            estChien ? escaliers || null : null,
        cloture_min:          estChien ? cloture_min || null : null,
        sortie_sans_laisse:   estChien ? sortie_sans_laisse || null : null,
        vehicule_requis:      vehicule_requis || null,
        experience_fa_requise: experienceMap(experience_fa_requise),
        description:          consignes || null,
        comportement:         comportementParts.join(' | ') || null,
        historique:           historique || null,
        besoins_specifiques:  [medicaments, points_vigilance].filter(Boolean).join('\n') || null,
      })
      .select()
      .single();

    if (error) throw error;

    // Matching lancé en arrière-plan : la réponse n'attend pas l'IA
    require('./matching').lancerMatching(data)
      .catch(e => console.error('Matching auto error:', e));

    return res.status(201).json({
      message: 'Animal enregistré avec succès.',
      animal: data
    });

  } catch (e) {
    console.error('POST /animal error:', e);
    return res.status(500).json({ message: 'Erreur serveur.', detail: e.message });
  }
});

// ─── GET /api/animal — Liste des animaux du refuge connecté ──────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('animaux')
      .select('*, matchs(score, statut)')
      .eq('refuge_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json({ animaux: data });
  } catch (e) {
    console.error('GET /animal error:', e);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ─── GET /api/animal/:id — Détail d'un animal ────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('animaux')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error || !data)
      return res.status(404).json({ message: 'Animal introuvable.' });

    return res.json({ animal: data });
  } catch (e) {
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ─── PATCH /api/animal/:id — Modifier un animal ──────────────────────────────
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { data: existing } = await supabaseAdmin
      .from('animaux')
      .select('refuge_id')
      .eq('id', req.params.id)
      .single();

    if (!existing || existing.refuge_id !== req.user.id)
      return res.status(403).json({ message: 'Non autorisé.' });

    const { data, error } = await supabaseAdmin
      .from('animaux')
      .update({ ...req.body, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    return res.json({ message: 'Animal mis à jour.', animal: data });
  } catch (e) {
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ─── DELETE /api/animal/:id — Supprimer un animal ────────────────────────────
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { data: existing } = await supabaseAdmin
      .from('animaux')
      .select('refuge_id')
      .eq('id', req.params.id)
      .single();

    if (!existing || existing.refuge_id !== req.user.id)
      return res.status(403).json({ message: 'Non autorisé.' });

    const { error } = await supabaseAdmin
      .from('animaux')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;
    return res.json({ message: 'Animal supprimé.' });
  } catch (e) {
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

module.exports = router;
