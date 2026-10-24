// petia-backend/routes/auth.js
// Auth via Supabase Auth + emails via Brevo API directement
// Variables d'env requises : SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY, BREVO_API_KEY

const express = require('express');
const router  = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('../middleware/admin');
const { requireUser, clientEphemere, facteursActifs, gotrue, verifierCode } = require('../middleware/session');
const { nettoyerProfil, creerJetonInscription } = require('../services/profilFA');
const { nettoyerRefuge, siretValide, esc } = require('../services/refuge');
const crypto = require('crypto');
const { journaliser, compter, compteVerrouille, envoyerMail, alerterAdmins, creerLienBlocage,
        verifierNouvelAppareil, hacher, ip: ipDe, SITE } = require('../services/journal');
const { profilsDe, noterActivite, sessionServeur, fermerSessions, bloquerCompte,
        verifierNouveauMotDePasse } = require('../services/comptes');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── Template email commun ───────────────────────────────────────────────────
function buildEmail({ badge, badgeColor, label, labelColor, title, body, ctaText, ctaHref, ctaColor, ctaShadow, footer }) {
  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700&display=swap" rel="stylesheet">
</head>
<body style="margin:0;padding:0;background:#0B1426;font-family:'Sora',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0B1426;padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:520px;background:#111E38;border-radius:20px;border:1px solid rgba(255,255,255,.08);overflow:hidden;">
        <tr>
          <td style="background:linear-gradient(135deg,#0B1426 0%,#172444 100%);padding:28px 32px;border-bottom:1px solid rgba(255,255,255,.08);">
            <table cellpadding="0" cellspacing="0"><tr>
              <td style="width:40px;height:40px;background:${badgeColor};border-radius:10px;text-align:center;vertical-align:middle;font-size:20px;line-height:40px;">${badge}</td>
              <td style="padding-left:12px;font-size:22px;font-weight:700;color:#fff;letter-spacing:-.4px;">Pet<span style="color:#FF7A59;">IA</span></td>
            </tr></table>
          </td>
        </tr>
        <tr>
          <td style="padding:36px 32px 28px;">
            <p style="margin:0 0 8px;font-size:12px;font-weight:600;color:${labelColor};text-transform:uppercase;letter-spacing:.1em;">${label}</p>
            <h1 style="margin:0 0 16px;font-size:24px;font-weight:700;color:#fff;line-height:1.25;">${title}</h1>
            <p style="margin:0 0 4px;font-size:15px;color:rgba(255,255,255,.6);line-height:1.7;">${body}</p>
            <table cellpadding="0" cellspacing="0" style="margin:28px 0;"><tr>
              <td style="background:${ctaColor};border-radius:12px;box-shadow:0 4px 18px ${ctaShadow};">
                <a href="${ctaHref}" style="display:inline-block;padding:14px 30px;color:#fff;font-size:15px;font-weight:700;text-decoration:none;">${ctaText}</a>
              </td>
            </tr></table>
            <p style="margin:0;font-size:13px;color:rgba(255,255,255,.28);line-height:1.6;">${footer}</p>
          </td>
        </tr>
        <tr>
          <td style="padding:18px 32px;border-top:1px solid rgba(255,255,255,.06);background:#0B1426;">
            <p style="margin:0;font-size:12px;color:rgba(255,255,255,.2);text-align:center;">PetIA — La plateforme de mise en relation entre animaux et familles d'accueil</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ─── Envoi email via Brevo ────────────────────────────────────────────────────
async function sendBrevoEmail({ to, subject, htmlContent }) {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': process.env.BREVO_API_KEY
    },
    body: JSON.stringify({
      sender: { name: 'PetIA', email: process.env.BREVO_SENDER_EMAIL || 'charlotterisb@gmail.com' },
      to: [{ email: to }],
      subject,
      htmlContent
    })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Brevo error: ${err}`);
  }
  return res.json();
}

// Champs publics
const FA_PUBLIC_FIELDS = [
  'id', 'prenom', 'nom', 'email', 'telephone',
  'ville', 'code_postal', 'departement',
  'type_logement', 'jardin', 'superficie',
  'disponible_le', 'statut_dossier',
  'nb_accueils', 'note_moyenne', 'created_at'
];

const REFUGE_PUBLIC_FIELDS = [
  'id', 'nom', 'email', 'telephone',
  'ville', 'code_postal', 'departement',
  'type_structure', 'statut', 'created_at'
];

function pickFields(obj, fields) {
  const result = {};
  fields.forEach(f => { if (obj[f] !== undefined) result[f] = obj[f]; });
  return result;
}

// ─── POST /api/auth/register-fa ──────────────────────────────────────────────
router.post('/register-fa', async (req, res) => {
  try {
    const { email, password, prenom, nom, ville, code_postal, departement, telephone } = req.body;
    if (!email || !password || !prenom || !nom || !ville || !code_postal || !departement)
      return res.status(400).json({ message: 'Champs obligatoires manquants' });

    const { data: authData, error: authError } = await clientEphemere().auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: 'https://petia-frontend.vercel.app',
        data: { role: 'fa', prenom, nom }
      }
    });

    if (authError) {
      if (authError.message.includes('already registered'))
        return res.status(409).json({ message: 'Email déjà utilisé' });
      throw authError;
    }

    const { data, error } = await supabaseAdmin
      .from('familles_accueil')
      .insert({
        id: authData.user.id,
        email, prenom, nom, ville, code_postal, departement,
        telephone: typeof telephone === 'string' ? telephone.trim().slice(0, 30) : null,
        // Logement & quotidien saisis sur la page d'inscription
        ...nettoyerProfil(req.body.profil || {}),
        // Dossier complet seulement une fois le questionnaire envoyé
        statut_dossier: 'incomplet',
        password_hash: 'supabase_auth'
      })
      .select()
      .single();

    if (error) throw error;

    try {
      await sendBrevoEmail({
        to: email,
        subject: '🐾 Bienvenue sur PetIA — Confirmez votre compte',
        htmlContent: buildEmail({
          badge: '🐾', badgeColor: '#FF7A59',
          label: "Inscription famille d'accueil", labelColor: '#FF7A59',
          title: `Bienvenue chez PetIA,<br>${esc(prenom)} !`,
          body: "Votre compte famille d'accueil a bien été créé. Plus qu'une étape : confirmez votre adresse email pour activer votre compte et commencer à accueillir des animaux.",
          ctaText: 'Confirmer mon compte →',
          ctaHref: 'https://petia-frontend.vercel.app',
          ctaColor: '#FF7A59', ctaShadow: 'rgba(255,122,89,.4)',
          footer: "Le lien est valable 24 heures. Si vous n'avez pas créé ce compte, ignorez cet email."
        })
      });
    } catch (emailErr) {
      console.error('Brevo email error (non-bloquant):', emailErr.message);
    }

    journaliser(req, { evenement: 'inscription', userId: data.id, email, role: 'fa' });
    return res.status(201).json({
      message: 'Compte créé ! Vérifiez votre email.',
      famille: pickFields(data, FA_PUBLIC_FIELDS),
      // Permet d'envoyer le questionnaire dans les 24 h, sans être connecté
      jeton_inscription: creerJetonInscription(data.id)
    });

  } catch (e) {
    console.error('register-fa error:', e);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ─── POST /api/auth/register-refuge ──────────────────────────────────────────
router.post('/register-refuge', async (req, res) => {
  try {
    const { email, password, nom, ville, code_postal, departement } = req.body;
    if (!email || !password || !nom || !ville || !code_postal || !departement)
      return res.status(400).json({ message: 'Champs obligatoires manquants' });
    const infos = nettoyerRefuge(req.body);
    if (req.body.siret && String(req.body.siret).trim() && !(infos.siret && siretValide(infos.siret)))
      return res.status(400).json({ message: 'Numéro SIRET invalide : vérifiez les 14 chiffres.' });

    const { data: authData, error: authError } = await clientEphemere().auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: 'https://petia-frontend.vercel.app',
        data: { role: 'refuge', nom }
      }
    });

    if (authError) {
      if (authError.message.includes('already registered'))
        return res.status(409).json({ message: 'Email déjà utilisé' });
      throw authError;
    }

    const { data, error } = await supabaseAdmin
      .from('refuges')
      .insert({
        id: authData.user.id,
        email, nom, ville, code_postal, departement,
        ...infos,
        // Validation par l'équipe PetIA obligatoire avant de publier des animaux
        statut: 'en_attente',
        password_hash: 'supabase_auth'
      })
      .select()
      .single();

    if (error) throw error;

    try {
      await sendBrevoEmail({
        to: email,
        subject: '🐾 Bienvenue sur PetIA — Votre dossier est en cours de validation',
        htmlContent: buildEmail({
          badge: '🏠', badgeColor: '#4F72F5',
          label: 'Inscription refuge / fourrière', labelColor: '#4F72F5',
          title: `Bienvenue chez PetIA,<br>${esc(nom)} !`,
          body: "Votre compte a bien été créé. Votre dossier est en cours de validation par notre équipe — vous recevrez une confirmation sous <strong style=\"color:#fff;\">48h</strong>.",
          ctaText: 'Accéder à mon espace →',
          ctaHref: 'https://petia-frontend.vercel.app',
          ctaColor: '#4F72F5', ctaShadow: 'rgba(79,114,245,.4)',
          footer: "Si vous n'avez pas créé ce compte, ignorez cet email."
        })
      });
    } catch (emailErr) {
      console.error('Brevo email error (non-bloquant):', emailErr.message);
    }

    journaliser(req, { evenement: 'inscription', userId: data.id, email, role: 'refuge' });
    return res.status(201).json({
      message: 'Compte créé ! Vérifiez votre email.',
      refuge: pickFields(data, REFUGE_PUBLIC_FIELDS)
    });

  } catch (e) {
    console.error('register-refuge error:', e);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ═══ CONNEXION ═══════════════════════════════════════════════════════════════
// Journalisée ; verrouillage 15 minutes après 5 échecs ; alerte e-mail en cas
// de connexion depuis un appareil ou une adresse IP inhabituels.

const MSG_VERROU = 'Trop de tentatives sur ce compte. Pour votre sécurité, il est verrouillé 15 minutes.';

async function connexion(req, res, type) {
  const role = type === 'fa' ? 'fa' : 'refuge';
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = req.body?.password;
  if (!email || !password)
    return res.status(400).json({ message: 'Email et mot de passe requis.' });

  try {
    if (await compteVerrouille(email)) {
      journaliser(req, { evenement: 'connexion_refusee_verrou', email, role });
      return res.status(429).json({ message: MSG_VERROU });
    }

    const { data: authData, error: authError } = await clientEphemere().auth.signInWithPassword({ email, password });
    if (authError) {
      const bloque = authError.code === 'user_banned' || /banned/i.test(authError.message || '');
      await journaliser(req, { evenement: bloque ? 'connexion_refusee_bloque' : 'connexion_echec', email, role });
      if (bloque) return res.status(403).json({ message: 'Ce compte est bloqué ou clôturé. Contactez PetIA.' });
      return res.status(401).json({ message: 'Email ou mot de passe incorrect.' });
    }
    const user = authData.user;

    const table = type === 'fa' ? 'familles_accueil' : 'refuges';
    const { data: profil } = await supabaseAdmin.from(table).select('*').eq('id', user.id).maybeSingle();
    if (!profil) {
      await journaliser(req, { evenement: 'connexion_echec', user, role, details: { raison: 'profil_absent' } });
      return res.status(404).json({ message: 'Profil introuvable.' });
    }

    const refus = profil.bloque_le ? 'Ce compte est bloqué. Contactez PetIA pour le débloquer.'
      : profil.cloture_le ? 'Ce compte est clôturé.'
      : (type === 'fa' ? profil.statut_dossier : profil.statut) === 'suspendu' ? 'Votre compte a été suspendu.'
      : type === 'refuge' && profil.statut === 'refuse'
        ? 'Votre inscription n\'a pas été retenue' + (profil.decision_motif ? ' : ' + profil.decision_motif.replace(/[.\s]+$/, '') + '.' : '.') + ' Contactez-nous pour en savoir plus.'
      : null;
    if (refus) {
      await journaliser(req, { evenement: 'connexion_refusee_statut', user, role });
      await supabaseAdmin.auth.admin.signOut(authData.session.access_token, 'local').catch(() => {});
      return res.status(403).json({ message: refus });
    }

    // Double authentification activée : on demande le code avant d'ouvrir la session
    if (facteursActifs(user).length) {
      await journaliser(req, { evenement: 'connexion_mdp_ok_code_attendu', user, role });
      return res.json({ mfa_required: true, ticket: authData.session.access_token });
    }

    await journaliser(req, { evenement: 'connexion_reussie', user, role });
    verifierNouvelAppareil(req, user);
    noterActivite(table, profil).catch(() => {});
    return res.json(type === 'fa'
      ? { token: authData.session.access_token, famille: pickFields(profil, FA_PUBLIC_FIELDS) }
      : { token: authData.session.access_token, refuge: pickFields(profil, REFUGE_PUBLIC_FIELDS) });
  } catch (err) {
    console.error(`login-${type} error:`, err);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
}

router.post('/login-fa', (req, res) => connexion(req, res, 'fa'));
router.post('/login-fourriere', (req, res) => connexion(req, res, 'refuge'));

// ═══ MOT DE PASSE OUBLIÉ ═════════════════════════════════════════════════════
// Lien PetIA valable 5 minutes, à usage unique (seule l'empreinte du jeton est
// conservée) ; code Google Authenticator exigé si la double authentification
// est activée ; fermeture de toutes les sessions ; e-mail d'alerte avec
// « Ce n'était pas moi ». 3 demandes par heure maximum par e-mail et par IP.

const DUREE_LIEN_MIN = 5;
const MSG_DEMANDE = 'Si un compte existe avec cette adresse, un lien de réinitialisation valable 5 minutes vient de vous être envoyé.';

async function trouverCompteParEmail(email) {
  const motif = email.replace(/[\\%_]/g, c => '\\' + c);
  for (const t of ['familles_accueil', 'refuges']) {
    const { data } = await supabaseAdmin.from(t).select('id, email, prenom, nom, bloque_le, cloture_le').ilike('email', motif).limit(1);
    if (data?.[0]) return { table: t, ...data[0] };
  }
  return null;
}

// ─── POST /api/auth/mot-de-passe/demande — { email } ─────────────────────────
router.post('/mot-de-passe/demande', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 200);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ message: 'Adresse e-mail invalide.' });
  // Même réponse, au même moment, que le compte existe ou non
  res.json({ message: MSG_DEMANDE });

  try {
    const [parEmail, parIp] = await Promise.all([
      compter({ evenement: 'mdp_demande', email, minutes: 60 }),
      compter({ evenement: 'mdp_demande', ipReq: ipDe(req), minutes: 60 }),
    ]);
    if (parEmail >= 3 || parIp >= 3)
      return journaliser(req, { evenement: 'mdp_demande_ignoree', email, details: { raison: parEmail >= 3 ? 'limite_email' : 'limite_ip' } });
    await journaliser(req, { evenement: 'mdp_demande', email });

    const compte = await trouverCompteParEmail(email);
    if (!compte || compte.bloque_le || compte.cloture_le) return;

    const jeton = crypto.randomBytes(32).toString('base64url');
    await supabaseAdmin.from('reinitialisations_mdp').delete().eq('user_id', compte.id).is('utilise_le', null);
    const { error } = await supabaseAdmin.from('reinitialisations_mdp').insert({
      user_id: compte.id, jeton_hash: hacher(jeton), ip: ipDe(req),
      expire_le: new Date(Date.now() + DUREE_LIEN_MIN * 60000).toISOString(),
    });
    if (error) throw error;

    await envoyerMail({
      to: compte.email, subject: '🔐 Réinitialisation de votre mot de passe PetIA',
      title: 'Réinitialisation<br>de votre mot de passe',
      body: `Vous avez demandé à réinitialiser votre mot de passe. Le lien ci-dessous est valable <strong style="color:#fff;">${DUREE_LIEN_MIN} minutes</strong> et ne peut servir qu'une fois.`
        + '<br><br>Si la double authentification est activée sur votre compte, le code Google Authenticator vous sera demandé.',
      ctaText: 'Choisir un nouveau mot de passe →', ctaHref: `${SITE}/#mdp=${jeton}`,
      footer: "Vous n'êtes pas à l'origine de cette demande ? Ignorez cet e-mail : votre mot de passe reste inchangé.",
    });
  } catch (e) {
    console.error('mot-de-passe/demande error:', e);
  }
});

// Demande de réinitialisation encore valable (sans la consommer)
async function lireDemande(jeton) {
  if (typeof jeton !== 'string' || jeton.length < 20 || jeton.length > 100) return null;
  const { data } = await supabaseAdmin.from('reinitialisations_mdp')
    .select('id, user_id, expire_le, utilise_le').eq('jeton_hash', hacher(jeton)).maybeSingle();
  if (!data || data.utilise_le || new Date(data.expire_le).getTime() < Date.now()) return null;
  return data;
}
const MSG_LIEN_INVALIDE = 'Ce lien n\'est plus valable (5 minutes, usage unique). Faites une nouvelle demande.';

// ─── POST /api/auth/mot-de-passe/verifier — { jeton } ────────────────────────
router.post('/mot-de-passe/verifier', async (req, res) => {
  try {
    const d = await lireDemande(req.body?.jeton);
    if (!d) return res.status(410).json({ message: MSG_LIEN_INVALIDE });
    const { data: u } = await supabaseAdmin.auth.admin.getUserById(d.user_id);
    return res.json({ valide: true, mfa: facteursActifs(u?.user).length > 0,
                      expire_dans: Math.max(0, Math.round((new Date(d.expire_le).getTime() - Date.now()) / 1000)) });
  } catch (e) {
    console.error('mot-de-passe/verifier error:', e);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// Après un changement de mot de passe : sessions fermées, alerte e-mail
async function apresChangementMotDePasse(req, user, evenement) {
  await fermerSessions({ email: user.email });
  await journaliser(req, { evenement, user });
  const lien = await creerLienBlocage(user.id);
  await envoyerMail({
    to: user.email, subject: '🔐 Votre mot de passe PetIA a été modifié',
    title: 'Votre mot de passe<br>a été modifié',
    body: `Le mot de passe de votre compte a été modifié le ${new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}. Toutes vos sessions ont été fermées.`
      + '<br><br>Si vous n\'êtes pas à l\'origine de ce changement, bloquez immédiatement votre compte.',
    ctaText: 'Ce n\'était pas moi : bloquer mon compte', ctaHref: lien || SITE, couleur: '#EF4444',
    footer: 'Ce lien est valable 7 jours. Après blocage, contactez PetIA pour retrouver l\'accès à votre compte.',
  });
}

// ─── POST /api/auth/mot-de-passe/nouveau — { jeton, mot_de_passe, code? } ────
router.post('/mot-de-passe/nouveau', async (req, res) => {
  try {
    const { jeton, mot_de_passe, code } = req.body || {};
    const d = await lireDemande(jeton);
    if (!d) return res.status(410).json({ message: MSG_LIEN_INVALIDE });

    const { data: u } = await supabaseAdmin.auth.admin.getUserById(d.user_id);
    const user = u?.user;
    if (!user) return res.status(410).json({ message: MSG_LIEN_INVALIDE });
    const profils = await profilsDe(user.id);
    if (profils.some(p => p.ligne.bloque_le || p.ligne.cloture_le))
      return res.status(403).json({ message: 'Ce compte est bloqué ou clôturé. Contactez PetIA.' });

    const probleme = await verifierNouveauMotDePasse(mot_de_passe, user.email);
    if (probleme) return res.status(400).json({ message: probleme });

    // Double authentification : le code est exigé même avec le lien
    const facteur = facteursActifs(user)[0];
    if (facteur) {
      if (!code) return res.status(400).json({ message: 'Saisissez le code Google Authenticator.', code: 'MFA_REQUIRED' });
      try {
        const s = await sessionServeur(user.email);
        await verifierCode(s.access_token, facteur.id, code);
      } catch (e) {
        await journaliser(req, { evenement: 'mdp_reinit_code_echec', user, cible_type: 'reinitialisation', cible_id: d.id });
        if (await compter({ evenement: 'mdp_reinit_code_echec', cible_id: d.id, minutes: 10 }) >= 5)
          await supabaseAdmin.from('reinitialisations_mdp').update({ utilise_le: new Date().toISOString() }).eq('id', d.id);
        return res.status(401).json({ message: 'Code incorrect ou expiré.' });
      }
    }

    // Usage unique, y compris si deux requêtes arrivent en même temps
    const { data: pris } = await supabaseAdmin.from('reinitialisations_mdp')
      .update({ utilise_le: new Date().toISOString() }).eq('id', d.id).is('utilise_le', null).select('id');
    if (!pris?.length) return res.status(410).json({ message: MSG_LIEN_INVALIDE });

    const { error } = await supabaseAdmin.auth.admin.updateUserById(user.id, { password: mot_de_passe });
    if (error) throw error;
    await apresChangementMotDePasse(req, user, 'mdp_reinitialise');
    return res.json({ message: 'Mot de passe modifié. Toutes vos sessions ont été fermées : connectez-vous avec votre nouveau mot de passe.' });
  } catch (e) {
    console.error('mot-de-passe/nouveau error:', e);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ─── POST /api/auth/mot-de-passe/changer — { actuel, nouveau, code? } ────────
// Depuis son espace : mot de passe actuel + code si la double authentification est activée
router.post('/mot-de-passe/changer', requireUser, async (req, res) => {
  try {
    const { actuel, nouveau, code } = req.body || {};
    if (!actuel || !nouveau) return res.status(400).json({ message: 'Mot de passe actuel et nouveau mot de passe requis.' });
    if (await compteVerrouille(req.user.email)) return res.status(429).json({ message: MSG_VERROU });

    const { data: v, error: e1 } = await clientEphemere().auth.signInWithPassword({ email: req.user.email, password: actuel });
    if (e1 || !v?.session) {
      await journaliser(req, { evenement: 'connexion_echec', user: req.user, details: { contexte: 'changement_mdp' } });
      return res.status(401).json({ message: 'Mot de passe actuel incorrect.' });
    }
    const facteur = facteursActifs(req.user)[0];
    if (facteur) {
      if (!code) return res.status(400).json({ message: 'Saisissez le code Google Authenticator.', code: 'MFA_REQUIRED' });
      try { await verifierCode(v.session.access_token, facteur.id, code); }
      catch (e) {
        await journaliser(req, { evenement: 'mfa_echec', user: req.user, details: { contexte: 'changement_mdp' } });
        return res.status(401).json({ message: 'Code incorrect ou expiré.' });
      }
    }
    if (actuel === nouveau) return res.status(400).json({ message: 'Le nouveau mot de passe doit être différent de l\'actuel.' });
    const probleme = await verifierNouveauMotDePasse(nouveau, req.user.email);
    if (probleme) return res.status(400).json({ message: probleme });

    const { error } = await supabaseAdmin.auth.admin.updateUserById(req.user.id, { password: nouveau });
    if (error) throw error;
    await apresChangementMotDePasse(req, req.user, 'mdp_change');
    return res.json({ message: 'Mot de passe modifié. Reconnectez-vous avec votre nouveau mot de passe.' });
  } catch (e) {
    console.error('mot-de-passe/changer error:', e);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ─── POST /api/auth/compte-bloque — { jeton } (« Ce n'était pas moi ») ───────
router.post('/compte-bloque', async (req, res) => {
  try {
    const jeton = req.body?.jeton;
    if (typeof jeton !== 'string' || jeton.length < 20 || jeton.length > 100)
      return res.status(400).json({ message: 'Lien invalide.' });
    const { data: j } = await supabaseAdmin.from('jetons_blocage')
      .update({ utilise_le: new Date().toISOString() })
      .eq('jeton_hash', hacher(jeton)).is('utilise_le', null).gt('expire_le', new Date().toISOString())
      .select('user_id');
    if (!j?.length) return res.status(410).json({ message: 'Ce lien n\'est plus valable. Contactez PetIA si vous pensez que votre compte est utilisé par quelqu\'un d\'autre.' });

    const { data: u } = await supabaseAdmin.auth.admin.getUserById(j[0].user_id);
    if (!u?.user) return res.status(410).json({ message: 'Compte introuvable.' });
    await bloquerCompte(u.user.id, u.user.email);
    await journaliser(req, { evenement: 'compte_bloque_par_utilisateur', user: u.user });
    await alerterAdmins(req, {
      evenement: 'alerte_compte_bloque', sujet: 'Un utilisateur a bloqué son compte',
      message: `Le compte <strong style="color:#fff;">${esc(u.user.email)}</strong> a été bloqué par son titulaire (« Ce n'était pas moi »). Contactez la personne pour vérifier son identité avant de débloquer le compte depuis l'espace admin.`,
      details: { compte: u.user.id },
    });
    return res.json({ message: 'Votre compte est bloqué et toutes les sessions sont fermées. L\'équipe PetIA a été prévenue et vous recontactera pour rétablir l\'accès.' });
  } catch (e) {
    console.error('compte-bloque error:', e);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ═══ SESSIONS ET CLÔTURE ═════════════════════════════════════════════════════

// ─── POST /api/auth/sessions/fermer — déconnecter tous mes appareils ─────────
router.post('/sessions/fermer', requireUser, async (req, res) => {
  const ok = await fermerSessions({ token: req.token });
  await journaliser(req, { evenement: 'sessions_fermees', user: req.user });
  if (!ok) return res.status(500).json({ message: 'Impossible de fermer les sessions, réessayez.' });
  return res.json({ message: 'Toutes vos sessions sont fermées, y compris celle-ci.' });
});

// ─── POST /api/auth/cloturer — { mot_de_passe } ──────────────────────────────
// Fermeture du compte par la FA ou le refuge. Les données sont supprimées
// automatiquement 2 ans après la clôture (ou plus tôt sur demande au DPO).
router.post('/cloturer', requireUser, async (req, res) => {
  try {
    if (!req.body?.mot_de_passe) return res.status(400).json({ message: 'Confirmez avec votre mot de passe.' });
    const { error: e1 } = await clientEphemere().auth.signInWithPassword({ email: req.user.email, password: req.body.mot_de_passe });
    if (e1) {
      await journaliser(req, { evenement: 'connexion_echec', user: req.user, details: { contexte: 'cloture' } });
      return res.status(401).json({ message: 'Mot de passe incorrect.' });
    }

    const maintenant = new Date().toISOString();
    for (const p of req.profils || []) {
      if (p.table === 'familles_accueil') {
        const { count } = await supabaseAdmin.from('matchs').select('id', { count: 'exact', head: true })
          .eq('famille_id', req.user.id).eq('statut', 'en_cours');
        if (count) return res.status(409).json({ message: 'Un accueil est en cours : le refuge doit d\'abord en confirmer la fin.' });
      } else {
        const { data: animaux } = await supabaseAdmin.from('animaux').select('id').eq('refuge_id', req.user.id);
        const ids = (animaux || []).map(a => a.id);
        if (ids.length) {
          const { count } = await supabaseAdmin.from('matchs').select('id', { count: 'exact', head: true })
            .in('animal_id', ids).eq('statut', 'en_cours');
          if (count) return res.status(409).json({ message: 'Des animaux sont en accueil : confirmez d\'abord la fin de ces accueils.' });
        }
      }
    }

    for (const p of req.profils || []) {
      if (p.table === 'familles_accueil') {
        await supabaseAdmin.from('matchs').update({ statut: 'annule', updated_at: maintenant })
          .eq('famille_id', req.user.id).in('statut', ['propose', 'accepte']);
      } else {
        const { data: animaux } = await supabaseAdmin.from('animaux').select('id').eq('refuge_id', req.user.id);
        const ids = (animaux || []).map(a => a.id);
        if (ids.length) await supabaseAdmin.from('matchs').update({ statut: 'annule', updated_at: maintenant })
          .in('animal_id', ids).in('statut', ['propose', 'accepte']);
      }
      await supabaseAdmin.from(p.table).update({ cloture_le: maintenant }).eq('id', req.user.id);
    }

    await fermerSessions({ token: req.token });
    await supabaseAdmin.auth.admin.updateUserById(req.user.id, { ban_duration: '876000h' });
    await journaliser(req, { evenement: 'compte_cloture', user: req.user });

    const suppression = new Date(Date.now() + 730 * 86400000).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' });
    envoyerMail({
      to: req.user.email, subject: 'Votre compte PetIA est clôturé', badge: '👋', couleur: '#64748B', label: 'Clôture du compte',
      title: 'Votre compte<br>est clôturé',
      body: `Votre compte PetIA a été clôturé à votre demande. Vos données seront supprimées définitivement le <strong style="color:#fff;">${suppression}</strong> au plus tard.`
        + '<br><br>Vous pouvez demander leur suppression immédiate en écrivant à notre délégué à la protection des données.',
      ctaText: 'Contacter PetIA →', ctaHref: 'mailto:contact@petia.fr',
    });
    return res.json({ message: 'Votre compte est clôturé.', suppression_prevue: suppression });
  } catch (e) {
    console.error('cloturer error:', e);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ─── POST /api/auth/refuge-validated ──────────────────────────────────────────
// À appeler depuis le dashboard admin quand un dossier refuge est validé
router.post('/refuge-validated', requireAdmin, async (req, res) => {
  const { email, nom } = req.body;
  if (!email || !nom) return res.status(400).json({ message: 'Email et nom requis.' });

  try {
    await sendBrevoEmail({
      to: email,
      subject: '🎉 Votre dossier PetIA a été validé !',
      htmlContent: buildEmail({
        badge: '🎉', badgeColor: '#4F72F5',
        label: 'Dossier validé', labelColor: '#4F72F5',
        title: `Félicitations ${nom},<br>votre dossier est validé !`,
        body: "Notre équipe a examiné votre dossier et votre structure est officiellement référencée sur PetIA. Vous pouvez dès maintenant publier vos animaux et recevoir des propositions de familles d'accueil.",
        ctaText: 'Publier mes animaux →',
        ctaHref: 'https://petia-frontend.vercel.app',
        ctaColor: '#4F72F5', ctaShadow: 'rgba(79,114,245,.4)',
        footer: "Bienvenue dans le réseau PetIA 🐾"
      })
    });
    return res.json({ message: 'Email de validation refuge envoyé.' });
  } catch (err) {
    console.error('refuge-validated error:', err);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ─── POST /api/auth/refuge-rejected ───────────────────────────────────────────
// À appeler depuis le dashboard admin quand un dossier refuge est refusé
router.post('/refuge-rejected', requireAdmin, async (req, res) => {
  const { email, nom, raison } = req.body;
  if (!email || !nom) return res.status(400).json({ message: 'Email et nom requis.' });

  try {
    await sendBrevoEmail({
      to: email,
      subject: 'Votre dossier PetIA — Suite de votre inscription',
      htmlContent: buildEmail({
        badge: '📋', badgeColor: '#FF7A59',
        label: 'Dossier en attente', labelColor: '#FF7A59',
        title: `Votre dossier,<br>${nom}`,
        body: raison
          ? `Après examen de votre dossier, nous ne sommes pas en mesure de valider votre inscription pour la raison suivante : <strong style="color:#fff;">${raison}</strong>. N'hésitez pas à nous contacter pour plus d'informations.`
          : "Après examen de votre dossier, nous ne sommes pas en mesure de valider votre inscription pour le moment. N'hésitez pas à nous contacter pour plus d'informations.",
        ctaText: 'Nous contacter →',
        ctaHref: 'mailto:contact@petia.fr',
        ctaColor: '#FF7A59', ctaShadow: 'rgba(255,122,89,.4)',
        footer: "L'équipe PetIA reste disponible pour répondre à vos questions."
      })
    });
    return res.json({ message: 'Email de refus refuge envoyé.' });
  } catch (err) {
    console.error('refuge-rejected error:', err);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ─── POST /api/auth/logout ────────────────────────────────────────────────────
// Ferme la session de cet appareil (le jeton ne fonctionne plus ensuite)
router.post('/logout', async (req, res) => {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) {
    const token = auth.slice(7);
    const { data } = await supabaseAdmin.auth.getUser(token).catch(() => ({ data: {} }));
    if (data?.user) {
      await supabaseAdmin.auth.admin.signOut(token, 'local').catch(() => {});
      await journaliser(req, { evenement: 'deconnexion', user: data.user });
    }
  }
  return res.json({ message: 'Déconnexion effectuée.' });
});

// ═══ DOUBLE AUTHENTIFICATION (facultative) — Google Authenticator ═══════════

const messageCode = (e) =>
  e.status === 422 || e.status === 400 ? 'Code incorrect ou expiré.' : 'Erreur lors de la vérification du code.';

// ─── POST /api/auth/mfa/login — 2e étape de connexion ────────────────────────
// { ticket (jeton obtenu avec le mot de passe), code, type: 'fa' | 'refuge' }
router.post('/mfa/login', async (req, res) => {
  const { ticket, code, type } = req.body || {};
  if (!ticket || !code || !['fa', 'refuge'].includes(type))
    return res.status(400).json({ message: 'Requête incomplète.' });
  try {
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(ticket);
    if (error || !user) return res.status(401).json({ message: 'Session expirée, reconnectez-vous.' });
    const facteur = facteursActifs(user)[0];
    if (!facteur) return res.status(400).json({ message: 'Double authentification non activée.' });
    if (await compteVerrouille(user.email)) return res.status(429).json({ message: MSG_VERROU });

    let session;
    try { session = await verifierCode(ticket, facteur.id, code); }
    catch (e) {
      await journaliser(req, { evenement: 'mfa_echec', user, role: type });
      return res.status(401).json({ message: messageCode(e) });
    }

    const table = type === 'fa' ? 'familles_accueil' : 'refuges';
    const { data: profil } = await supabaseAdmin.from(table).select('*').eq('id', user.id).single();
    if (!profil) return res.status(404).json({ message: 'Profil introuvable.' });
    if (profil.bloque_le || profil.cloture_le) return res.status(403).json({ message: 'Ce compte est bloqué ou clôturé. Contactez PetIA.' });

    await journaliser(req, { evenement: 'connexion_reussie', user, role: type, details: { mfa: true } });
    verifierNouvelAppareil(req, user);
    noterActivite(table, profil).catch(() => {});

    return res.json(type === 'fa'
      ? { token: session.access_token, famille: pickFields(profil, FA_PUBLIC_FIELDS) }
      : { token: session.access_token, refuge: pickFields(profil, REFUGE_PUBLIC_FIELDS) });
  } catch (e) {
    console.error('mfa/login error:', e);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ─── GET /api/auth/mfa/statut ────────────────────────────────────────────────
router.get('/mfa/statut', requireUser, (req, res) => {
  res.json({ active: facteursActifs(req.user).length > 0 });
});

// ─── POST /api/auth/mfa/activer — affiche le QR code ─────────────────────────
router.post('/mfa/activer', requireUser, async (req, res) => {
  try {
    if (facteursActifs(req.user).length)
      return res.status(400).json({ message: 'La double authentification est déjà activée.' });
    // Supprime une activation commencée mais jamais terminée
    for (const f of (req.user.factors || []).filter(f => f.status !== 'verified'))
      await gotrue(`/factors/${f.id}`, { method: 'DELETE', token: req.token }).catch(() => {});
    const f = await gotrue('/factors', {
      method: 'POST', token: req.token,
      body: { factor_type: 'totp', friendly_name: 'PetIA', issuer: 'PetIA' },
    });
    return res.json({ factor_id: f.id, qr_code: f.totp?.qr_code, secret: f.totp?.secret, uri: f.totp?.uri });
  } catch (e) {
    console.error('mfa/activer error:', e);
    return res.status(500).json({ message: 'Impossible de démarrer l\'activation.' });
  }
});

// ─── POST /api/auth/mfa/confirmer — { factor_id, code } ──────────────────────
// Renvoie un nouveau jeton (session validée avec le code)
router.post('/mfa/confirmer', requireUser, async (req, res) => {
  const { factor_id, code } = req.body || {};
  if (!factor_id || !code) return res.status(400).json({ message: 'Code requis.' });
  try {
    const session = await verifierCode(req.token, factor_id, code);
    await journaliser(req, { evenement: 'mfa_active', user: req.user });
    return res.json({ token: session.access_token });
  } catch (e) {
    return res.status(400).json({ message: messageCode(e) });
  }
});

// ─── POST /api/auth/mfa/desactiver — { code } ────────────────────────────────
router.post('/mfa/desactiver', requireUser, async (req, res) => {
  const facteur = facteursActifs(req.user)[0];
  if (!facteur) return res.status(400).json({ message: 'La double authentification n\'est pas activée.' });
  if (!req.body?.code) return res.status(400).json({ message: 'Code requis.' });
  try {
    let session;
    try { session = await verifierCode(req.token, facteur.id, req.body.code); }
    catch (e) { return res.status(400).json({ message: messageCode(e) }); }
    await gotrue(`/factors/${facteur.id}`, { method: 'DELETE', token: session.access_token });
    await journaliser(req, { evenement: 'mfa_desactive', user: req.user });
    return res.json({ token: session.access_token });
  } catch (e) {
    console.error('mfa/desactiver error:', e);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

module.exports = router;
module.exports.mail = { buildEmail, sendBrevoEmail };
