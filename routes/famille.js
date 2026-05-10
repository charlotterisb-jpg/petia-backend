const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Inscription d'une famille d'accueil
router.post('/register', async (req, res) => {
  try {
    const {
      prenom,
      nom,
      email,
      telephone,
      code_postal,
      ville,
      logement,
      jardin_cloture,
      enfants,
      autres_animaux,
      absence_heures,
      disponibilite,
      questionnaire,
    } = req.body;

    const { data, error } = await supabase
      .from('familles')
      .insert([
        {
          prenom,
          nom,
          email,
          telephone,
          code_postal,
          ville,
          logement,
          jardin_cloture,
          enfants,
          autres_animaux,
          absence_heures,
          disponibilite,
          questionnaire,
        },
      ])
      .select();

    if (error) throw error;

    res.json({ success: true, famille: data[0] });
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

module.exports = router;
