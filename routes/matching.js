const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { analyserCompatibilite } = require('../services/claude');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Calcul distance entre deux points GPS
function calculerDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Lancer le matching pour un animal
router.post('/:animalId', async (req, res) => {
  try {
    // 1. Récupérer l'animal
    const { data: animal, error: animalError } = await supabase
      .from('animaux')
      .select('*')
      .eq('id', req.params.animalId)
      .single();

    if (animalError) throw animalError;

    // 2. Récupérer toutes les familles actives
    const { data: familles, error: famillesError } = await supabase
      .from('familles')
      .select('*')
      .eq('actif', true);

    if (famillesError) throw famillesError;

    // 3. Filtres bloquants
    const famillesFiltrees = familles.filter((famille) => {
      const compat = animal.compatibilites || {};
      const refus = famille.questionnaire?.refus || [];

      // Filtre jardin
      if (compat.jardin_obligatoire && !famille.jardin_cloture) return false;

      // Filtre enfants
      if (compat.pas_enfants && famille.enfants?.length > 0) return false;

      // Filtre expérience
      if (compat.fa_experimentee && famille.questionnaire?.nb_accueils === 0)
        return false;

      // Filtre refus de la famille
      if (
        animal.urgence === 'tres_energique' &&
        refus.includes('tres_energique')
      )
        return false;
      if (parseInt(animal.poids) > 25 && refus.includes('grand_chien'))
        return false;

      return true;
    });

    // 4. Scoring pour chaque famille
    const scores = await Promise.all(
      famillesFiltrees.map(async (famille) => {
        let score = 0;

        // Score géographique (35%)
        if (famille.latitude && animal.latitude) {
          const distance = calculerDistance(
            famille.latitude,
            famille.longitude,
            animal.latitude,
            animal.longitude
          );
          const scoreGeo = Math.max(0, 35 - distance * 2);
          score += scoreGeo;
        }

        // Score disponibilité (30%)
        if (famille.disponibilite === 'immediat') score += 30;
        else if (famille.disponibilite === '48h') score += 25;
        else if (famille.disponibilite === 'semaine') score += 15;

        // Score expérience (10%)
        const nbAccueils = famille.questionnaire?.nb_accueils || 0;
        score += Math.min(10, nbAccueils * 3);

        // Score comportemental IA (25%) — analyse Claude
        const scoreIA = await analyserCompatibilite(animal, famille);
        score += scoreIA;

        return { famille, score: Math.round(score) };
      })
    );

    // 5. Trier par score
    const resultats = scores.sort((a, b) => b.score - a.score).slice(0, 5);

    // 6. Sauvegarder les matchs
    for (const resultat of resultats) {
      await supabase.from('matchs').insert([
        {
          animal_id: animal.id,
          famille_id: resultat.famille.id,
          fourriere_id: animal.fourriere_id,
          score: resultat.score,
          statut: 'propose',
        },
      ]);
    }

    res.json({
      success: true,
      animal: animal.nom,
      total_familles: familles.length,
      apres_filtres: famillesFiltrees.length,
      top5: resultats.map((r) => ({
        nom: `${r.famille.prenom} ${r.famille.nom}`,
        ville: r.famille.ville,
        score: r.score,
      })),
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

module.exports = router;
