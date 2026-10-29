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
const { journaliser, alerterAdmins, surveillerConsultations, signatureAppareil, esc: escJ } = require('../services/journal');
const { profilsDe, estAdminId, bloquerCompte, debloquerCompte, supprimerPersonne } = require('../services/comptes');

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
  'id, bloque_le, cloture_le, prenom, nom, email, ville, code_postal, type_logement, jardin, nb_adultes, enfants, ' +
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
    journaliser(req, { evenement: 'consultation_liste_fa', user: req.user, role: 'admin', details: { statut, nombre: (liste || []).length } });
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
    journaliser(req, { evenement: 'consultation_dossier_fa', user: req.user, role: 'admin', cible_type: 'famille', cible_id: data.id })
      .then(() => surveillerConsultations(req, 'consultation_dossier_fa', req.user));
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

    journaliser(req, { evenement: statut ? 'decision_famille' : 'notes_famille', user: req.user, role: 'admin', cible_type: 'famille', cible_id: f.id,
                       details: statut ? { statut } : null });
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

async function relancerMatchingAnimauxDisponibles(refugeId) {
  const { lancerMatching } = require('./matching');
  let q = supabaseAdmin.from('animaux').select('*').eq('statut', 'disponible');
  if (refugeId) q = q.eq('refuge_id', refugeId);
  const { data: animaux } = await q.order('created_at', { ascending: false }).limit(20);
  for (const a of animaux || []) {
    await lancerMatching(a).catch(e => console.error('Rematch animal', a.id, e.message));
  }
}

// ═══ REFUGES ═════════════════════════════════════════════════════════════════
const STATUTS_REFUGE = ['en_attente', 'actif', 'refuse', 'suspendu'];
const COLONNES_REFUGE =
  'id, nom, email, telephone, type_structure, siret, adresse, code_postal, ville, departement, site_web, ' +
  'contact_prenom, contact_nom, contact_fonction, especes, details, statut, email_verifie, ' +
  'decision_motif, decision_date, created_at, bloque_le, cloture_le';

router.get('/refuges', requireAdmin, async (req, res) => {
  try {
    const { siretValide } = require('../services/refuge');
    const statut = STATUTS_REFUGE.includes(req.query.statut) ? req.query.statut : 'en_attente';
    const [{ data: liste, error }, { data: tous, error: e2 }, { data: nbAnimaux }] = await Promise.all([
      supabaseAdmin.from('refuges').select(COLONNES_REFUGE).eq('statut', statut).order('created_at', { ascending: statut === 'en_attente' }),
      supabaseAdmin.from('refuges').select('statut'),
      supabaseAdmin.from('animaux').select('refuge_id'),
    ]);
    if (error || e2) throw error || e2;
    const compteurs = Object.fromEntries(STATUTS_REFUGE.map(s => [s, 0]));
    (tous || []).forEach(r => { compteurs[r.statut] = (compteurs[r.statut] || 0) + 1; });
    const animauxPar = {};
    (nbAnimaux || []).forEach(a => { animauxPar[a.refuge_id] = (animauxPar[a.refuge_id] || 0) + 1; });
    journaliser(req, { evenement: 'consultation_liste_refuges', user: req.user, role: 'admin', details: { statut } });
    const refuges = (liste || []).map(r => ({ ...r, siret_valide: r.siret ? siretValide(r.siret) : null, nb_animaux: animauxPar[r.id] || 0 }));
    return res.json({ statut, refuges, compteurs });
  } catch (e) {
    console.error('GET /admin/refuges error:', e);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

router.patch('/refuges/:id', requireAdmin, async (req, res) => {
  try {
    const { statut, motif, notes_internes, notifier = true } = req.body || {};
    const maj = { updated_at: new Date().toISOString() };
    if (statut !== undefined) {
      if (!STATUTS_REFUGE.includes(statut)) return res.status(400).json({ message: 'Statut invalide.' });
      if (['refuse', 'suspendu'].includes(statut) && !String(motif || '').trim())
        return res.status(400).json({ message: 'Un motif est requis pour refuser ou suspendre un refuge.' });
      Object.assign(maj, { statut, decision_motif: motif ? String(motif).slice(0, 1000) : null,
                           decision_date: new Date().toISOString(), decision_par: req.user.id });
    }
    if (notes_internes !== undefined) maj.notes_internes = String(notes_internes).slice(0, 4000);
    const { data: r, error } = await supabaseAdmin.from('refuges').update(maj).eq('id', req.params.id).select(COLONNES_REFUGE).single();
    if (error || !r) return res.status(404).json({ message: 'Refuge introuvable.' });

    let email = null;
    if (statut && notifier && ['actif', 'refuse', 'suspendu'].includes(statut))
      email = await notifierRefuge(r, statut, motif).then(() => 'envoye').catch(err => {
        console.error('Email décision refuge (non-bloquant):', err.message); return 'echec';
      });
    journaliser(req, { evenement: statut ? 'decision_refuge' : 'notes_refuge', user: req.user, role: 'admin', cible_type: 'refuge', cible_id: r.id,
                       details: statut ? { statut } : null });
    // Refuge validé : ses animaux disponibles reçoivent des propositions
    if (statut === 'actif') relancerMatchingAnimauxDisponibles(r.id).catch(e => console.error('Rematch refuge:', e));
    return res.json({ message: 'Refuge mis à jour.', refuge: r, email });
  } catch (e) {
    console.error('PATCH /admin/refuges error:', e);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

async function notifierRefuge(r, statut, motif) {
  const { buildEmail, sendBrevoEmail } = require('./auth').mail;
  const nom = esc(r.nom || '');
  const c = {
    actif: { subject: '🎉 Votre structure est validée sur PetIA', color: '#4F72F5', badge: '🎉', label: 'Dossier validé',
             title: `Félicitations, ${nom} !`, body: 'Votre structure est validée. Vous pouvez dès maintenant publier vos animaux et recevoir des propositions de familles d\'accueil.',
             cta: 'Publier mes animaux →', href: 'https://petia-frontend.vercel.app' },
    refuse: { subject: 'Votre inscription PetIA', color: '#FF7A59', badge: '📋', label: 'Inscription non retenue',
              title: `Votre dossier, ${nom}`, body: `Après examen, nous ne pouvons pas valider votre inscription : <strong style="color:#fff;">${esc(motif)}</strong>. N'hésitez pas à nous contacter.`,
              cta: 'Nous contacter →', href: 'mailto:contact@petia.fr' },
    suspendu: { subject: 'Votre compte PetIA est suspendu', color: '#EF4444', badge: '⏸', label: 'Compte suspendu',
                title: `Votre compte, ${nom}`, body: `Votre compte est suspendu : <strong style="color:#fff;">${esc(motif)}</strong>. Contactez-nous pour en savoir plus.`,
                cta: 'Nous contacter →', href: 'mailto:contact@petia.fr' },
  }[statut];
  await sendBrevoEmail({ to: r.email, subject: c.subject, htmlContent: buildEmail({
    badge: c.badge, badgeColor: c.color, label: c.label, labelColor: c.color, title: c.title, body: c.body,
    ctaText: c.cta, ctaHref: c.href, ctaColor: c.color, ctaShadow: 'rgba(0,0,0,.3)', footer: "L'équipe PetIA 🐾" }) });
}


// ═══ SÉCURITÉ : connexion admin, journal, blocage ═══════════════════════════

// ─── POST /api/admin/connexion — appelé par le site admin après le code ──────
// Toute connexion admin est journalisée et signalée par e-mail aux admins.
router.post('/connexion', requireAdmin, async (req, res) => {
  const sig = signatureAppareil(req.headers['user-agent']);
  await journaliser(req, { evenement: 'connexion_admin', user: req.user, role: 'admin' });
  alerterAdmins(req, {
    evenement: 'alerte_connexion_admin', sujet: 'Connexion à l\'espace admin',
    message: `Connexion à l'espace admin PetIA avec le compte <strong style="color:#fff;">${escJ(req.user.email)}</strong>, `
      + `le ${new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })} (${escJ(sig)}, IP ${escJ(req.ipClient || req.ip)}).<br><br>`
      + 'Si ce n\'est pas vous, changez immédiatement le mot de passe de ce compte et retirez-le de la liste des admins.',
    details: { compte: req.user.id },
  }).catch(() => {});
  res.json({ ok: true });
});

// ─── GET /api/admin/journal?evenement=&email=&jours=&alertes=1 ───────────────
router.get('/journal', requireAdmin, async (req, res) => {
  try {
    const jours = Math.min(Math.max(parseInt(req.query.jours, 10) || 7, 1), 366);
    let q = supabaseAdmin.from('journal_acces')
      .select('id, cree_le, evenement, user_id, email, role, cible_type, cible_id, ip, appareil, details')
      .gte('cree_le', new Date(Date.now() - jours * 86400000).toISOString())
      .order('cree_le', { ascending: false }).limit(300);
    if (req.query.alertes === '1') q = q.or('evenement.like.alerte_*,evenement.in.(connexion_echec,mfa_echec,connexion_refusee_verrou,connexion_refusee_bloque,compte_bloque_par_utilisateur,compte_bloque_par_admin)');
    else if (typeof req.query.evenement === 'string' && /^[a-z_]{2,60}$/.test(req.query.evenement)) q = q.eq('evenement', req.query.evenement);
    if (typeof req.query.email === 'string' && req.query.email.trim())
      q = q.ilike('email', '%' + req.query.email.trim().toLowerCase().replace(/[\\%_]/g, c => '\\' + c).slice(0, 100) + '%');
    const { data, error } = await q;
    if (error) throw error;
    const lignes = (data || []).map(l => ({ ...l, appareil: l.appareil ? signatureAppareil(l.appareil) : null }));
    return res.json({ lignes, jours });
  } catch (e) {
    console.error('GET /admin/journal error:', e);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ─── POST /api/admin/comptes/:id/bloquer | /debloquer ────────────────────────
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.post('/comptes/:id/bloquer', requireAdmin, async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ message: 'Identifiant invalide.' });
    if (req.params.id === req.user.id) return res.status(400).json({ message: 'Vous ne pouvez pas bloquer votre propre compte.' });
    if (await estAdminId(req.params.id)) return res.status(400).json({ message: 'Un compte administrateur ne peut pas être bloqué ici.' });
    const profils = await profilsDe(req.params.id);
    if (!profils.length) return res.status(404).json({ message: 'Compte introuvable.' });
    await bloquerCompte(req.params.id, profils[0].ligne.email);
    await journaliser(req, { evenement: 'compte_bloque_par_admin', user: req.user, role: 'admin', cible_type: 'compte', cible_id: req.params.id,
                             details: req.body?.motif ? { motif: String(req.body.motif).slice(0, 300) } : null });
    return res.json({ message: 'Compte bloqué : sessions fermées, connexion impossible.' });
  } catch (e) {
    console.error('bloquer error:', e);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

router.post('/comptes/:id/debloquer', requireAdmin, async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ message: 'Identifiant invalide.' });
    const profils = await profilsDe(req.params.id);
    if (!profils.length) return res.status(404).json({ message: 'Compte introuvable.' });
    if (profils.every(p => p.ligne.cloture_le)) return res.status(409).json({ message: 'Ce compte est clôturé : il ne peut pas être débloqué.' });
    await debloquerCompte(req.params.id);
    await journaliser(req, { evenement: 'compte_debloque', user: req.user, role: 'admin', cible_type: 'compte', cible_id: req.params.id });
    return res.json({ message: 'Compte débloqué. Conseillez à la personne de réinitialiser son mot de passe.' });
  } catch (e) {
    console.error('debloquer error:', e);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ─── POST /api/admin/purge — exécute la suppression automatique maintenant ───
router.post('/purge', requireAdmin, async (req, res) => {
  try {
    const { lancerPurge } = require('../services/purge');
    return res.json({ bilan: await lancerPurge({ forcer: true, req }) });
  } catch (e) {
    console.error('purge error:', e);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ═══ OUTIL DPO : retrouver, exporter, supprimer les données d'une personne ═══

const echapperLike = (v) => String(v).replace(/[\\%_]/g, c => '\\' + c);

// ─── GET /api/admin/dpo/recherche?q= (e-mail, nom, prénom ou téléphone) ──────
router.get('/dpo/recherche', requireAdmin, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 100);
    if (q.length < 3) return res.status(400).json({ message: 'Saisissez au moins 3 caractères.' });
    const motif = '%' + echapperLike(q) + '%';
    const chiffres = q.replace(/\D/g, '');
    const personnes = new Map();
    const ajouter = (type, r) => {
      const p = personnes.get(r.id) || { id: r.id, email: r.email, types: [], nom: null, bloque_le: r.bloque_le, cloture_le: r.cloture_le };
      p.types.push(type);
      p.nom = p.nom || (type === 'fa' ? [r.prenom, r.nom].filter(Boolean).join(' ') : r.nom);
      personnes.set(r.id, p);
    };
    const recherches = [];
    for (const col of ['email', 'nom', 'prenom', 'telephone'])
      recherches.push(supabaseAdmin.from('familles_accueil').select('id, email, prenom, nom, bloque_le, cloture_le').ilike(col, motif).limit(20)
        .then(({ data }) => (data || []).forEach(r => ajouter('fa', r))));
    for (const col of ['email', 'nom', 'contact_nom', 'contact_prenom', 'telephone'])
      recherches.push(supabaseAdmin.from('refuges').select('id, email, nom, bloque_le, cloture_le').ilike(col, motif).limit(20)
        .then(({ data }) => (data || []).forEach(r => ajouter('refuge', r))));
    if (chiffres.length >= 6) {
      // Téléphone saisi avec ou sans espaces
      const motifTel = '%' + chiffres.split('').join('%') + '%';
      recherches.push(supabaseAdmin.from('familles_accueil').select('id, email, prenom, nom, bloque_le, cloture_le').ilike('telephone', motifTel).limit(20)
        .then(({ data }) => (data || []).forEach(r => ajouter('fa', r))));
      recherches.push(supabaseAdmin.from('refuges').select('id, email, nom, bloque_le, cloture_le').ilike('telephone', motifTel).limit(20)
        .then(({ data }) => (data || []).forEach(r => ajouter('refuge', r))));
    }
    await Promise.all(recherches);
    const liste = [...personnes.values()].map(p => ({ ...p, types: [...new Set(p.types)] }));

    // Adresse e-mail présente seulement dans le journal (ex. tentatives de connexion)
    let journal_seul = null;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q) && !liste.some(p => (p.email || '').toLowerCase() === q.toLowerCase())) {
      const { count } = await supabaseAdmin.from('journal_acces').select('id', { count: 'exact', head: true }).eq('email', q.toLowerCase());
      if (count) journal_seul = { email: q.toLowerCase(), lignes: count };
    }
    await journaliser(req, { evenement: 'dpo_recherche', user: req.user, role: 'admin', details: { resultats: liste.length } });
    return res.json({ personnes: liste, journal_seul });
  } catch (e) {
    console.error('dpo/recherche error:', e);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// Inventaire complet des données d'une personne
async function inventaire(id) {
  const { data: u } = await supabaseAdmin.auth.admin.getUserById(id);
  const user = u?.user || null;
  const inv = {
    genere_le: new Date().toISOString(),
    compte: user && {
      id: user.id, email: user.email, cree_le: user.created_at, derniere_connexion: user.last_sign_in_at,
      email_confirme_le: user.email_confirmed_at, double_authentification: (user.factors || []).some(f => f.status === 'verified'),
      bloque_jusqu_au: user.banned_until || null,
    },
    administrateur: await estAdminId(id),
    famille_accueil: null, refuge: null, matchs: [], animaux: [], evaluations: [], journal: { total: 0, lignes: [] },
    jetons: { reinitialisation_mdp: 0, blocage: 0 },
  };
  const { data: fa } = await supabaseAdmin.from('familles_accueil').select('*').eq('id', id).maybeSingle();
  if (fa) {
    inv.famille_accueil = sansSecrets(fa);
    const { data: m } = await supabaseAdmin.from('matchs')
      .select('id, statut, score, recommandation, reponse_fa, date_reponse_fa, date_debut_accueil, date_fin_accueil, created_at, details_score, animal:animaux(nom, espece, refuge:refuges(nom))')
      .eq('famille_id', id);
    inv.matchs = m || [];
    const { data: ev } = await supabaseAdmin.from('evaluations').select('*').eq('famille_id', id);
    inv.evaluations = ev || [];
  }
  const { data: ref } = await supabaseAdmin.from('refuges').select('*').eq('id', id).maybeSingle();
  if (ref) {
    inv.refuge = sansSecrets(ref);
    const { data: an } = await supabaseAdmin.from('animaux').select('id, nom, espece, sous_espece, statut, created_at').eq('refuge_id', id);
    inv.animaux = an || [];
    const { data: ev } = await supabaseAdmin.from('evaluations').select('*').eq('refuge_id_eval', id);
    inv.evaluations = inv.evaluations.concat(ev || []);
  }
  const email = (user?.email || fa?.email || ref?.email || '').toLowerCase();
  const filtre = email ? `user_id.eq.${id},email.eq."${email.replace(/["\\,()]/g, '')}"` : `user_id.eq.${id}`;
  const { data: j, count } = await supabaseAdmin.from('journal_acces')
    .select('cree_le, evenement, role, cible_type, cible_id, ip, appareil', { count: 'exact' })
    .or(filtre).order('cree_le', { ascending: false }).limit(500);
  inv.journal = { total: count || 0, lignes: (j || []).map(l => ({ ...l, appareil: l.appareil ? signatureAppareil(l.appareil) : null })) };
  const [{ count: c1 }, { count: c2 }] = await Promise.all([
    supabaseAdmin.from('reinitialisations_mdp').select('id', { count: 'exact', head: true }).eq('user_id', id),
    supabaseAdmin.from('jetons_blocage').select('id', { count: 'exact', head: true }).eq('user_id', id),
  ]);
  inv.jetons = { reinitialisation_mdp: c1 || 0, blocage: c2 || 0 };
  return inv;
}

// ─── GET /api/admin/dpo/personne/:id[?export=1] ──────────────────────────────
router.get('/dpo/personne/:id', requireAdmin, async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ message: 'Identifiant invalide.' });
    const inv = await inventaire(req.params.id);
    if (!inv.compte && !inv.famille_accueil && !inv.refuge) return res.status(404).json({ message: 'Personne introuvable.' });
    await journaliser(req, { evenement: req.query.export === '1' ? 'dpo_export' : 'dpo_consultation', user: req.user, role: 'admin',
                             cible_type: 'compte', cible_id: req.params.id });
    return res.json(inv);
  } catch (e) {
    console.error('dpo/personne error:', e);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ─── DELETE /api/admin/dpo/personne/:id — { confirmation: e-mail, motif } ────
router.delete('/dpo/personne/:id', requireAdmin, async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ message: 'Identifiant invalide.' });
    if (req.params.id === req.user.id) return res.status(400).json({ message: 'Utilisez un autre compte admin pour supprimer vos propres données.' });
    const profils = await profilsDe(req.params.id);
    const { data: u } = await supabaseAdmin.auth.admin.getUserById(req.params.id);
    const email = (u?.user?.email || profils[0]?.ligne.email || '').toLowerCase();
    if (!email) return res.status(404).json({ message: 'Personne introuvable.' });
    if (String(req.body?.confirmation || '').trim().toLowerCase() !== email)
      return res.status(400).json({ message: 'Pour confirmer, saisissez exactement l\'adresse e-mail de la personne.' });

    const bilan = await supprimerPersonne(req.params.id, email);
    await journaliser(req, { evenement: 'dpo_suppression', user: req.user, role: 'admin', cible_type: 'compte', cible_id: req.params.id,
                             details: { ...bilan, motif: req.body?.motif ? String(req.body.motif).slice(0, 300) : null } });
    return res.json({ message: 'Données supprimées.', bilan });
  } catch (e) {
    console.error('dpo/suppression error:', e);
    return res.status(500).json({ message: 'Erreur lors de la suppression : ' + e.message });
  }
});

// ─── POST /api/admin/dpo/journal-email — { email } : anonymise le journal seul ─
router.post('/dpo/journal-email', requireAdmin, async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ message: 'Adresse e-mail invalide.' });
    const { data: n, error } = await supabaseAdmin.rpc('anonymiser_journal', { p_user: null, p_email: email });
    if (error) throw error;
    await journaliser(req, { evenement: 'dpo_anonymisation_journal', user: req.user, role: 'admin', details: { lignes: n } });
    return res.json({ message: `${n} ligne(s) du journal anonymisée(s).` });
  } catch (e) {
    console.error('dpo/journal-email error:', e);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

module.exports = router;
