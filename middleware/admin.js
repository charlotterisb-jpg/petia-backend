// petia-backend/middleware/admin.js
// Accès administrateur :
//   1. jeton Supabase valide (vérifié par Supabase Auth),
//   2. compte présent dans public.admins (table protégée par RLS),
//   3. double authentification validée : niveau « aal2 » (code Google Authenticator).

const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function estAdmin(userId) {
  const { data } = await supabaseAdmin.from('admins').select('user_id').eq('user_id', userId).maybeSingle();
  return !!data;
}

// Lit le niveau d'authentification dans le jeton. N'est appelé qu'APRÈS
// supabase.auth.getUser(), qui a vérifié la signature et la validité du jeton.
function niveauAuth(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return payload.aal || 'aal1';
  } catch {
    return 'aal1';
  }
}

function fabriquer({ exigerMFA }) {
  return async function (req, res, next) {
    try {
      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith('Bearer '))
        return res.status(401).json({ message: 'Token requis.' });
      const token = auth.split(' ')[1];

      const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
      if (error || !user)
        return res.status(401).json({ message: 'Session expirée, reconnectez-vous.' });

      if (!(await estAdmin(user.id)))
        return res.status(403).json({ message: 'Accès réservé aux administrateurs.' });

      req.user = user;
      req.aal = niveauAuth(token);
      if (exigerMFA && req.aal !== 'aal2')
        return res.status(403).json({ message: 'Double authentification requise.', code: 'MFA_REQUIRED' });

      next();
    } catch (e) {
      console.error('requireAdmin error:', e);
      return res.status(500).json({ message: 'Erreur serveur.' });
    }
  };
}

// Toutes les routes admin
const requireAdmin = fabriquer({ exigerMFA: true });
// Uniquement pour vérifier qu'un compte est admin AVANT qu'il configure son code
const requireAdminSansMFA = fabriquer({ exigerMFA: false });

module.exports = { requireAdmin, requireAdminSansMFA, estAdmin };
