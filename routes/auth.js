// petia-backend/routes/auth.js
// Auth via Supabase Auth + emails via Brevo API directement
// Variables d'env requises : SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY, BREVO_API_KEY

const express = require('express');
const router  = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

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

    // Créer le compte Supabase Auth
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

    // Créer le profil
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

    // Envoyer email de confirmation via Brevo
    try {
      await sendBrevoEmail({
        to: email,
        subject: '🐾 Bienvenue sur PetIA — Confirmez votre compte',
        htmlContent: `
<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700&display=swap" rel="stylesheet">
</head>
<body style="margin:0;padding:0;background:#0B1426;font-family:'Sora',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0B1426;padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:520px;background:#111E38;border-radius:20px;border:1px solid rgba(255,255,255,.08);overflow:hidden;">

        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#0B1426 0%,#172444 100%);padding:32px 32px 24px;border-bottom:1px solid rgba(255,255,255,.08);">
            <span style="font-size:26px;font-weight:700;color:#fff;font-family:'Sora',Arial,sans-serif;letter-spacing:-.4px;">Pet<span style="color:#FF7A59;">IA</span></span>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:36px 32px 28px;">
            <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#FF7A59;text-transform:uppercase;letter-spacing:.08em;">Inscription famille d'accueil</p>
            <h1 style="margin:0 0 16px;font-size:26px;font-weight:700;color:#fff;line-height:1.2;">Bienvenue chez PetIA,<br>${prenom} ! 🎉</h1>
            <p style="margin:0 0 12px;font-size:15px;color:rgba(255,255,255,.6);line-height:1.7;">
              Votre compte famille d'accueil a bien été créé. Plus qu'une étape : confirmez votre adresse email pour activer votre compte et commencer à accueillir des animaux.
            </p>

            <!-- CTA -->
            <table cellpadding="0" cellspacing="0" style="margin:28px 0;">
              <tr>
                <td style="background:#FF7A59;border-radius:12px;box-shadow:0 4px 18px rgba(255,122,89,.4);">
                  <a href="https://petia-frontend.vercel.app" style="display:inline-block;padding:15px 32px;color:#fff;font-size:15px;font-weight:700;text-decoration:none;letter-spacing:-.2px;">
                    Confirmer mon compte →
                  </a>
                </td>
              </tr>
            </table>

            <p style="margin:0;font-size:13px;color:rgba(255,255,255,.3);line-height:1.6;">
              Le lien est valable 24 heures. Si vous n'avez pas créé ce compte, ignorez simplement cet email.
            </p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding:20px 32px;border-top:1px solid rgba(255,255,255,.06);background:#0B1426;">
            <p style="margin:0;font-size:12px;color:rgba(255,255,255,.25);text-align:center;">
              PetIA — La plateforme de mise en relation entre animaux et familles d'accueil
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>
        `
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
        subject: '🐾 Bienvenue sur PetIA — Confirmez votre compte',
        htmlContent: `
<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700&display=swap" rel="stylesheet">
</head>
<body style="margin:0;padding:0;background:#0B1426;font-family:'Sora',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0B1426;padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:520px;background:#111E38;border-radius:20px;border:1px solid rgba(255,255,255,.08);overflow:hidden;">
        <tr>
          <td style="background:linear-gradient(135deg,#0B1426 0%,#172444 100%);padding:32px 32px 24px;border-bottom:1px solid rgba(255,255,255,.08);">
            <span style="font-size:26px;font-weight:700;color:#fff;font-family:'Sora',Arial,sans-serif;letter-spacing:-.4px;">Pet<span style="color:#FF7A59;">IA</span></span>
          </td>
        </tr>
        <tr>
          <td style="padding:36px 32px 28px;">
            <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#4F72F5;text-transform:uppercase;letter-spacing:.08em;">Inscription refuge / fourrière</p>
            <h1 style="margin:0 0 16px;font-size:26px;font-weight:700;color:#fff;line-height:1.2;">Bienvenue chez PetIA,<br>${nom} ! 🎉</h1>
            <p style="margin:0 0 12px;font-size:15px;color:rgba(255,255,255,.6);line-height:1.7;">
              Votre compte a bien été créé. Votre dossier est en cours de validation par notre équipe — vous recevrez une confirmation sous 48h.
            </p>
            <table cellpadding="0" cellspacing="0" style="margin:28px 0;"><tr>
              <td style="background:#4F72F5;border-radius:12px;box-shadow:0 4px 18px rgba(79,114,245,.4);">
                <a href="https://petia-frontend.vercel.app" style="display:inline-block;padding:15px 32px;color:#fff;font-size:15px;font-weight:700;text-decoration:none;">
                  Accéder à mon espace →
                </a>
              </td>
            </tr></table>
            <p style="margin:0;font-size:13px;color:rgba(255,255,255,.3);line-height:1.6;">Si vous n'avez pas créé ce compte, ignorez cet email.</p>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 32px;border-top:1px solid rgba(255,255,255,.06);background:#0B1426;">
            <p style="margin:0;font-size:12px;color:rgba(255,255,255,.25);text-align:center;">PetIA — La plateforme de mise en relation entre animaux et familles d'accueil</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>
        `
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
    // Générer un lien de reset via Supabase Admin
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
          htmlContent: `
            <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px;background:#0f0f11;color:#e8e0ff;border-radius:16px;">
              <span style="font-size:26px;font-weight:700;color:#fff;font-family:'Sora',Arial,sans-serif;letter-spacing:-.4px;display:block;margin-bottom:24px;">Pet<span style="color:#FF7A59;">IA</span></span>
              <h1 style="color:#FF7A59;font-size:24px;font-family:'Sora',Arial,sans-serif;">Réinitialisation du mot de passe 🔐</h1>
              <p style="color:rgba(255,255,255,.6);">Vous avez demandé à réinitialiser votre mot de passe PetIA.</p>
              <p style="color:rgba(255,255,255,.6);">Cliquez sur le bouton ci-dessous (valable 1 heure) :</p>
              <a href="${data.properties.action_link}" style="display:inline-block;margin:20px 0;padding:15px 32px;background:#FF7A59;color:#fff;border-radius:12px;text-decoration:none;font-weight:700;font-family:'Sora',Arial,sans-serif;box-shadow:0 4px 18px rgba(255,122,89,.4);">Réinitialiser mon mot de passe →</a>
              <p style="color:rgba(255,255,255,.3);font-size:12px;margin-top:32px;">Si vous n'avez pas fait cette demande, ignorez cet email.</p>
            </div>
          `
        });
      } catch (emailErr) {
        console.error('Brevo reset email error:', emailErr.message);
      }
    }

    // Réponse identique même si l'email n'existe pas
    return res.json({ message: 'Si cet email existe, un lien de réinitialisation vous a été envoyé.' });

  } catch (err) {
    console.error('reset-password error:', err);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ─── POST /api/auth/logout ────────────────────────────────────────────────────
router.post('/logout', async (req, res) => {
  return res.json({ message: 'Déconnexion effectuée.' });
});

module.exports = router;
