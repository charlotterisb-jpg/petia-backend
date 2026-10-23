// petia-backend/middleware/admin.js
// Accès administrateur : jeton Supabase valide ET présence dans la table public.admins.
// La table admins est protégée par RLS : seule la clé serveur peut la lire.

const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function estAdmin(userId) {
  const { data } = await supabaseAdmin.from('admins').select('user_id').eq('user_id', userId).maybeSingle();
  return !!data;
}

async function requireAdmin(req, res, next) {
  try {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer '))
      return res.status(401).json({ message: 'Token requis.' });

    const { data: { user }, error } = await supabaseAdmin.auth.getUser(auth.split(' ')[1]);
    if (error || !user)
      return res.status(401).json({ message: 'Session expirée, reconnectez-vous.' });

    if (!(await estAdmin(user.id)))
      return res.status(403).json({ message: 'Accès réservé aux administrateurs.' });

    req.user = user;
    next();
  } catch (e) {
    console.error('requireAdmin error:', e);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
}

module.exports = { requireAdmin, estAdmin };
