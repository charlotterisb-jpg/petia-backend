// petia-backend/services/contrat.js
// Contrat d'accueil famille d'accueil (FA) – refuge
//   • généré automatiquement quand la famille accepte une proposition
//   • texte figé au moment de la génération : empreinte SHA-256 conservée
//   • signature électronique simple (eIDAS) : lecture, cases à cocher, nom saisi,
//     mot de passe (+ code Google Authenticator si activé), date, IP et navigateur
//   • la famille signe d'abord, puis le refuge contresigne ; l'arrivée de l'animal
//     n'est possible qu'une fois les deux signatures faites
//
// MODÈLE PROVISOIRE : le texte doit être validé par la DPO / juriste avant mise en production.

const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const VERSION_MODELE = 'provisoire-2026-10-29c';

const CONFIRMATIONS_FA = [
  "J'ai lu et compris l'intégralité du contrat de famille d'accueil.",
  "Je confirme disposer d'une assurance responsabilité civile couvrant la garde d'animaux de compagnie.",
  "Je m'engage à respecter les consignes du refuge pour cet animal.",
];

const MODES = {
  famille_vient: "La Famille d'Accueil vient chercher l'animal",
  refuge_amene: "L'Association amène l'animal au domicile de la Famille d'Accueil",
  a_convenir: 'Modalités à convenir entre les parties',
};
const TYPES_LIB = { fourriere: 'fourrière', spa: 'SPA / refuge', association: 'association de protection animale', autre: null };
const dateFr = (d) => d ? new Date(d.length === 10 ? d + 'T12:00:00' : d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' }) : null;
const ageTxt = (a) => [a.age_annees ? a.age_annees + ' an' + (a.age_annees > 1 ? 's' : '') : null, a.age_mois ? a.age_mois + ' mois' : null].filter(Boolean).join(' ') || 'non précisé';
const sansEmoji = (t) => String(t || '').replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '').replace(/\s*\|\s*/g, ', ').replace(/\s{2,}/g, ' ').trim();

// ─── Texte du contrat (articles) ─────────────────────────────────────────────
function rediger({ refuge: r, famille: f, animal: a, match: m }) {
  const nomFa = [f.prenom, f.nom].filter(Boolean).join(' ');
  const adresseFa = [f.adresse, [f.code_postal, f.ville].filter(Boolean).join(' ')].filter(Boolean).join(', ') || 'adresse communiquée à l\'Association';
  const adresseRef = [r.adresse, [r.code_postal, r.ville].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const referent = [[r.contact_prenom, r.contact_nom].filter(Boolean).join(' '), r.contact_fonction].filter(Boolean).join(', ');
  const c = a.details?.commun || {};
  const mod = m.modalites || {};
  const cond = r.details?.conditions || {};
  const NOURRITURE = { refuge_fournit: "La nourriture est fournie par l'Association.", rembourse: "La nourriture est achetée par la Famille d'Accueil et remboursée par l'Association sur présentation des justificatifs.", famille: "La nourriture est à la charge de la Famille d'Accueil." };
  const VETO = { refuge_100: "Les frais vétérinaires sont intégralement pris en charge par l'Association.", refuge_sur_accord: "Les frais vétérinaires sont pris en charge par l'Association, après son accord préalable sauf urgence.", partage: "Les frais vétérinaires sont répartis entre les parties selon les modalités convenues avec l'Association." };
  const TRANSPORT = { refuge: "Les trajets liés à l'accueil (vétérinaire, visites) sont assurés ou remboursés par l'Association.", famille: "Les trajets liés à l'accueil sont à la charge de la Famille d'Accueil.", selon_cas: "La prise en charge des trajets est convenue au cas par cas avec l'Association." };
  const MATERIEL_TXT = { laisse: 'laisse et collier ou harnais', gamelles: 'gamelles', couchage: 'couchage', caisse: 'caisse de transport', jouets: 'jouets', litiere: 'litière et bac', cage: 'cage ou enclos' };
  const VETO_MODE = {
    liste_texte: "La Famille d'Accueil consulte en priorité un vétérinaire partenaire de l'Association, parmi la liste suivante : " + sansEmoji(cond.veto_liste || '').replace(/\s*\n\s*/g, ' ; ') + '.',
    liste_lien: "La Famille d'Accueil consulte en priorité un vétérinaire partenaire de l'Association, dont la liste est disponible à l'adresse suivante : " + (cond.veto_lien || 'communiquée par l\'Association') + '.',
    liste_remise: "La Famille d'Accueil consulte en priorité un vétérinaire partenaire de l'Association, dont la liste lui est remise avec l'animal.",
    au_choix: "La Famille d'Accueil peut consulter le vétérinaire de son choix, dans le respect des conditions de prise en charge prévues à l'article 4.",
  };
  const veto = VETO_MODE[cond.veto_mode] || (cond.veto_nom ? 'Vétérinaire partenaire de l\'Association : ' + [cond.veto_nom, cond.veto_adresse, cond.veto_telephone].filter(Boolean).map(sansEmoji).join(', ') + '.' : null);
  const particularites = [a.besoins_specifiques, a.description && 'Consignes : ' + a.description, c.problemes_sante?.length && 'Santé : ' + c.problemes_sante.join(', ')]
    .filter(Boolean).map(sansEmoji).join(' ; ') || 'aucune signalée';

  return {
    titre: "Contrat de famille d'accueil",
    sous_titre: `Accueil de ${a.nom} · ${[a.race, ageTxt(a)].filter(Boolean).join(' · ')}`,
    avertissement: 'Modèle provisoire en cours de validation juridique.',
    articles: [
      { titre: 'Préambule et identification des parties', paragraphes: [
        'Entre les soussignés :',
        `La structure ${r.nom}${TYPES_LIB[r.type_structure] ? ' (' + TYPES_LIB[r.type_structure] + ')' : ''}${r.siret ? ', SIRET ' + r.siret : ''}, dont le siège est situé ${adresseRef || 'à l\'adresse déclarée sur PetIA'}${referent ? ', représentée par ' + referent : ''}, ci-après dénommée « l'Association »,`,
        `Et la famille d'accueil : ${nomFa}, demeurant ${adresseFa}, ci-après dénommée « la Famille d'Accueil ».`,
        'La mise en relation a été réalisée par la plateforme PetIA, qui n\'est pas partie au présent contrat.',
      ] },
      { titre: "Article 1 — Objet de l'accueil", paragraphes: [
        "Le présent contrat définit les conditions dans lesquelles l'Association confie à la Famille d'Accueil, à titre temporaire, la garde de l'animal suivant :",
        `Nom : ${a.nom} · Espèce : ${a.espece}${a.sous_espece ? ' (' + a.sous_espece + ')' : ''}${a.race ? ' · Race : ' + a.race : ''} · Sexe : ${a.sexe || 'non précisé'}${a.sterilise ? ', stérilisé(e)' : ''} · Âge estimé : ${ageTxt(a)}${a.puce || c.puce ? ' · Identification : ' + (a.puce || c.puce) : ''}.`,
        `Particularités : ${particularites}.`,
        "L'animal reste la propriété exclusive de l'Association. La Famille d'Accueil ne peut ni le céder, ni le vendre, ni le donner à un tiers sans accord écrit préalable.",
      ] },
      { titre: "Article 2 — Remise de l'animal et durée", paragraphes: [
        `Remise : ${MODES[mod.mode] || 'modalités à convenir entre les parties'}${mod.date ? ', prévue le ' + dateFr(mod.date) : ''}${mod.lieu ? ', lieu : ' + sansEmoji(mod.lieu) : ''}.${mod.note ? ' Précisions : ' + sansEmoji(mod.note) + '.' : ''}`,
        `L'accueil débute à la remise de l'animal${c.duree_accueil ? ' pour une durée prévue de ' + sansEmoji(c.duree_accueil) : ''}, jusqu'à l'adoption de l'animal ou la fin anticipée du contrat. La durée peut être prolongée d'un commun accord.`,
        "La Famille d'Accueil respecte un préavis de 7 jours avant toute demande de fin d'accueil, sauf urgence.",
      ] },
      { titre: "Article 3 — Obligations de la Famille d'Accueil", paragraphes: [
        "Fournir à l'animal une alimentation adaptée, de l'eau fraîche en permanence, les sorties et l'exercice nécessaires ; ne jamais utiliser de méthodes punitives.",
        "Veiller à la sécurité de l'animal et empêcher toute fugue ; respecter les consignes de l'Association propres à cet animal.",
        "Donner régulièrement des nouvelles de l'animal et répondre aux sollicitations de l'Association dans un délai raisonnable.",
        "Il est interdit de céder ou de confier l'animal à un tiers sans accord écrit de l'Association.",
        ...(cond.regles ? ['Règles propres à l\'Association : ' + sansEmoji(cond.regles)] : []),
      ] },
      { titre: 'Article 4 — Prise en charge des frais', paragraphes: [
        VETO[cond.veterinaire] || "Les frais vétérinaires prescrits ou validés par l'Association sont à sa charge, selon les modalités qu'elle communique à la Famille d'Accueil.",
        NOURRITURE[cond.nourriture] || "Les modalités de prise en charge de l'alimentation sont précisées par l'Association avant la remise de l'animal.",
        cond.materiel?.length ? "L'Association fournit le matériel suivant, qui reste sa propriété : " + cond.materiel.map(x => MATERIEL_TXT[x]).join(', ') + '.' : "Le matériel nécessaire est précisé par l'Association avant la remise de l'animal.",
        ...(TRANSPORT[cond.transport] ? [TRANSPORT[cond.transport]] : []),
        cond.indemnite ? 'Indemnité : ' + sansEmoji(cond.indemnite) + '.' : "Aucune indemnité n'est due à la Famille d'Accueil, sauf accord écrit contraire.",
      ] },
      { titre: 'Article 5 — Santé et urgences', paragraphes: [
        "La Famille d'Accueil suit les prescriptions en cours. En cas d'urgence médicale, elle conduit immédiatement l'animal chez un vétérinaire et prévient l'Association dans les 2 heures.",
        ...(veto ? [veto] : []),
        ...(cond.urgence ? ['En cas d\'urgence, notamment la nuit et le week-end : ' + sansEmoji(cond.urgence) + '.'] : []),
        "Elle prévient également l'Association dans les 2 heures en cas de fugue, morsure, comportement agressif inhabituel ou impossibilité de poursuivre l'accueil.",
        `Contact de l'Association : ${[referent, r.telephone, r.email].filter(Boolean).join(' · ') || 'coordonnées disponibles sur PetIA'}.`,
      ] },
      { titre: 'Article 6 — Responsabilité civile', paragraphes: [
        "Conformément à l'article 1243 du Code civil, la Famille d'Accueil a la garde de l'animal dès sa prise en charge et répond des dommages qu'il cause aux tiers. Elle certifie être couverte par une assurance responsabilité civile incluant la garde d'animaux.",
      ] },
      { titre: "Article 7 — Fin de l'accueil et restitution", paragraphes: [
        "Si la Famille d'Accueil souhaite adopter l'animal, elle en informe l'Association, qui étudie sa demande en priorité. À défaut, elle remet l'animal à l'Association ou à la famille adoptante désignée par celle-ci, selon les modalités convenues.",
        "L'Association peut reprendre l'animal immédiatement en cas de non-respect des obligations, de maltraitance ou de mise en danger de son bien-être.",
      ] },
      { titre: 'Article 8 — Données personnelles', paragraphes: [
        "Les données de la Famille d'Accueil sont traitées par l'Association pour la gestion de l'accueil, et par PetIA pour la mise en relation et la conservation du présent contrat, conformément au RGPD. Droits d'accès, de rectification et d'effacement : contact@petia.fr.",
      ] },
      { titre: 'Article 9 — Signature électronique', paragraphes: [
        "Les parties signent électroniquement sur PetIA (signature électronique simple au sens du règlement eIDAS n° 910/2014). Chaque signature est authentifiée par deux facteurs : le mot de passe du compte et un code à usage unique généré par l'application Google Authenticator du signataire. La date, l'heure, l'adresse IP et le navigateur de chaque signataire sont conservés avec l'empreinte numérique (SHA-256) du texte signé.",
      ] },
    ],
    confirmations_fa: CONFIRMATIONS_FA,
  };
}

const empreinte = (contenu) => crypto.createHash('sha256').update(contenu, 'utf8').digest('hex');

// ─── Lecture / création ──────────────────────────────────────────────────────
async function donneesMatch(matchId) {
  const { data: m } = await supabase.from('matchs')
    .select('id, statut, reponse_fa, modalites, famille_id, animal:animaux(*, refuge:refuges(id, nom, type_structure, siret, adresse, code_postal, ville, telephone, email, contact_prenom, contact_nom, contact_fonction, details))')
    .eq('id', matchId).maybeSingle();
  if (!m) return null;
  const { data: f } = await supabase.from('familles_accueil').select('id, prenom, nom, adresse, code_postal, ville, email, telephone').eq('id', m.famille_id).maybeSingle();
  return { match: m, animal: m.animal, refuge: m.animal?.refuge, famille: f };
}

async function obtenirContrat(matchId, { creer = true } = {}) {
  const { data: existant } = await supabase.from('contrats').select('*').eq('match_id', matchId).maybeSingle();
  if (existant || !creer) return existant || null;
  const d = await donneesMatch(matchId);
  if (!d || d.match.reponse_fa !== 'oui' || !['accepte', 'en_cours'].includes(d.match.statut)) return null;
  const contenu = JSON.stringify(rediger(d));
  const { data, error } = await supabase.from('contrats')
    .insert({ match_id: matchId, version_modele: VERSION_MODELE, contenu, empreinte: empreinte(contenu) }).select('*').single();
  if (error) {
    if (error.code === '23505') return (await supabase.from('contrats').select('*').eq('match_id', matchId).single()).data;
    throw error;
  }
  return data;
}

// Version renvoyée au navigateur (sans les IP des signataires)
function pourAffichage(c) {
  if (!c) return null;
  return {
    id: c.id, statut: c.statut, version_modele: c.version_modele, empreinte: c.empreinte, cree_le: c.cree_le,
    contenu: JSON.parse(c.contenu),
    fa_signe_le: c.fa_signe_le, fa_nom_signe: c.fa_nom_signe, refuge_signe_le: c.refuge_signe_le, refuge_nom_signe: c.refuge_nom_signe,
  };
}

// Le texte n'a pas été modifié depuis sa génération
const integre = (c) => empreinte(c.contenu) === c.empreinte;

// ─── PDF ─────────────────────────────────────────────────────────────────────
function pdf(c, res) {
  const t = JSON.parse(c.contenu);
  const doc = new PDFDocument({ size: 'A4', margin: 56, info: { Title: t.titre, Author: 'PetIA' } });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="contrat-accueil-${c.id.slice(0, 8)}.pdf"`);
  doc.pipe(res);
  doc.font('Helvetica-Bold').fontSize(18).text(t.titre, { align: 'center' });
  doc.font('Helvetica').fontSize(11).fillColor('#444').text(t.sous_titre, { align: 'center' });
  if (t.avertissement) doc.moveDown(0.3).fontSize(9).fillColor('#B45309').text(t.avertissement, { align: 'center' });
  doc.fillColor('#000').moveDown();
  for (const a of t.articles) {
    doc.font('Helvetica-Bold').fontSize(11).text(a.titre).moveDown(0.2);
    doc.font('Helvetica').fontSize(10);
    for (const p of a.paragraphes) doc.text(p, { align: 'justify' }).moveDown(0.3);
    doc.moveDown(0.4);
  }
  doc.moveDown().font('Helvetica-Bold').fontSize(11).text('Signatures électroniques').moveDown(0.3).font('Helvetica').fontSize(10);
  const ligne = (qui, nom, date, ip) => doc.text(nom
    ? `${qui} : ${nom}, le ${new Date(date).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })} (adresse IP ${ip || 'non disponible'})`
    : `${qui} : en attente de signature`);
  ligne("Famille d'Accueil", c.fa_nom_signe, c.fa_signe_le, c.fa_ip);
  ligne('Association', c.refuge_nom_signe, c.refuge_signe_le, c.refuge_ip);
  if (c.fa_nom_signe) doc.moveDown(0.3).fontSize(9).fillColor('#444').text("Déclarations de la Famille d'Accueil : " + (t.confirmations_fa || []).join(' '));
  doc.moveDown().fontSize(8).fillColor('#666')
    .text(`Empreinte SHA-256 du texte signé : ${c.empreinte}`)
    .text(`Référence : ${c.id} · Modèle ${c.version_modele} · Généré par PetIA le ${new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}`);
  doc.end();
}

module.exports = { obtenirContrat, pourAffichage, integre, pdf, CONFIRMATIONS_FA, supabase };

// ─── Signature : authentification du signataire ──────────────────────────────
// Mot de passe du compte + code Google Authenticator si la double authentification est activée.
async function authentifierSignataire(user, motDePasse, code) {
  const { clientEphemere, facteursActifs, verifierCode } = require('../middleware/session');
  if (!motDePasse) return 'Saisissez votre mot de passe pour signer.';
  const { data, error } = await clientEphemere().auth.signInWithPassword({ email: user.email, password: motDePasse });
  if (error || !data?.session) return 'Mot de passe incorrect.';
  // Double authentification OBLIGATOIRE pour signer : un mot de passe volé ne suffit pas
  const facteur = facteursActifs(user)[0];
  if (!facteur) return 'Pour signer, activez d\'abord la double authentification (Google Authenticator) dans l\'onglet Sécurité.';
  if (!code) return 'Saisissez le code Google Authenticator.';
  try { await verifierCode(data.session.access_token, facteur.id, code); }
  catch { return 'Code Google Authenticator incorrect ou expiré.'; }
  await supabase.auth.admin.signOut(data.session.access_token, 'local').catch(() => {});
  return null;
}

const normaliserNom = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');

module.exports.authentifierSignataire = authentifierSignataire;
module.exports.normaliserNom = normaliserNom;
module.exports.rediger = rediger;
