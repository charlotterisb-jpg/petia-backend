const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Inscription d'une fourrière
router.post('/register', async (req, res) => {
  try {
    const { nom, email, telephone, adresse, code_postal, ville } = req.body;

    const { data, error } = await supabase
      .from('fourrieres')
      .insert([{ nom, email, telephone, adresse, code_postal, ville }])
      .select();

    if (error) throw error;

    res.json({ success: true, fourriere: data[0] });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Récupérer une fourrière
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('fourrieres')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error) throw error;

    res.json({ success: true, fourriere: data });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

module.exports = router;

