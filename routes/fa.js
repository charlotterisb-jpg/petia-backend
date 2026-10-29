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
const { journaliser } = require('../services/journal');

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
    journaliser(req, { evenement: 'questionnaire_envoye', userId: fa.id, role: 'fa' });
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

// ─── PATCH /api/fa/profil — { profil } : logement et quotidien ───────────────
// La famille met à jour son foyer ; si son dossier est validé, les animaux
// disponibles sont recalculés pour elle.
router.patch('/profil', requireFamille, async (req, res) => {
  try {
    const maj = nettoyerProfil(req.body?.profil || {});
    if (!Object.keys(maj).length) return res.status(400).json({ message: 'Aucune information à enregistrer.' });
    maj.updated_at = new Date().toISOString();
    const { data: f, error } = await supabaseAdmin.from('familles_accueil').update(maj).eq('id', req.famId).select('statut_dossier').single();
    if (error) throw error;
    journaliser(req, { evenement: 'profil_modifie', user: req.user, role: 'fa' });
    if (f?.statut_dossier === 'valide') {
      const { lancerMatching } = require('./matching');
      const { data: animaux } = await supabaseAdmin.from('animaux').select('*').eq('statut', 'disponible').order('created_at', { ascending: false }).limit(20);
      (async () => { for (const a of animaux || []) await lancerMatching(a).catch(e => console.error('Rematch profil FA:', e.message)); })();
    }
    return res.json({ message: 'Votre foyer est mis à jour.' });
  } catch (e) {
    console.error('PATCH /fa/profil error:', e);
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
  'id, nom, espece, sous_espece, race, age_annees, age_mois, sexe, poids_kg, taille, sterilise, urgence, statut, ' +
  'compatible_enfants, age_enfants_min, compatible_chiens, compatible_chats, temps_seul_max, presence_constante, balades_min_jour, niveau_exercice, ' +
  'escaliers, cloture_min, sortie_sans_laisse, vehicule_requis, experience_fa_requise, ' +
  'description, comportement, historique, besoins_specifiques, details, photo_url, ' +
  'refuge:refuges(nom, type_structure, adresse, ville, code_postal, telephone, email, site_web, contact_prenom, contact_nom, contact_fonction, statut, cloture_le, bloque_le, details)';
// Coordonnées et contact du refuge : seulement une fois la proposition acceptée par la famille
const CONTACT_REFUGE = ['telephone', 'email', 'contact_prenom', 'contact_nom', 'contact_fonction'];

// ─── GET /api/fa/propositions ────────────────────────────────────────────────
// Uniquement les propositions validées par le refuge (et la suite de l'accueil)
router.get('/propositions', requireFamille, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('matchs')
      .select(`id, score, recommandation, statut, reponse_fa, date_reponse_fa, date_debut_accueil, date_fin_accueil, created_at, updated_at, details_score, modalites,
               animal:animaux(${COLONNES_ANIMAL_FA})`)
      .eq('famille_id', req.famId)
      .in('statut', ['accepte', 'en_cours', 'termine'])
      .order('updated_at', { ascending: false });
    if (error) throw error;
    const ids = (data || []).map(m => m.id);
    const { data: cs } = ids.length ? await supabaseAdmin.from('contrats').select('match_id, statut, fa_signe_le, refuge_signe_le').in('match_id', ids) : { data: [] };
    const contrats = Object.fromEntries((cs || []).map(c => [c.match_id, c]));
    const { data: dd } = ids.length ? await supabaseAdmin.from('demandes_documents')
      .select('id, match_id, type, libelle, obligatoire, statut, motif_refus, document:documents_fa(id, libelle)').in('match_id', ids).order('cree_le') : { data: [] };
    const demandes = {};
    for (const d of dd || []) (demandes[d.match_id] = demandes[d.match_id] || []).push(d);
    // Les animaux d'un refuge suspendu ou refusé n'apparaissent plus
    const propositions = (data || []).filter(m => m.animal?.refuge?.statut === 'actif' && !m.animal.refuge.cloture_le && !m.animal.refuge.bloque_le).map(m => {
      if (m.animal?.refuge) {
        const c = m.animal.refuge.details?.conditions || {};
        // Seules les informations utiles à la famille : vétérinaires et urgences
        m.animal.refuge.veterinaires = { mode: c.veto_mode || null, liste: c.veto_liste || null, lien: c.veto_lien || null, urgence: c.urgence || null };
        for (const k of ['statut', 'cloture_le', 'bloque_le', 'details']) delete m.animal.refuge[k];
      }
      if (m.animal?.details?.commun) {
        const { puce, ...commun } = m.animal.details.commun;
        m.animal.details = { ...m.animal.details, commun };
      }
      // Coordonnées du refuge seulement une fois la proposition acceptée
      if (m.animal?.refuge && m.reponse_fa !== 'oui') CONTACT_REFUGE.forEach(k => delete m.animal.refuge[k]);
      return { ...m, resume_ia: m.details_score?.resume_ia || null, details_score: undefined, contrat: contrats[m.id] || null, documents: demandes[m.id] || [] };
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
    journaliser(req, { evenement: 'proposition_' + reponse, user: req.user, role: 'fa', cible_type: 'match', cible_id: m.id });
    // Acceptation : le contrat est préparé tout de suite, la famille le signe dans la foulée
    if (reponse === 'oui') {
      await obtenirContrat(m.id).catch(e => console.error('Création contrat:', e.message));
      await require('../services/documents').creerDemandesParDefaut(m.id).catch(e => console.error('Demandes documents:', e.message));
      notifierRefuge(m.id, 'acceptation').catch(() => {});
    }
    return res.json({ message: reponse === 'oui' ? 'Proposition acceptée.' : 'Proposition déclinée.', reponse_fa: reponse });
  } catch (e) {
    console.error('PATCH /fa/propositions error:', e);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ═══ CONTRAT D'ACCUEIL (famille) ═════════════════════════════════════════════
const { obtenirContrat, pourAffichage, integre, pdf, CONFIRMATIONS_FA, authentifierSignataire, normaliserNom } = require('../services/contrat');

async function matchDeLaFamille(matchId, famId) {
  const { data: m } = await supabaseAdmin.from('matchs').select('id, famille_id, statut, reponse_fa').eq('id', matchId).maybeSingle();
  return m && m.famille_id === famId ? m : null;
}

// E-mail au refuge (sans bloquer si Brevo est indisponible)
async function notifierRefuge(matchId, quoi) {
  const { envoyerMail, SITE, esc } = require('../services/journal');
  const { data: m } = await supabaseAdmin.from('matchs')
    .select('famille:familles_accueil(prenom), animal:animaux(nom, refuge:refuges(email, nom))').eq('id', matchId).maybeSingle();
  const r = m?.animal?.refuge; if (!r?.email) return;
  const txt = {
    acceptation: [`${esc(m.famille?.prenom || 'La famille')} accepte d'accueillir ${esc(m.animal.nom)}`, 'La famille a accepté votre proposition. Elle va signer le contrat d\'accueil ; vous serez prévenu pour le contresigner.'],
    signature: [`Contrat à contresigner pour ${esc(m.animal.nom)}`, `${esc(m.famille?.prenom || 'La famille')} a signé le contrat d'accueil. Contresignez-le depuis les Matchs de l'animal pour pouvoir confirmer son arrivée.`],
  }[quoi];
  await envoyerMail({ to: r.email, subject: '🐾 ' + txt[0].replace(/<[^>]+>/g, ''), badge: '📝', couleur: '#4F72F5', label: 'Accueil', title: txt[0], body: txt[1], ctaText: 'Ouvrir mon espace →', ctaHref: SITE });
}

router.get('/contrats/:matchId', requireFamille, async (req, res) => {
  try {
    const m = await matchDeLaFamille(req.params.matchId, req.famId);
    if (!m) return res.status(404).json({ message: 'Proposition introuvable.' });
    const c = await obtenirContrat(m.id);
    if (!c) return res.status(409).json({ message: 'Le contrat est disponible une fois la proposition acceptée.' });
    journaliser(req, { evenement: 'contrat_consulte', user: req.user, role: 'fa', cible_type: 'contrat', cible_id: c.id });
    return res.json({ contrat: pourAffichage(c) });
  } catch (e) {
    console.error('GET /fa/contrats error:', e);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// { nom, mot_de_passe, code?, confirmations: [true, true, true, true] }
router.post('/contrats/:matchId/signer', requireFamille, async (req, res) => {
  try {
    const m = await matchDeLaFamille(req.params.matchId, req.famId);
    if (!m) return res.status(404).json({ message: 'Proposition introuvable.' });
    const c = await obtenirContrat(m.id);
    if (!c) return res.status(409).json({ message: 'Contrat indisponible.' });
    if (c.statut !== 'a_signer_fa') return res.status(409).json({ message: 'Vous avez déjà signé ce contrat.' });
    if (!integre(c)) return res.status(409).json({ message: 'Le contrat a été altéré : contactez PetIA.' });
    const manquants = await require('../services/documents').obligatoiresManquants(m.id);
    if (manquants.length) return res.status(409).json({ message: 'Documents obligatoires à fournir et à faire valider par le refuge avant de signer : ' + manquants.join(', ') + '.' });
    const conf = req.body?.confirmations;
    if (!Array.isArray(conf) || conf.length !== CONFIRMATIONS_FA.length || !conf.every(x => x === true))
      return res.status(400).json({ message: 'Cochez toutes les déclarations.' });
    const { data: f } = await supabaseAdmin.from('familles_accueil').select('prenom, nom').eq('id', req.famId).single();
    const saisi = normaliserNom(req.body?.nom);
    if (!saisi || ![normaliserNom(f.prenom + f.nom), normaliserNom(f.nom + f.prenom)].includes(saisi))
      return res.status(400).json({ message: `Saisissez vos prénom et nom tels qu'ils figurent au contrat : ${f.prenom} ${f.nom}.` });
    const erreur = await authentifierSignataire(req.user, req.body?.mot_de_passe, req.body?.code);
    if (erreur) {
      journaliser(req, { evenement: 'contrat_signature_echec', user: req.user, role: 'fa', cible_type: 'contrat', cible_id: c.id });
      return res.status(401).json({ message: erreur });
    }
    const { error } = await supabaseAdmin.from('contrats').update({
      statut: 'a_signer_refuge', fa_signe_le: new Date().toISOString(), fa_nom_signe: String(req.body.nom).trim().slice(0, 120),
      fa_ip: req.ipClient || req.ip, fa_appareil: String(req.headers['user-agent'] || '').slice(0, 300),
    }).eq('id', c.id).eq('statut', 'a_signer_fa');
    if (error) throw error;
    journaliser(req, { evenement: 'contrat_signe_fa', user: req.user, role: 'fa', cible_type: 'contrat', cible_id: c.id });
    notifierRefuge(m.id, 'signature').catch(() => {});
    return res.json({ message: 'Contrat signé. Le refuge est prévenu et va le contresigner.' });
  } catch (e) {
    console.error('POST /fa/contrats/signer error:', e);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

router.get('/contrats/:matchId/pdf', requireFamille, async (req, res) => {
  try {
    const m = await matchDeLaFamille(req.params.matchId, req.famId);
    const c = m && await obtenirContrat(m.id, { creer: false });
    if (!c) return res.status(404).json({ message: 'Contrat introuvable.' });
    journaliser(req, { evenement: 'contrat_telecharge', user: req.user, role: 'fa', cible_type: 'contrat', cible_id: c.id });
    return pdf(c, res);
  } catch (e) {
    console.error('GET /fa/contrats/pdf error:', e);
    if (!res.headersSent) res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ═══ COFFRE-FORT DE DOCUMENTS (famille) ══════════════════════════════════════
const docs = require('../services/documents');

router.get('/documents', requireFamille, async (req, res) => {
  const { data, error } = await supabaseAdmin.from('documents_fa').select('id, type, libelle, mime, taille, depose_le').eq('famille_id', req.famId).order('depose_le', { ascending: false });
  if (error) { console.error('GET /fa/documents error:', error); return res.status(500).json({ message: 'Erreur serveur.' }); }
  return res.json({ documents: data || [], types: docs.TYPES_DOC });
});

// { type, libelle?, base64, demande_id? } — dépôt, et rattachement direct à une demande si précisé
router.post('/documents', requireFamille, async (req, res) => {
  try {
    const { count } = await supabaseAdmin.from('documents_fa').select('id', { count: 'exact', head: true }).eq('famille_id', req.famId);
    if (count >= 30) return res.status(400).json({ message: 'Coffre-fort plein (30 documents) : supprimez d\'anciens documents.' });
    const doc = await docs.deposer(req.famId, req.body || {});
    journaliser(req, { evenement: 'document_depose', user: req.user, role: 'fa', cible_type: 'document', cible_id: doc.id, details: { type: doc.type } });
    if (req.body?.demande_id) await rattacher(req, req.body.demande_id, doc.id).catch(() => {});
    return res.status(201).json({ document: doc });
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ message: e.message });
    console.error('POST /fa/documents error:', e);
    return res.status(500).json({ message: 'Erreur lors du dépôt.' });
  }
});

router.delete('/documents/:id', requireFamille, async (req, res) => {
  try {
    const { data } = await supabaseAdmin.from('documents_fa').select('id, chemin').eq('id', req.params.id).eq('famille_id', req.famId);
    if (!data?.length) return res.status(404).json({ message: 'Document introuvable.' });
    await docs.supprimerDocuments(data);
    journaliser(req, { evenement: 'document_supprime', user: req.user, role: 'fa', cible_type: 'document', cible_id: req.params.id });
    return res.json({ message: 'Document supprimé.' });
  } catch (e) {
    console.error('DELETE /fa/documents error:', e);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

router.get('/documents/:id/lien', requireFamille, async (req, res) => {
  try {
    const { data } = await supabaseAdmin.from('documents_fa').select('chemin').eq('id', req.params.id).eq('famille_id', req.famId).maybeSingle();
    if (!data) return res.status(404).json({ message: 'Document introuvable.' });
    return res.json({ url: await docs.lienSigne(data.chemin) });
  } catch (e) {
    console.error('GET /fa/documents/lien error:', e);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// Joindre un document du coffre-fort à une demande du refuge (= le partager avec ce refuge)
async function rattacher(req, demandeId, documentId) {
  const { data: d } = await supabaseAdmin.from('demandes_documents').select('id, statut, match:matchs(famille_id)').eq('id', demandeId).maybeSingle();
  if (!d || d.match?.famille_id !== req.famId) throw Object.assign(new Error('Demande introuvable.'), { status: 404 });
  if (d.statut === 'valide') throw Object.assign(new Error('Ce document a déjà été validé par le refuge.'), { status: 409 });
  const { data: doc } = await supabaseAdmin.from('documents_fa').select('id').eq('id', documentId).eq('famille_id', req.famId).maybeSingle();
  if (!doc) throw Object.assign(new Error('Document introuvable.'), { status: 404 });
  const { error } = await supabaseAdmin.from('demandes_documents')
    .update({ document_id: doc.id, statut: 'fourni', motif_refus: null, maj_le: new Date().toISOString() }).eq('id', d.id);
  if (error) throw error;
  journaliser(req, { evenement: 'document_partage', user: req.user, role: 'fa', cible_type: 'demande_document', cible_id: d.id });
}

router.patch('/demandes/:id', requireFamille, async (req, res) => {
  try {
    await rattacher(req, req.params.id, req.body?.document_id);
    return res.json({ message: 'Document transmis au refuge.' });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ message: e.message });
    console.error('PATCH /fa/demandes error:', e);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

module.exports = router;
