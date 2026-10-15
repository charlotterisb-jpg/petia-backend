// petia-backend/routes/auth.js
// Auth via Supabase Auth natif — emails de confirmation et reset gratuits
// Variables d'env requises : SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY

const express = require('express');
const router  = express.Router();
const { createClient } = require('@supabase/supabase-js');

// Client avec anon key pour les opérations auth côté utilisateur
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Client avec service key pour les opérations admin (lecture profils)
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Champs publics renvoyés au frontend
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

    // 1. Créer le compte Supabase Auth (envoie email de confirmation automatiquement)
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

    // 2. Créer le profil dans familles_accueil
    const { data, error } = await supabaseAdmin
      .from('familles_accueil')
      .insert({ 
        id: authData.user.id,
        email, prenom, nom, ville, code_postal, departement,
        password_hash: 'supabase_auth' // marqueur — mot de passe géré par Supabase Auth
      })
      .select()
      .single();

    if (error) throw error;

    return res.status(201).json({
      message: 'Compte créé ! Vérifiez votre email pour confirmer votre inscription.',
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

    return res.status(201).json({
      message: 'Compte créé ! Vérifiez votre email pour confirmer votre inscription.',
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

    if (authError) {
      if (authError.message.includes('Email not confirmed'))
        return res.status(401).json({ message: 'Confirmez votre email avant de vous connecter.' });
      return res.status(401).json({ message: 'Email ou mot de passe incorrect.' });
    }

    // Récupérer le profil
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
      refresh_token: authData.session.refresh_token,
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

    if (authError) {
      if (authError.message.includes('Email not confirmed'))
        return res.status(401).json({ message: 'Confirmez votre email avant de vous connecter.' });
      return res.status(401).json({ message: 'Email ou mot de passe incorrect.' });
    }

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
      refresh_token: authData.session.refresh_token,
      refuge: pickFields(refuge, REFUGE_PUBLIC_FIELDS)
    });

  } catch (err) {
    console.error('login-fourriere error:', err);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ─── POST /api/auth/reset-password ───────────────────────────────────────────
// Envoie un email de reset via Supabase Auth (gratuit, automatique)
router.post('/reset-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: 'Email requis.' });

  try {
    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: 'https://petia-frontend.vercel.app?reset=true'
    });
    // Réponse identique même si l'email n'existe pas (évite l'énumération)
    return res.json({ message: 'Si cet email existe, un lien de réinitialisation vous a été envoyé.' });
  } catch (err) {
    console.error('reset-password error:', err);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ─── POST /api/auth/logout ────────────────────────────────────────────────────
router.post('/logout', async (req, res) => {
  const token = req.headers.authorization?.slice(7);
  if (token) {
    const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } }
    });
    await client.auth.signOut();
  }
  return res.json({ message: 'Déconnexion effectuée.' });
});

module.exports = router;
