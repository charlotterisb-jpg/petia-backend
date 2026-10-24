// petia-backend/services/journal.js
// Journal des accès (table public.journal_acces, en ajout seul) et alertes de sécurité.
//
// Le journal ne doit jamais bloquer une action : une erreur d'écriture est
// signalée dans les logs du serveur, sans empêcher la requête d'aboutir.
// Il ne contient jamais de mot de passe, de jeton ni de contenu de dossier :
// seulement qui, quoi, quand, d'où (IP, navigateur) et sur quelle cible.

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const SITE = process.env.SITE_URL || 'https://petia-frontend.vercel.app';

// ─── Écriture ────────────────────────────────────────────────────────────────
const ip = (req) => (req?.ip || '').slice(0, 64) || null;
const appareil = (req) => String(req?.headers?.['user-agent'] || '').slice(0, 300) || null;

async function journaliser(req, { evenement, user, userId, email, role, cible_type, cible_id, details } = {}) {
  try {
    const ligne = {
      evenement: String(evenement).slice(0, 60),
      user_id: userId || user?.id || null,
      email: (email || user?.email || '').toLowerCase().slice(0, 200) || null,
      role: role || null,
      cible_type: cible_type || null,
      cible_id: cible_id ? String(cible_id).slice(0, 100) : null,
      ip: ip(req),
      appareil: appareil(req),
      details: details || null,
    };
    const { error } = await supabaseAdmin.from('journal_acces').insert(ligne);
    if (error) console.error('journal_acces insert:', error.message);
  } catch (e) {
    console.error('journaliser error:', e.message);
  }
}

// Nombre d'événements récents (pour les verrouillages et seuils d'alerte)
async function compter({ evenement, email, userId, ipReq, cible_id, minutes }) {
  let q = supabaseAdmin.from('journal_acces').select('id', { count: 'exact', head: true })
    .gte('cree_le', new Date(Date.now() - minutes * 60000).toISOString());
  q = Array.isArray(evenement) ? q.in('evenement', evenement) : q.eq('evenement', evenement);
  if (email) q = q.eq('email', String(email).toLowerCase());
  if (userId) q = q.eq('user_id', userId);
  if (ipReq) q = q.eq('ip', ipReq);
  if (cible_id) q = q.eq('cible_id', String(cible_id));
  const { count, error } = await q;
  if (error) { console.error('journal compter:', error.message); return 0; }
  return count || 0;
}

// ─── Verrouillage après échecs répétés ───────────────────────────────────────
const SEUIL_ECHECS = 5, FENETRE_ECHECS = 15; // 5 échecs en 15 minutes

async function compteVerrouille(email) {
  if (!email) return false;
  return (await compter({ evenement: ['connexion_echec', 'mfa_echec'], email, minutes: FENETRE_ECHECS })) >= SEUIL_ECHECS;
}

// ─── E-mails d'alerte ────────────────────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function envoyerMail({ to, subject, badge = '🔐', couleur = '#7C3AED', label = 'Sécurité du compte', title, body, ctaText, ctaHref, footer }) {
  const { buildEmail, sendBrevoEmail } = require('../routes/auth').mail;
  try {
    await sendBrevoEmail({ to, subject, htmlContent: buildEmail({
      badge, badgeColor: couleur, label, labelColor: couleur, title, body,
      ctaText: ctaText || 'Accéder à PetIA →', ctaHref: ctaHref || SITE,
      ctaColor: couleur, ctaShadow: 'rgba(0,0,0,.3)', footer: footer || "L'équipe PetIA 🐾",
    }) });
    return true;
  } catch (e) {
    console.error('Alerte e-mail non envoyée:', e.message);
    return false;
  }
}

// Adresses des administrateurs (destinataires des alertes)
async function emailsAdmins() {
  if (process.env.ALERTE_EMAIL) return process.env.ALERTE_EMAIL.split(',').map(s => s.trim()).filter(Boolean);
  const { data } = await supabaseAdmin.from('admins').select('user_id');
  const emails = [];
  for (const a of data || []) {
    const { data: u } = await supabaseAdmin.auth.admin.getUserById(a.user_id);
    if (u?.user?.email) emails.push(u.user.email);
  }
  return emails;
}

async function alerterAdmins(req, { sujet, message, evenement = 'alerte_admin', details }) {
  await journaliser(req, { evenement, details: { sujet, ...(details || {}) } });
  for (const to of await emailsAdmins()) {
    await envoyerMail({ to, subject: '⚠ PetIA — ' + sujet, badge: '⚠', couleur: '#EF4444', label: 'Alerte de sécurité',
      title: esc(sujet), body: message, ctaText: 'Ouvrir l\'espace admin →', ctaHref: process.env.ADMIN_URL || 'https://petia-admin.vercel.app' });
  }
}

// ─── Lien « Ce n'était pas moi » (blocage du compte, valable 7 jours) ────────
const hacher = (jeton) => crypto.createHash('sha256').update(String(jeton)).digest('hex');

async function creerLienBlocage(userId) {
  const jeton = crypto.randomBytes(32).toString('base64url');
  const { error } = await supabaseAdmin.from('jetons_blocage').insert({
    user_id: userId, jeton_hash: hacher(jeton), expire_le: new Date(Date.now() + 7 * 86400000).toISOString(),
  });
  if (error) { console.error('jetons_blocage insert:', error.message); return null; }
  return `${SITE}/#blocage=${jeton}`;
}

// ─── Nouvel appareil / nouvelle adresse IP ───────────────────────────────────
// Signature grossière (système + navigateur) : un simple changement de version
// du navigateur ne déclenche pas d'alerte.
function signatureAppareil(ua) {
  ua = String(ua || '');
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'autre';
  const nav = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'autre';
  return `${nav} sur ${os}`;
}

async function verifierNouvelAppareil(req, user) {
  try {
    const { data } = await supabaseAdmin.from('journal_acces').select('ip, appareil')
      .eq('user_id', user.id).eq('evenement', 'connexion_reussie')
      .gte('cree_le', new Date(Date.now() - 180 * 86400000).toISOString())
      .order('cree_le', { ascending: false }).limit(100);
    const precedentes = (data || []).slice(1); // la connexion en cours vient d'être journalisée
    if (!precedentes.length) return; // première connexion : rien à comparer
    const sig = signatureAppareil(appareil(req));
    const connu = precedentes.some(p => p.ip === ip(req) || signatureAppareil(p.appareil) === sig);
    if (connu) return;
    const lien = await creerLienBlocage(user.id);
    await journaliser(req, { evenement: 'alerte_nouvel_appareil', user });
    await envoyerMail({
      to: user.email, subject: '🔐 Nouvelle connexion à votre compte PetIA',
      title: 'Nouvelle connexion<br>à votre compte',
      body: `Une connexion à votre compte vient d'avoir lieu depuis un appareil ou une adresse inhabituels : <strong style="color:#fff;">${esc(sig)}</strong>, le ${new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}.<br><br>Si c'est vous, il n'y a rien à faire. Sinon, bloquez votre compte immédiatement.`,
      ctaText: 'Ce n\'était pas moi : bloquer mon compte', ctaHref: lien || SITE, couleur: '#EF4444',
      footer: 'Ce lien est valable 7 jours. Après blocage, contactez PetIA pour retrouver l\'accès à votre compte.',
    });
  } catch (e) {
    console.error('verifierNouvelAppareil:', e.message);
  }
}

// ─── Consultation anormale de profils ────────────────────────────────────────
// Un refuge consulte normalement les familles proposées pour quelques animaux ;
// au-delà du seuil en une heure, l'admin est prévenu (une alerte par heure au plus).
const SEUILS_CONSULTATION = { consultation_matchs: 60, consultation_dossier_fa: 80 };

async function surveillerConsultations(req, evenement, user) {
  try {
    const seuil = SEUILS_CONSULTATION[evenement];
    if (!seuil) return;
    const n = await compter({ evenement, userId: user.id, minutes: 60 });
    if (n !== seuil) return; // une seule alerte, au franchissement du seuil
    await alerterAdmins(req, {
      evenement: 'alerte_consultation',
      sujet: 'Consultation inhabituelle de profils',
      message: `Le compte <strong style="color:#fff;">${esc(user.email)}</strong> a effectué ${n} consultations (${esc(evenement)}) en moins d'une heure. Vérifiez le journal des accès et, si besoin, bloquez le compte depuis l'espace admin.`,
      details: { compte: user.id, evenement_surveille: evenement, nombre: n },
    });
  } catch (e) {
    console.error('surveillerConsultations:', e.message);
  }
}

module.exports = {
  journaliser, compter, compteVerrouille, envoyerMail, alerterAdmins, emailsAdmins, creerLienBlocage,
  verifierNouvelAppareil, signatureAppareil, surveillerConsultations, hacher, esc, ip, SITE,
};
