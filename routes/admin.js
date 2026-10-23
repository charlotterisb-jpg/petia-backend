// petia-backend/routes/admin.js
// Espace admin PetIA — validation des dossiers familles d'accueil
//   GET   /api/admin/moi                → le compte connecté est-il admin ? (sans MFA)
//   GET   /api/admin/familles?statut=…  → liste + compteurs par statut
//   GET   /api/admin/familles/:id       → dossier complet
//   PATCH /api/admin/familles/:id       → { statut, motif?, notes_internes?, notifier? }
// Variables d'env : SUPABASE_URL, SUPABASE_SERVICE_KEY
// Toutes les routes sauf /moi exigent la double authentification (aal2).

const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { requireAdmin, requireAdminSansMFA } = require('../middleware/admin');

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const STATUTS = ['en_attente', 'incomplet', 'valide', 'refuse', 'suspendu'];

// Jamais renvoyés au navigateur
const CHAMPS_SECRETS = ['password_hash', 'token_verification'];
const sansSecrets = (f) => {
  const out = { ...f };
  CHAMPS_SECRETS.forEach(k => delete out[k]);
  return out;
};

const COLONNES_LISTE =
  'id, prenom, nom, email, ville, code_postal, type_logement, jardin, nb_adultes, enfants, ' +
  'animaux_actuels, heures_seul, presence_journee, experience_chien, nb_accueils, disponible_le, ' +
  'peut_accueillir, nac_acceptes, statut_dossier, email_verifie, previsitee, decision_motif, decision_date, created_at';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ─── Vérification du compte (avant la double authentification) ─────────────
// La connexion se fait directement auprès de Supabase depuis le site admin
// (mot de passe puis code Google Authenticator). Cette route permet seulement
// de vérifier qu'un compte est admin avant de lui proposer de configurer son code.
router.get('/moi', requireAdminSansMFA, (req, res) => {
  res.json({ admin: true, email: req.user.email, mfa: req.aal === 'aal2' });
});

// ─── Liste des dossiers ──────────────────────────────────────────────────────
router.get('/familles', requireAdmin, async (req, res) => {
  try {
    const statut = STATUTS.includes(req.query.statut) ? req.query.statut : 'en_attente';
    const [{ data: liste, error }, { data: tous, error: e2 }] = await Promise.all([
      supabaseAdmin.from('familles_accueil').select(COLONNES_LISTE)
        .eq('statut_dossier', statut).order('created_at', { ascending: statut === 'en_attente' }),
      supabaseAdmin.from('familles_accueil').select('statut_dossier, decision_date'),
    ]);
    if (error || e2) throw error || e2;

    const compteurs = Object.fromEntries(STATUTS.map(s => [s, 0]));
    let validesSemaine = 0;
    for (const f of tous || []) {
      compteurs[f.statut_dossier] = (compteurs[f.statut_dossier] || 0) + 1;
      if (f.statut_dossier === 'valide' && f.decision_date &&
          Date.now() - new Date(f.decision_date).getTime() < 7 * 86400000) validesSemaine++;
    }
    return res.json({ statut, familles: liste || [], compteurs, valides_semaine: validesSemaine });
  } catch (e) {
    console.error('GET /admin/familles error:', e);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ─── Dossier complet ─────────────────────────────────────────────────────────
router.get('/familles/:id', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('familles_accueil').select('*').eq('id', req.params.id).single();
    if (error || !data) return res.status(404).json({ message: 'Dossier introuvable.' });
    return res.json({ famille: sansSecrets(data) });
  } catch (e) {
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ─── Décision ────────────────────────────────────────────────────────────────
router.patch('/familles/:id', requireAdmin, async (req, res) => {
  try {
    const { statut, motif, notes_internes, notifier = true } = req.body || {};
    const maj = { updated_at: new Date().toISOString() };

    if (statut !== undefined) {
      if (!STATUTS.includes(statut)) return res.status(400).json({ message: 'Statut invalide.' });
      if (statut === 'refuse' && !String(motif || '').trim())
        return res.status(400).json({ message: 'Un motif est requis pour refuser un dossier.' });
      Object.assign(maj, {
        statut_dossier: statut,
        decision_motif: motif ? String(motif).slice(0, 1000) : null,
        decision_date: new Date().toISOString(),
        decision_par: req.user.id,
      });
    }
    if (notes_internes !== undefined) maj.notes_internes = String(notes_internes).slice(0, 4000);

    const { data: f, error } = await supabaseAdmin.from('familles_accueil')
      .update(maj).eq('id', req.params.id).select(COLONNES_LISTE).single();
    if (error || !f) return res.status(404).json({ message: 'Dossier introuvable.' });

    let email = null;
    if (statut && notifier && ['valide', 'refuse', 'incomplet'].includes(statut)) {
      email = await notifierFamille(f, statut, motif).then(() => 'envoye').catch(err => {
        console.error('Email décision FA (non-bloquant):', err.message);
        return 'echec';
      });
    }

    // Une famille nouvellement validée peut convenir aux animaux en attente
    if (statut === 'valide') relancerMatchingAnimauxDisponibles().catch(e => console.error('Rematch error:', e));

    return res.json({ message: 'Dossier mis à jour.', famille: f, email });
  } catch (e) {
    console.error('PATCH /admin/familles error:', e);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ─── E-mail de décision à la famille ─────────────────────────────────────────
async function notifierFamille(f, statut, motif) {
  const { buildEmail, sendBrevoEmail } = require('./auth').mail;
  const prenom = esc(f.prenom || '');
  const contenus = {
    valide: {
      subject: '🎉 Votre dossier famille d\'accueil PetIA est validé !',
      badge: '🎉', color: '#10B981', label: 'Dossier validé',
      title: `Bonne nouvelle ${prenom} !`,
      body: "Votre dossier de famille d'accueil a été validé. Les refuges peuvent désormais vous proposer des animaux correspondant à votre profil. Vous serez prévenu(e) à chaque proposition.",
      cta: 'Accéder à mon espace →',
    },
    incomplet: {
      subject: 'Votre dossier PetIA — informations complémentaires',
      badge: '📋', color: '#F59E0B', label: 'Précisions demandées',
      title: `Votre dossier, ${prenom}`,
      body: 'Nous avons besoin de quelques précisions avant de valider votre dossier'
        + (motif ? ` : <strong style="color:#fff;">${esc(motif)}</strong>` : '.')
        + ' Vous pouvez compléter votre profil depuis votre espace.',
      cta: 'Compléter mon dossier →',
    },
    refuse: {
      subject: 'Votre dossier PetIA — suite de votre inscription',
      badge: '📋', color: '#FF7A59', label: 'Dossier non retenu',
      title: `Votre dossier, ${prenom}`,
      body: `Après examen, nous ne pouvons pas valider votre dossier pour la raison suivante : <strong style="color:#fff;">${esc(motif)}</strong>. N'hésitez pas à nous contacter pour en savoir plus.`,
      cta: 'Nous contacter →',
    },
  }[statut];

  await sendBrevoEmail({
    to: f.email,
    subject: contenus.subject,
    htmlContent: buildEmail({
      badge: contenus.badge, badgeColor: contenus.color,
      label: contenus.label, labelColor: contenus.color,
      title: contenus.title, body: contenus.body,
      ctaText: contenus.cta,
      ctaHref: statut === 'refuse' ? 'mailto:contact@petia.fr' : 'https://petia-frontend.vercel.app',
      ctaColor: contenus.color, ctaShadow: 'rgba(0,0,0,.3)',
      footer: "L'équipe PetIA 🐾",
    }),
  });
}

async function relancerMatchingAnimauxDisponibles() {
  const { lancerMatching } = require('./matching');
  const { data: animaux } = await supabaseAdmin.from('animaux').select('*')
    .eq('statut', 'disponible').order('created_at', { ascending: false }).limit(20);
  for (const a of animaux || []) {
    await lancerMatching(a).catch(e => console.error('Rematch animal', a.id, e.message));
  }
}

module.exports = router;
