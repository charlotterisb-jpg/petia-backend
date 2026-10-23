// petia-backend/routes/auth.js
// Auth via Supabase Auth + emails via Brevo API directement
// Variables d'env requises : SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY, BREVO_API_KEY

const express = require('express');
const router  = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('../middleware/admin');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

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
    const { email, password, prenom, nom, ville, code_postal, departement } = req.body;
    if (!email || !password || !prenom || !nom || !ville || !code_postal || !departement)
      return res.status(400).json({ message: 'Champs obligatoires manquants' });

    const { data: authData, error: authError } = await supabase.auth.signUp({
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
          title: `Bienvenue chez PetIA,<br>${prenom} !`,
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

    return res.status(201).json({
      message: 'Compte créé ! Vérifiez votre email.',
      famille: pickFields(data, FA_PUBLIC_FIELDS)
    });

  } catch (e) {
    console.error('register-fa error:', e);
    return res.status(500).json({ message: 'Erreur serveur', detail: e.message });
  }
});

// ─── POST /api/auth/register-refuge ──────────────────────────────────────────
router.post('/register-refuge', async (req, res) => {
  try {
    const { email, password, nom, ville, code_postal, departement } = req.body;
    if (!email || !password || !nom || !ville || !code_postal || !departement)
      return res.status(400).json({ message: 'Champs obligatoires manquants' });

    const { data: authData, error: authError } = await supabase.auth.signUp({
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
          title: `Bienvenue chez PetIA,<br>${nom} !`,
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

    return res.status(201).json({
      message: 'Compte créé ! Vérifiez votre email.',
      refuge: pickFields(data, REFUGE_PUBLIC_FIELDS)
    });

  } catch (e) {
    console.error('register-refuge error:', e);
    return res.status(500).json({ message: 'Erreur serveur', detail: e.message });
  }
});

// ─── POST /api/auth/login-fa ──────────────────────────────────────────────────
router.post('/login-fa', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ message: 'Email et mot de passe requis.' });

  try {
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({ email, password });

    if (authError)
      return res.status(401).json({ message: 'Email ou mot de passe incorrect.' });

    const { data: fa, error } = await supabaseAdmin
      .from('familles_accueil')
      .select('*')
      .eq('id', authData.user.id)
      .single();

    if (error || !fa)
      return res.status(404).json({ message: 'Profil introuvable.' });

    if (fa.statut_dossier === 'suspendu')
      return res.status(403).json({ message: 'Votre compte a été suspendu.' });

    return res.json({
      token: authData.session.access_token,
      famille: pickFields(fa, FA_PUBLIC_FIELDS)
    });

  } catch (err) {
    console.error('login-fa error:', err);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ─── POST /api/auth/login-fourriere ──────────────────────────────────────────
router.post('/login-fourriere', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ message: 'Email et mot de passe requis.' });

  try {
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({ email, password });

    if (authError)
      return res.status(401).json({ message: 'Email ou mot de passe incorrect.' });

    const { data: refuge, error } = await supabaseAdmin
      .from('refuges')
      .select('*')
      .eq('id', authData.user.id)
      .single();

    if (error || !refuge)
      return res.status(404).json({ message: 'Profil introuvable.' });

    if (refuge.statut === 'suspendu')
      return res.status(403).json({ message: 'Votre compte a été suspendu.' });

    return res.json({
      token: authData.session.access_token,
      refuge: pickFields(refuge, REFUGE_PUBLIC_FIELDS)
    });

  } catch (err) {
    console.error('login-fourriere error:', err);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ─── POST /api/auth/reset-password ───────────────────────────────────────────
router.post('/reset-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: 'Email requis.' });

  try {
    const { data, error } = await supabaseAdmin.auth.admin.generateLink({
      type: 'recovery',
      email,
      options: { redirectTo: 'https://petia-frontend.vercel.app?reset=true' }
    });

    if (!error && data?.properties?.action_link) {
      try {
        await sendBrevoEmail({
          to: email,
          subject: '🔐 Réinitialisation de votre mot de passe PetIA',
          htmlContent: buildEmail({
            badge: '🔐', badgeColor: '#7C3AED',
            label: 'Sécurité du compte', labelColor: '#7C3AED',
            title: 'Réinitialisation<br>de votre mot de passe',
            body: 'Vous avez demandé à réinitialiser votre mot de passe. Cliquez sur le bouton ci-dessous — le lien est valable <strong style="color:#fff;">1 heure</strong>.',
            ctaText: 'Réinitialiser mon mot de passe →',
            ctaHref: data.properties.action_link,
            ctaColor: '#7C3AED', ctaShadow: 'rgba(124,58,237,.4)',
            footer: "Si vous n'avez pas fait cette demande, ignorez cet email."
          })
        });
      } catch (emailErr) {
        console.error('Brevo reset email error:', emailErr.message);
      }
    }

    return res.json({ message: 'Si cet email existe, un lien de réinitialisation vous a été envoyé.' });

  } catch (err) {
    console.error('reset-password error:', err);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ─── POST /api/auth/confirm-email ─────────────────────────────────────────────
// Appelé par le frontend après que Supabase a vérifié l'email (redirect URL)
// Le frontend reçoit le token dans l'URL et appelle cette route pour envoyer la confirmation
router.post('/confirm-email', async (req, res) => {
  const { email, prenom, role } = req.body;
  if (!email) return res.status(400).json({ message: 'Email requis.' });

  try {
    await sendBrevoEmail({
      to: email,
      subject: '✅ Votre compte PetIA est activé !',
      htmlContent: buildEmail({
        badge: '✅', badgeColor: '#22C55E',
        label: 'Compte activé', labelColor: '#22C55E',
        title: `Votre compte est activé${prenom ? `,<br>${prenom}` : ''} !`,
        body: role === 'refuge'
          ? "Votre adresse email a bien été confirmée. Votre dossier est en cours de validation par notre équipe — nous vous contacterons sous 48h."
          : "Votre adresse email a bien été confirmée. Votre compte est maintenant actif — vous pouvez vous connecter et commencer à accueillir des animaux.",
        ctaText: 'Accéder à mon espace →',
        ctaHref: 'https://petia-frontend.vercel.app',
        ctaColor: '#22C55E', ctaShadow: 'rgba(34,197,94,.4)',
        footer: "Bienvenue dans la communauté PetIA 🐾"
      })
    });
    return res.json({ message: 'Email de confirmation envoyé.' });
  } catch (err) {
    console.error('confirm-email error:', err);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ─── POST /api/auth/password-changed ──────────────────────────────────────────
// À appeler depuis le frontend après un changement de mot de passe réussi
router.post('/password-changed', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: 'Email requis.' });

  try {
    await sendBrevoEmail({
      to: email,
      subject: '🔒 Votre mot de passe PetIA a été modifié',
      htmlContent: buildEmail({
        badge: '🔒', badgeColor: '#7C3AED',
        label: 'Sécurité du compte', labelColor: '#7C3AED',
        title: 'Mot de passe modifié',
        body: 'Votre mot de passe PetIA a bien été mis à jour. Si vous êtes à l\'origine de cette modification, vous pouvez ignorer cet email. <strong style="color:#fff;">Si vous ne reconnaissez pas cette action</strong>, contactez-nous immédiatement.',
        ctaText: 'Accéder à mon compte →',
        ctaHref: 'https://petia-frontend.vercel.app',
        ctaColor: '#7C3AED', ctaShadow: 'rgba(124,58,237,.4)',
        footer: "En cas de problème, répondez à cet email ou contactez notre support."
      })
    });
    return res.json({ message: 'Email de confirmation de changement de mot de passe envoyé.' });
  } catch (err) {
    console.error('password-changed error:', err);
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
router.post('/logout', async (req, res) => {
  return res.json({ message: 'Déconnexion effectuée.' });
});

module.exports = router;
module.exports.mail = { buildEmail, sendBrevoEmail };
