const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Ajouter un animal
router.post('/', async (req, res) => {
  try {
    const {
      fourriere_id,
      nom,
      race,
      age,
      poids,
      sexe,
      urgence,
      date_limite,
      comportement,
      compatibilites,
      consignes,
    } = req.body;

    const { data, error } = await supabase
      .from('animaux')
      .insert([
        {
          fourriere_id,
          nom,
          race,
          age,
          poids,
          sexe,
          urgence,
          date_limite,
          comportement,
          compatibilites,
          consignes,
        },
      ])
      .select();

    if (error) throw error;

    res.json({ success: true, animal: data[0] });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Récupérer tous les animaux d'une fourrière
router.get('/fourriere/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('animaux')
      .select('*')
      .eq('fourriere_id', req.params.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ success: true, animaux: data });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Récupérer un animal
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('animaux')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error) throw error;

    res.json({ success: true, animal: data });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

module.exports = router;
