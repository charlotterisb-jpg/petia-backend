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
  veto_mode: ['liste_texte', 'liste_lien', 'liste_remise', 'au_choix'],
};
const MATERIEL = ['laisse', 'gamelles', 'couchage', 'caisse', 'jouets', 'litiere', 'cage'];
const txt = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);

function nettoyerConditions(c = {}) {
  const out = {};
  for (const [k, vals] of Object.entries(CHOIX)) if (vals.includes(c[k])) out[k] = c[k];
  for (const [k, n] of [['urgence', 300], ['indemnite', 300], ['regles', 2000], ['veto_liste', 6000], ['rgpd_destinataires', 1000], ['rgpd_transfert', 1000], ['rgpd_conservation', 500], ['rgpd_dpo', 300]]) {
    const v = txt(c[k], n); if (v) out[k] = v;
  }
  for (const k of ['rgpd_email', 'resiliation_email']) {
    const m = txt(c[k], 200); if (m && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m)) out[k] = m;
  }
  const pj = parseInt(c.preavis_jours, 10); if (Number.isInteger(pj) && pj >= 0 && pj <= 90) out.preavis_jours = pj;
  const trib = txt(c.tribunal, 100); if (trib) out.tribunal = trib;
  // Lien vers la liste des vétérinaires partenaires (https uniquement)
  const lien = txt(c.veto_lien, 500);
  if (lien) { const u = /^https?:\/\//i.test(lien) ? lien : 'https://' + lien; if (/^https?:\/\/[^\s<>"]+\.[^\s<>"]+$/i.test(u)) out.veto_lien = u; }
  if (Array.isArray(c.materiel)) out.materiel = [...new Set(c.materiel.filter(m => MATERIEL.includes(m)))];
  return out;
}

// Contrat : modèle PetIA personnalisé, ou contrat propre à l'association
//   { mode: 'modele' | 'propre', modifs: { id: { t, b } }, clauses, titre, texte }
function nettoyerContrat(x = {}, existant = {}) {
  const { paragraphesModifiables, court, espaces } = require('../services/contrat');
  const out = { mode: x.mode === 'propre' ? 'propre' : 'modele' };
  const origines = paragraphesModifiables();
  const modifs = {};
  const src = x.modifs && typeof x.modifs === 'object' ? x.modifs : (existant.modifs || {});
  for (const [id, v] of Object.entries(src)) {
    if (!origines[id]) continue;
    const t = espaces(typeof v === 'string' ? v : v?.t).slice(0, 4000);
    if (t === espaces(origines[id])) continue; // identique au modèle : rien à garder
    // b : empreinte du texte du modèle au moment de la modification (signale une évolution du modèle)
    const ancien = existant.modifs?.[id];
    modifs[id] = { t, b: ancien && ancien.t === t ? ancien.b : court(origines[id]) };
  }
  if (Object.keys(modifs).length) out.modifs = modifs;
  const clauses = txt(x.clauses !== undefined ? x.clauses : existant.clauses, 6000); if (clauses) out.clauses = clauses;
  const titre = txt(x.titre !== undefined ? x.titre : existant.titre, 150); if (titre) out.titre = titre;
  const texte = txt(x.texte !== undefined ? x.texte : existant.texte, 60000); if (texte) out.texte = texte;
  return out;
}

// Ce qu'il manque pour qu'un contrat complet puisse être établi
function aCompleter(r) {
  const c = r.details?.conditions || {};
  const manque = [];
  if (!r.adresse || !r.telephone) manque.push({ cle: 'infos', txt: 'Adresse et téléphone de la structure' });
  if (!r.contact_nom && !r.contact_prenom) manque.push({ cle: 'infos', txt: 'Contact référent' });
  if (r.details?.contrat?.mode === 'propre') {
    if (!r.details.contrat.texte) manque.push({ cle: 'contrat', txt: 'Le texte de votre contrat' });
    return manque;
  }
  if (!c.nourriture || !c.veterinaire) manque.push({ cle: 'conditions', txt: 'Prise en charge de la nourriture et des frais vétérinaires' });
  if (!c.veto_mode) manque.push({ cle: 'conditions', txt: 'Vétérinaires : liste en ligne, liste remise avec l\'animal ou vétérinaire au choix' });
  else if (c.veto_mode === 'liste_lien' && !c.veto_lien) manque.push({ cle: 'conditions', txt: 'Lien vers votre liste de vétérinaires partenaires' });
  else if (c.veto_mode === 'liste_texte' && !c.veto_liste) manque.push({ cle: 'conditions', txt: 'Votre liste de vétérinaires partenaires' });
  if (!c.rgpd_email) manque.push({ cle: 'donnees', txt: 'Adresse e-mail pour l\'exercice des droits sur les données personnelles' });
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
    return res.json({ refuge: r, a_completer: aCompleter(r), types_documents: require('../services/documents').TYPES_DOC });
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
    if (req.body?.contrat && typeof req.body.contrat === 'object')
      maj.details = { ...(maj.details || r.details || {}), contrat: nettoyerContrat(req.body.contrat, r.details?.contrat || {}) };
    if (Array.isArray(req.body?.documents_defaut)) {
      const { TYPES_DOC } = require('../services/documents');
      const liste = req.body.documents_defaut.filter(d => TYPES_DOC[d?.type]).slice(0, 10).map(d => ({
        type: d.type, libelle: (typeof d.libelle === 'string' && d.libelle.trim() ? d.libelle.trim() : TYPES_DOC[d.type]).slice(0, 150), obligatoire: d.obligatoire !== false }));
      maj.details = { ...(maj.details || r.details || {}), documents_defaut: liste };
    }
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

// ─── GET /api/refuge/modele-contrat — aperçu avec une famille et un animal fictifs
router.get('/modele-contrat', requireUser, async (req, res) => {
  try {
    const r = await refugeDe(req, res); if (!r) return;
    const { rediger, paragraphesModifiables } = require('../services/contrat');
    const edition = req.query.edition === '1';
    const contenu = rediger({
      refuge: r,
      famille: { prenom: 'Prénom', nom: 'NOM de la famille', code_postal: '00000', ville: 'Ville' },
      animal: { nom: '[nom de l\'animal]', espece: 'chien', race: '[race]', sexe: '[sexe]', age_annees: null, description: '[consignes saisies sur la fiche de l\'animal]', details: { commun: {} } },
      match: { modalites: { mode: 'a_convenir' } },
    }, { edition, forcerModele: edition });
    contenu.avertissement = 'Aperçu : les éléments entre crochets sont remplis automatiquement pour chaque accueil (famille, animal, modalités de remise). En gras : ce qui est complété ou modifié par rapport au modèle PetIA.';
    return res.json({ contenu, ...(edition ? { origines: paragraphesModifiables() } : {}) });
  } catch (e) {
    console.error('GET /refuge/modele-contrat error:', e);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

module.exports = router;
module.exports.MATERIEL = MATERIEL;
module.exports.nettoyerContrat = nettoyerContrat;
module.exports.aCompleter = aCompleter;
