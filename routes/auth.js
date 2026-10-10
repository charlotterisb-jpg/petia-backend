// petia-backend/routes/auth.js
// Routes d'authentification — familles d'accueil + fourrières
// Dépendances : express, bcrypt, jsonwebtoken, @supabase/supabase-js
// Variables d'env requises : SUPABASE_URL, SUPABASE_SERVICE_KEY, JWT_SECRET

const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY   // clé service — jamais exposée côté client
);

const JWT_SECRET  = process.env.JWT_SECRET;
const JWT_EXPIRES = '7d';  // token valable 7 jours

// ─── Utilitaires ──────────────────────────────────────────────────────────────

function makeToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

// Champs FA renvoyés au frontend (jamais le hash mot de passe)
const FA_PUBLIC_FIELDS = [
  'id', 'prenom', 'nom', 'email', 'telephone',
  'ville', 'code_postal', 'departement',
  'type_logement', 'jardin', 'superficie',
  'disponible_le', 'statut_dossier',
  'nb_accueils', 'note_moyenne',
  'created_at'
];

// Champs refuge renvoyés au frontend
const REFUGE_PUBLIC_FIELDS = [
  'id', 'nom', 'email', 'telephone',
  'ville', 'code_postal', 'departement',
  'type_structure', 'statut',
  'created_at'
];

function pickFields(obj, fields) {
  const result = {};
  fields.forEach(f => { if (obj[f] !== undefined) result[f] = obj[f]; });
  return result;
}

// ─── POST /api/auth/login-fa ──────────────────────────────────────────────────
// Body : { email, password }
// Retour : { token, famille: { ... } }

router.post('/login-fa', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: 'Email et mot de passe requis.' });
  }

  try {
    // Récupérer la famille par email
    const { data: fa, error } = await supabase
      .from('familles_accueil')
      .select('*')
      .eq('email', email.toLowerCase().trim())
      .single();

    if (error || !fa) {
      return res.status(401).json({ message: 'Email ou mot de passe incorrect.' });
    }

    // Vérifier le mot de passe
    const valid = await bcrypt.compare(password, fa.password_hash);
    if (!valid) {
      return res.status(401).json({ message: 'Email ou mot de passe incorrect.' });
    }

    // Vérifier que le compte est actif (pas suspendu)
    if (fa.statut_dossier === 'suspendu') {
      return res.status(403).json({ message: 'Votre compte a été suspendu. Contactez PetIA.' });
    }

    // Générer le token JWT
    const token = makeToken({ id: fa.id, role: 'fa', email: fa.email });

    return res.json({
      token,
      famille: pickFields(fa, FA_PUBLIC_FIELDS)
    });

  } catch (err) {
    console.error('login-fa error:', err);
    return res.status(500).json({ message: 'Erreur serveur. Réessayez.' });
  }
});

// ─── POST /api/auth/login-fourriere ──────────────────────────────────────────
// Body : { email, password }
// Retour : { token, refuge: { ... } }

router.post('/login-fourriere', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: 'Email et mot de passe requis.' });
  }

  try {
    const { data: refuge, error } = await supabase
      .from('refuges')
      .select('*')
      .eq('email', email.toLowerCase().trim())
      .single();

    if (error || !refuge) {
      return res.status(401).json({ message: 'Email ou mot de passe incorrect.' });
    }

    const valid = await bcrypt.compare(password, refuge.password_hash);
    if (!valid) {
      return res.status(401).json({ message: 'Email ou mot de passe incorrect.' });
    }

    if (refuge.statut === 'suspendu') {
      return res.status(403).json({ message: 'Votre compte a été suspendu. Contactez PetIA.' });
    }

    const token = makeToken({ id: refuge.id, role: 'refuge', email: refuge.email });

    return res.json({
      token,
      refuge: pickFields(refuge, REFUGE_PUBLIC_FIELDS)
    });

  } catch (err) {
    console.error('login-fourriere error:', err);
    return res.status(500).json({ message: 'Erreur serveur. Réessayez.' });
  }
});

// ─── POST /api/auth/reset-password ───────────────────────────────────────────
// Body : { email, role }  — role = 'fa' | 'fourriere'
// Envoie un lien de réinitialisation via Brevo (à brancher)

router.post('/reset-password', async (req, res) => {
  const { email, role } = req.body;
  if (!email) return res.status(400).json({ message: 'Email requis.' });

  const table = role === 'fourriere' ? 'refuges' : 'familles_accueil';

  try {
    const { data: user } = await supabase
      .from(table)
      .select('id, email')
      .eq('email', email.toLowerCase().trim())
      .single();

    // Réponse identique même si l'email n'existe pas (sécurité — évite l'énumération)
    if (!user) {
      return res.json({ message: 'Si cet email existe, un lien vous a été envoyé.' });
    }

    // Générer token de reset (valable 1h)
    const resetToken = makeToken({ id: user.id, role, purpose: 'reset', exp: Math.floor(Date.now()/1000) + 3600 });

    // TODO: envoyer email via Brevo avec resetToken
    // await brevo.sendResetEmail(user.email, resetToken);

    console.log(`[reset-password] token pour ${user.email}: ${resetToken}`);

    return res.json({ message: 'Si cet email existe, un lien vous a été envoyé.' });

  } catch (err) {
    console.error('reset-password error:', err);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ─── POST /api/auth/logout ────────────────────────────────────────────────────
// Côté client : supprimer le token de sessionStorage
// Côté serveur : optionnel — liste noire si nécessaire (non implémenté)

router.post('/logout', (req, res) => {
  return res.json({ message: 'Déconnexion effectuée.' });
});

// ─── GET /api/auth/me ─────────────────────────────────────────────────────────
// Header : Authorization: Bearer <token>
// Retour : les infos publiques de l'utilisateur connecté

router.get('/me', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Token manquant.' });
  }
  const token = auth.slice(7);

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const table   = payload.role === 'refuge' ? 'refuges' : 'familles_accueil';
    const fields  = payload.role === 'refuge' ? REFUGE_PUBLIC_FIELDS : FA_PUBLIC_FIELDS;

    const { data: user, error } = await supabase
      .from(table)
      .select(fields.join(', '))
      .eq('id', payload.id)
      .single();

    if (error || !user) return res.status(404).json({ message: 'Utilisateur introuvable.' });

    const key = payload.role === 'refuge' ? 'refuge' : 'famille';
    return res.json({ [key]: user, role: payload.role });

  } catch (err) {
    return res.status(401).json({ message: 'Token invalide ou expiré.' });
  }
});

module.exports = router;
