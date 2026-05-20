const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Inscription d'une famille d'accueil avec Supabase Auth
router.post('/register', async (req, res) => {
  try {
    const {
      prenom, nom, email, telephone,
      code_postal, ville, logement,
      jardin_cloture, enfants, autres_animaux,
      absence_heures, disponibilite, password
    } = req.body;

    // 1. Créer le compte Auth Supabase
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: 'https://petia-frontend.vercel.app',
        data: {
          type: 'famille',
          prenom,
          nom,
          telephone
        }
      }
    });

    if (authError) throw authError;

    // 2. Créer le profil famille dans la table
    const { data, error } = await supabase
      .from('familles')
      .insert([{
        id: authData.user.id,
        prenom, nom, email, telephone,
        code_postal, ville, logement,
        jardin_cloture, enfants, autres_animaux,
        absence_heures, disponibilite
      }])
      .select();

    if (error) throw error;

    res.json({
      success: true,
      message: 'Compte créé ! Vérifiez votre email pour confirmer votre inscription.',
      famille: data[0]
    });

  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Connexion famille
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    });

    if (error) throw error;

    // Récupérer le profil famille
    const { data: famille, error: fError } = await supabase
      .from('familles')
      .select('*')
      .eq('id', data.user.id)
      .single();

    if (fError) throw fError;

    res.json({
      success: true,
      session: data.session,
      famille
    });

  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Récupérer une famille
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('familles')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error) throw error;

    res.json({ success: true, famille: data });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Récupérer toutes les familles disponibles
router.get('/disponibles', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('familles')
      .select('*')
      .eq('actif', true)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ success: true, familles: data });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

module.exports = router;
