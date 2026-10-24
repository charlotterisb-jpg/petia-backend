// petia-backend/services/comptes.js
// État des comptes (blocage, clôture, activité), sessions, mots de passe et
// suppression complète des données d'une personne (RGPD).

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const TABLES = [
  { table: 'familles_accueil', role: 'fa', colonnes: 'id, email, prenom, nom, telephone, statut_dossier, bloque_le, cloture_le, derniere_activite' },
  { table: 'refuges', role: 'refuge', colonnes: 'id, email, nom, contact_prenom, contact_nom, telephone, statut, bloque_le, cloture_le, derniere_activite' },
];

// Profil(s) rattaché(s) à un compte : une personne peut, en théorie, être FA et refuge
async function profilsDe(userId) {
  const res = [];
  for (const t of TABLES) {
    const { data } = await supabaseAdmin.from(t.table).select(t.colonnes).eq('id', userId).maybeSingle();
    if (data) res.push({ ...t, ligne: data });
  }
  return res;
}

async function estAdminId(userId) {
  const { data } = await supabaseAdmin.from('admins').select('user_id').eq('user_id', userId).maybeSingle();
  return !!data;
}

// ─── Activité ────────────────────────────────────────────────────────────────
// Mise à jour au plus toutes les 12 heures (sert au délai d'inactivité de 2 ans)
async function noterActivite(table, ligne) {
  if (ligne?.derniere_activite && Date.now() - new Date(ligne.derniere_activite).getTime() < 12 * 3600000) return;
  const maj = { derniere_activite: new Date().toISOString() };
  // Le compte redevient actif : l'avertissement de suppression ne vaut plus
  maj.avertissement_suppression_le = null;
  const { error } = await supabaseAdmin.from(table).update(maj).eq('id', ligne.id);
  if (error) console.error('noterActivite:', error.message);
}

// ─── Sessions ────────────────────────────────────────────────────────────────
// Ferme toutes les sessions d'un compte (tous appareils). Supabase ne permet de
// le faire qu'avec un jeton du compte : on en obtient un côté serveur, sans e-mail.
async function sessionServeur(email) {
  const { data, error } = await supabaseAdmin.auth.admin.generateLink({ type: 'magiclink', email });
  if (error || !data?.properties?.hashed_token) throw error || new Error('Lien de session indisponible');
  const { clientEphemere } = require('../middleware/session');
  const { data: v, error: e2 } = await clientEphemere().auth.verifyOtp({ token_hash: data.properties.hashed_token, type: 'magiclink' });
  if (e2 || !v?.session) throw e2 || new Error('Session indisponible');
  return v.session;
}

async function fermerSessions({ token, email }) {
  try {
    if (!token) token = (await sessionServeur(email)).access_token;
    const { error } = await supabaseAdmin.auth.admin.signOut(token, 'global');
    if (error) throw error;
    return true;
  } catch (e) {
    console.error('fermerSessions:', e.message);
    return false;
  }
}

// ─── Blocage ─────────────────────────────────────────────────────────────────
const BANNI = '876000h'; // ~100 ans : levé uniquement par l'admin

async function bloquerCompte(userId, email) {
  const maintenant = new Date().toISOString();
  for (const p of await profilsDe(userId))
    await supabaseAdmin.from(p.table).update({ bloque_le: maintenant }).eq('id', userId);
  await fermerSessions({ email });
  const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, { ban_duration: BANNI });
  if (error) console.error('ban:', error.message);
}

async function debloquerCompte(userId) {
  for (const p of await profilsDe(userId))
    await supabaseAdmin.from(p.table).update({ bloque_le: null }).eq('id', userId);
  const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, { ban_duration: 'none' });
  if (error) console.error('unban:', error.message);
}

// ─── Mots de passe ───────────────────────────────────────────────────────────
// 12 caractères minimum, et refus des mots de passe apparus dans des fuites
// connues (Have I Been Pwned, par k-anonymat : seuls les 5 premiers caractères
// de l'empreinte SHA-1 sont envoyés, jamais le mot de passe).
async function motDePasseCompromis(mdp) {
  const sha1 = crypto.createHash('sha1').update(mdp, 'utf8').digest('hex').toUpperCase();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`https://api.pwnedpasswords.com/range/${sha1.slice(0, 5)}`, {
      headers: { 'Add-Padding': 'true', 'User-Agent': 'PetIA' }, signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const suffixe = sha1.slice(5);
    return (await res.text()).split('\n').some(l => {
      const [s, n] = l.trim().split(':');
      return s === suffixe && Number(n) > 0;
    });
  } catch {
    return null; // service injoignable : on n'empêche pas le changement
  }
}

async function verifierNouveauMotDePasse(mdp, email) {
  if (typeof mdp !== 'string' || mdp.length < 12) return 'Le mot de passe doit contenir au moins 12 caractères.';
  if (mdp.length > 128) return 'Le mot de passe est trop long (128 caractères maximum).';
  if (email && mdp.toLowerCase().includes(String(email).split('@')[0].toLowerCase()) && String(email).split('@')[0].length >= 4)
    return 'Le mot de passe ne doit pas contenir votre adresse e-mail.';
  if (await motDePasseCompromis(mdp))
    return 'Ce mot de passe figure dans des fuites de données connues : choisissez-en un autre.';
  return null;
}

// ─── Suppression complète d'une personne ─────────────────────────────────────
// Supprime le compte, le dossier (FA ou refuge), les matchs, animaux et
// évaluations liés, et anonymise ses lignes du journal des accès.
// Un compte administrateur conserve son accès admin : seul le profil FA/refuge est supprimé.
async function supprimerPersonne(userId, emailConnu) {
  const bilan = { profils: [], journal_anonymise: 0, compte_auth: false };
  let email = emailConnu || null;
  const { data: u } = await supabaseAdmin.auth.admin.getUserById(userId);
  if (u?.user?.email) email = u.user.email;

  for (const p of await profilsDe(userId)) {
    email = email || p.ligne.email;
    if (p.table === 'familles_accueil') {
      await supabaseAdmin.from('evaluations').delete().eq('famille_id', userId);
    } else {
      await supabaseAdmin.from('evaluations').delete().eq('refuge_id_eval', userId);
      const { data: animaux } = await supabaseAdmin.from('animaux').select('id').eq('refuge_id', userId);
      const ids = (animaux || []).map(a => a.id);
      if (ids.length) {
        const { data: m } = await supabaseAdmin.from('matchs').select('id').in('animal_id', ids);
        if (m?.length) await supabaseAdmin.from('evaluations').delete().in('match_id', m.map(x => x.id));
      }
    }
    const { error } = await supabaseAdmin.from(p.table).delete().eq('id', userId); // cascade : matchs / animaux
    if (error) throw new Error(`Suppression ${p.table} : ${error.message}`);
    bilan.profils.push(p.table);
  }

  const { data: n, error: eJ } = await supabaseAdmin.rpc('anonymiser_journal', { p_user: userId, p_email: email });
  if (eJ) console.error('anonymiser_journal:', eJ.message);
  bilan.journal_anonymise = n || 0;

  if (u?.user && !(await estAdminId(userId))) {
    const { error } = await supabaseAdmin.auth.admin.deleteUser(userId); // cascade : jetons
    if (error) throw new Error(`Suppression du compte : ${error.message}`);
    bilan.compte_auth = true;
  }
  return bilan;
}

module.exports = {
  supabaseAdmin, TABLES, profilsDe, estAdminId, noterActivite, sessionServeur, fermerSessions,
  bloquerCompte, debloquerCompte, motDePasseCompromis, verifierNouveauMotDePasse, supprimerPersonne,
};
