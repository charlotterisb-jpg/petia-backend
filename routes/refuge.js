// petia-backend/routes/refuge.js
// Configuration de la structure par le refuge
//   GET   /api/refuge/moi  → fiche, conditions d'accueil, éléments restant à compléter
//   PATCH /api/refuge/moi  → { infos?, conditions? }
// Les conditions d'accueil sont reprises dans le contrat FA (frais, vétérinaire, urgences…).

const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { requireUser } = require('../middleware/session');
const { nettoyerRefuge } = require('../services/refuge');
const { journaliser } = require('../services/journal');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const COLONNES = 'id, nom, email, telephone, type_structure, siret, adresse, code_postal, ville, site_web, ' +
  'contact_prenom, contact_nom, contact_fonction, especes, details, statut';

const CHOIX = {
  nourriture: ['refuge_fournit', 'rembourse', 'famille'],
  veterinaire: ['refuge_100', 'refuge_sur_accord', 'partage'],
  transport: ['refuge', 'famille', 'selon_cas'],
  veto_mode: ['liste_lien', 'liste_remise', 'au_choix'],
};
const MATERIEL = ['laisse', 'gamelles', 'couchage', 'caisse', 'jouets', 'litiere', 'cage'];
const txt = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);

function nettoyerConditions(c = {}) {
  const out = {};
  for (const [k, vals] of Object.entries(CHOIX)) if (vals.includes(c[k])) out[k] = c[k];
  for (const [k, n] of [['urgence', 300], ['indemnite', 300], ['regles', 2000]]) {
    const v = txt(c[k], n); if (v) out[k] = v;
  }
  // Lien vers la liste des vétérinaires partenaires (https uniquement)
  const lien = txt(c.veto_lien, 500);
  if (lien) { const u = /^https?:\/\//i.test(lien) ? lien : 'https://' + lien; if (/^https?:\/\/[^\s<>"]+\.[^\s<>"]+$/i.test(u)) out.veto_lien = u; }
  if (Array.isArray(c.materiel)) out.materiel = [...new Set(c.materiel.filter(m => MATERIEL.includes(m)))];
  return out;
}

// Ce qu'il manque pour qu'un contrat complet puisse être établi
function aCompleter(r) {
  const c = r.details?.conditions || {};
  const manque = [];
  if (!r.adresse || !r.telephone) manque.push({ cle: 'infos', txt: 'Adresse et téléphone de la structure' });
  if (!r.contact_nom && !r.contact_prenom) manque.push({ cle: 'infos', txt: 'Contact référent' });
  if (!c.nourriture || !c.veterinaire) manque.push({ cle: 'conditions', txt: 'Prise en charge de la nourriture et des frais vétérinaires' });
  if (!c.veto_mode) manque.push({ cle: 'conditions', txt: 'Vétérinaires : liste en ligne, liste remise avec l\'animal ou vétérinaire au choix' });
  else if (c.veto_mode === 'liste_lien' && !c.veto_lien) manque.push({ cle: 'conditions', txt: 'Lien vers votre liste de vétérinaires partenaires' });
  return manque;
}

async function refugeDe(req, res) {
  const { data } = await supabase.from('refuges').select(COLONNES).eq('id', req.user.id).maybeSingle();
  if (!data) { res.status(403).json({ message: 'Espace réservé aux refuges.' }); return null; }
  return data;
}

router.get('/moi', requireUser, async (req, res) => {
  try {
    const r = await refugeDe(req, res); if (!r) return;
    return res.json({ refuge: r, a_completer: aCompleter(r) });
  } catch (e) {
    console.error('GET /refuge/moi error:', e);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

router.patch('/moi', requireUser, async (req, res) => {
  try {
    const r = await refugeDe(req, res); if (!r) return;
    const maj = {};
    if (req.body?.infos) {
      const i = nettoyerRefuge(req.body.infos);
      for (const k of ['adresse', 'telephone', 'contact_prenom', 'contact_nom', 'contact_fonction', 'site_web']) if (i[k] !== undefined) maj[k] = i[k];
      if (i.details) maj.details = { ...(r.details || {}), ...i.details };
    }
    if (req.body?.conditions) maj.details = { ...(maj.details || r.details || {}), conditions: nettoyerConditions(req.body.conditions) };
    if (!Object.keys(maj).length) return res.status(400).json({ message: 'Rien à enregistrer.' });
    maj.updated_at = new Date().toISOString();
    const { data, error } = await supabase.from('refuges').update(maj).eq('id', r.id).select(COLONNES).single();
    if (error) throw error;
    journaliser(req, { evenement: 'refuge_configuration', user: req.user, role: 'refuge' });
    return res.json({ message: 'Enregistré.', refuge: data, a_completer: aCompleter(data) });
  } catch (e) {
    console.error('PATCH /refuge/moi error:', e);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

module.exports = router;
module.exports.MATERIEL = MATERIEL;
