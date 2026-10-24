// petia-backend/middleware/session.js
// Contrôle de session commun aux refuges et familles d'accueil, et outils
// de double authentification (Google Authenticator / TOTP) via Supabase Auth.
//
// Règle : la double authentification est FACULTATIVE. Mais un compte qui l'a
// activée ne peut plus utiliser une session ouverte avec le seul mot de passe :
// sinon, l'option ne protégerait rien.

const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Client jetable : une connexion ne doit jamais partager sa session avec une autre
function clientEphemere() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Niveau d'authentification du jeton (« aal1 » mot de passe, « aal2 » mot de passe + code).
// À n'utiliser qu'après supabase.auth.getUser(), qui vérifie le jeton.
function niveauAuth(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).aal || 'aal1';
  } catch {
    return 'aal1';
  }
}

const facteursActifs = (user) =>
  (user?.factors || []).filter(f => f.status === 'verified' && f.factor_type === 'totp');

// Appel à l'API Supabase Auth au nom de l'utilisateur (son propre jeton)
async function gotrue(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1${path}`, {
    method,
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.msg || data.message || data.error_description || `Auth ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Vérifie un code à 6 chiffres et renvoie la nouvelle session (niveau aal2)
async function verifierCode(token, factorId, code) {
  const challenge = await gotrue(`/factors/${factorId}/challenge`, { method: 'POST', token });
  return gotrue(`/factors/${factorId}/verify`, {
    method: 'POST', token, body: { challenge_id: challenge.id, code: String(code).replace(/\D/g, '') },
  });
}

// Middleware : session valide + code exigé si le compte a activé la double authentification
async function requireUser(req, res, next) {
  try {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer '))
      return res.status(401).json({ message: 'Token requis.' });
    const token = auth.split(' ')[1];

    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !user) return res.status(401).json({ message: 'Token invalide ou expiré.' });

    const aal = niveauAuth(token);
    if (facteursActifs(user).length && aal !== 'aal2')
      return res.status(401).json({ message: 'Code de vérification requis.', code: 'MFA_REQUIRED' });

    // Compte bloqué ou clôturé : plus aucun accès, même avec une session encore valide
    const { profilsDe, noterActivite } = require('../services/comptes');
    const profils = await profilsDe(user.id);
    if (profils.some(p => p.ligne.bloque_le))
      return res.status(403).json({ message: 'Ce compte est bloqué. Contactez PetIA pour le débloquer.', code: 'COMPTE_BLOQUE' });
    if (profils.length && profils.every(p => p.ligne.cloture_le))
      return res.status(403).json({ message: 'Ce compte est clôturé.', code: 'COMPTE_CLOTURE' });
    profils.forEach(p => noterActivite(p.table, p.ligne).catch(() => {}));

    req.user = user;
    req.token = token;
    req.aal = aal;
    req.profils = profils;
    next();
  } catch (e) {
    console.error('requireUser error:', e);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
}

module.exports = { requireUser, clientEphemere, niveauAuth, facteursActifs, gotrue, verifierCode, supabaseAdmin };
