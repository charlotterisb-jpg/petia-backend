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
const VERSION_MODELE = 'provisoire-2026-10-29g';

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

  const resiliationEmail = sansEmoji(cond.resiliation_email || cond.rgpd_email || r.email || "[adresse e-mail à compléter par l'Association]");
  const nbPreavis = Number.isInteger(cond.preavis_jours) ? cond.preavis_jours : 15;
  const preavisTxt = nbPreavis + ' jour' + (nbPreavis > 1 ? 's' : '');
  const tribunalTxt = cond.tribunal ? 'de ' + sansEmoji(cond.tribunal) : 'du ressort du siège de l\'Association' + (r.ville ? ' (' + r.ville + ')' : '');
  const DONNEES = [
        `11.1 Responsable du traitement. ${r.nom}${adresseRef ? ', ' + adresseRef : ''}, est responsable du traitement des données personnelles de la Famille d'Accueil collectées dans le cadre du présent contrat.`,
        "11.2 Finalité et base légale. Ces données sont traitées afin d'organiser et de suivre le placement de l'animal en famille d'accueil, à titre bénévole. Ce traitement est nécessaire à l'exécution du présent contrat (article 6.1.b du règlement (UE) 2016/679, dit RGPD).",
        `11.3 Destinataires. Les données sont destinées ${sansEmoji(cond.rgpd_destinataires || "aux seuls membres et bénévoles de l'Association habilités à gérer le placement des animaux et le suivi des familles d'accueil")}.`,
        `11.4 Transferts hors de l'Union européenne. ${sansEmoji(cond.rgpd_transfert || "Les données ne font l'objet d'aucun transfert en dehors de l'Union européenne, notamment vers les États-Unis.")}`,
        `11.5 Durée de conservation. ${sansEmoji(cond.rgpd_conservation || "Les données sont conservées pendant la durée de l'accueil, puis le temps nécessaire au respect des obligations légales de l'Association et à la défense de ses droits.")}`,
        `11.6 Droits de la Famille d'Accueil. Conformément au RGPD et à la loi n° 78-17 du 6 janvier 1978 dite « Informatique et Libertés », la Famille d'Accueil dispose d'un droit d'accès, de rectification, d'effacement, de limitation du traitement, d'opposition et de portabilité de ses données, ainsi que du droit de définir des directives relatives au sort de ses données après son décès. Pour exercer ces droits, elle écrit à : ${cond.rgpd_email || "[adresse e-mail à compléter par l'Association]"}${cond.rgpd_dpo ? ' (délégué à la protection des données : ' + sansEmoji(cond.rgpd_dpo) + ')' : ''}.`,
        "11.7 Réclamation. Si elle estime, après avoir contacté l'Association, que ses droits ne sont pas respectés, la Famille d'Accueil peut introduire une réclamation auprès de la Commission nationale de l'informatique et des libertés (CNIL) : en ligne sur www.cnil.fr/fr/plaintes, ou par courrier à CNIL, Service des plaintes, 3 place de Fontenoy, 75007 Paris.",
  ];
  return {
    titre: "Contrat de famille d'accueil",
    sous_titre: `Accueil de ${a.nom} · ${[a.race, ageTxt(a)].filter(Boolean).join(' · ')}`,
    avertissement: 'Modèle provisoire en cours de validation juridique.',
    articles: [
      { titre: 'Préambule et identification des parties', paragraphes: [
        'Entre les soussignés :',
        `La structure ${r.nom}${TYPES_LIB[r.type_structure] ? ' (' + TYPES_LIB[r.type_structure] + ')' : ''}${r.siret ? ', SIRET ' + r.siret : ''}, dont le siège est situé ${adresseRef || 'à l\'adresse déclarée sur PetIA'}${referent ? ', représentée par ' + referent : ''}, ci-après dénommée « l'Association »,`,
        `Et la famille d'accueil : ${nomFa}, demeurant ${adresseFa}, ci-après dénommée « la Famille d'Accueil ».`,
        "La Famille d'Accueil intervient à titre bénévole.",
        'La mise en relation a été réalisée par la plateforme PetIA, qui n\'est pas partie au présent contrat.',
      ] },
      { titre: "Article 1 — Objet de l'accueil", paragraphes: [
        "Le présent contrat définit les conditions dans lesquelles l'Association confie à la Famille d'Accueil, à titre temporaire et bénévole, la garde de l'animal suivant :",
        `Nom : ${a.nom} · Espèce : ${a.espece}${a.sous_espece ? ' (' + a.sous_espece + ')' : ''}${a.race ? ' · Race : ' + a.race : ''} · Sexe : ${a.sexe || 'non précisé'}${a.sterilise ? ', stérilisé(e)' : ''} · Âge estimé : ${ageTxt(a)}${a.puce || c.puce ? ' · Identification : ' + (a.puce || c.puce) : ''}.`,
        `Particularités : ${particularites}.`,
      ] },
      { titre: "Article 2 — Remise de l'animal et durée", paragraphes: [
        `Remise : ${MODES[mod.mode] || 'modalités à convenir entre les parties'}${mod.date ? ', prévue le ' + dateFr(mod.date) : ''}${mod.lieu ? ', lieu : ' + sansEmoji(mod.lieu) : ''}.${mod.note ? ' Précisions : ' + sansEmoji(mod.note) + '.' : ''}`,
        `L'accueil débute à la remise de l'animal${c.duree_accueil ? ' pour une durée prévue de ' + sansEmoji(c.duree_accueil) : ''}, jusqu'à l'adoption de l'animal ou la fin anticipée du contrat dans les conditions de l'article 10. La durée peut être prolongée d'un commun accord.`,
      ] },
      { titre: "Article 3 — Obligations de la Famille d'Accueil", paragraphes: [
        "Fournir à l'animal une alimentation adaptée, de l'eau fraîche en permanence, les sorties et l'exercice nécessaires ; ne jamais utiliser de méthodes punitives.",
        "Veiller à la sécurité de l'animal et empêcher toute fugue ; respecter les consignes de l'Association propres à cet animal.",
        "Donner régulièrement des nouvelles de l'animal et répondre aux sollicitations de l'Association dans un délai raisonnable.",
"Il est interdit de céder ou de confier l'animal à un tiers, de l'abandonner ou de modifier son identification sans accord écrit préalable de l'Association.",
        "Déplacements et absences. La Famille d'Accueil informe l'Association de toute absence prolongée. Elle ne peut confier temporairement l'animal à un tiers (garde pendant les vacances, pension), ni l'emmener hors de France, sans l'accord préalable de l'Association.",
        "Reproduction. La Famille d'Accueil veille à ce que l'animal ne se reproduise pas pendant l'accueil et ne le fait participer à aucun concours, exposition ou activité commerciale.",
        "Suivi. La Famille d'Accueil accepte que l'Association prenne régulièrement des nouvelles de l'animal et effectue, à une date convenue ensemble, des visites de suivi à son domicile.",
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
        "Euthanasie. Toute décision d'euthanasie relève exclusivement de l'Association, sauf urgence vétérinaire vitale constatée par un vétérinaire lorsque l'Association ne peut être jointe.",
        "Décès, perte ou fugue. En cas de décès de l'animal, la Famille d'Accueil prévient l'Association immédiatement et ne dispose pas du corps sans son accord. En cas de perte ou de fugue, elle prévient l'Association sans délai pour permettre la déclaration au fichier national I-CAD et les recherches.",
        `Contact de l'Association : ${[referent, r.telephone, r.email].filter(Boolean).join(' · ') || 'coordonnées disponibles sur PetIA'}.`,
      ] },
      { titre: "Article 6 — Propriété, garde de l'animal et responsabilités", paragraphes: [
        "6.1 Propriété. L'Association conserve la pleine propriété de l'animal pendant toute la durée de l'accueil, y compris lorsqu'il n'est pas encore identifié au moment de la signature du présent contrat. La Famille d'Accueil n'en a que la garde, à titre temporaire et bénévole, et ne peut en revendiquer la propriété.",
        "6.2 Notion de garde. Le gardien d'un animal est la personne qui exerce sur lui, en fait, les pouvoirs d'usage, de direction et de contrôle. Le propriétaire est présumé gardien, mais la garde peut être transférée à un tiers. À compter de la remise de l'animal et jusqu'à sa restitution, la Famille d'Accueil, qui l'héberge, le nourrit, le promène et décide de son usage au quotidien, en a la garde.",
        "6.3 Responsabilité civile. Aux termes de l'article 1243 du Code civil, « le propriétaire d'un animal, ou celui qui s'en sert, pendant qu'il est à son usage, est responsable du dommage que l'animal a causé, soit que l'animal fût sous sa garde, soit qu'il fût égaré ou échappé ». Cette responsabilité s'applique sans faute : la victime n'a pas à prouver une faute du gardien, qui ne peut s'exonérer qu'en démontrant une cause étrangère (force majeure ou faute de la victime). En sa qualité de gardienne, la Famille d'Accueil répond donc des dommages causés aux tiers par l'animal pendant l'accueil, y compris lorsqu'il s'est échappé ou égaré.",
        "6.4 Responsabilité pénale. Constituent des manquements graves au présent contrat le fait, sans l'accord écrit préalable de l'Association, de refuser de rendre l'animal, de le céder ou de le confier à un tiers, de l'abandonner ou de modifier son identification au fichier national I-CAD. Ces faits peuvent justifier des poursuites devant les juridictions civiles comme pénales : ils sont notamment susceptibles de recevoir la qualification d'abus de confiance (article 314-1 du Code pénal) ou de vol (articles 311-1 et suivants du même code). L'Association les signale alors aux autorités compétentes (police, gendarmerie, DDPP, procureur de la République). Elle peut également reprendre l'animal sans délai, au besoin avec l'aide des autorités, et demander le remboursement de l'ensemble des frais exposés pour le récupérer, le soigner et le faire garder.",
        "6.5 Assurance. La Famille d'Accueil certifie être couverte par une assurance responsabilité civile incluant la garde d'animaux confiés, et s'engage à la maintenir pendant toute la durée de l'accueil. Elle déclare tout sinistre à son assureur et en informe l'Association sans délai.",
      ] },
      { titre: "Article 7 — Communication et droit à l'image", paragraphes: [
        "Toute publication concernant l'animal (informations, photographies, vidéos), sur les réseaux sociaux ou sur tout autre support accessible au public, est soumise à l'accord préalable de l'Association.",
      ] },
      { titre: 'Article 8 — Procuration', paragraphes: [
        "Pendant la durée du contrat, l'Association peut autoriser par écrit la Famille d'Accueil à signer en son nom certains documents vétérinaires, tels qu'un certificat de bonne santé. Cette autorisation prend fin de plein droit à la résiliation du contrat.",
      ] },
      { titre: "Article 9 — Fin de l'accueil et adoption", paragraphes: [
        "Si la Famille d'Accueil souhaite adopter l'animal, elle en informe l'Association, qui étudie sa demande en priorité. À défaut, elle remet l'animal à l'Association ou à la famille adoptante désignée par celle-ci, selon les modalités convenues.",
      ] },
      { titre: 'Article 10 — Résiliation', paragraphes: [
        "10.1 À l'initiative de l'Association. L'Association peut mettre fin au contrat avec effet immédiat lorsque la Famille d'Accueil ne respecte pas l'une de ses obligations, ou en cas de comportement nuisant au bien-être de l'animal, à l'image ou au fonctionnement de l'Association. La Famille d'Accueil rend alors sans délai l'animal et le matériel prêté. L'Association peut faire récupérer l'animal au domicile de la Famille d'Accueil par l'un de ses bénévoles ou par une personne légalement habilitée. La Famille d'Accueil reconnaît que l'animal reste la propriété de l'Association : un refus de le rendre l'expose à des poursuites judiciaires.",
        `10.2 À l'initiative de la Famille d'Accueil. La Famille d'Accueil qui souhaite arrêter l'accueil avant son terme en informe l'Association par e-mail à ${resiliationEmail}. Le contrat prend fin ${preavisTxt} après la réception de ce message. Jusqu'à cette date, la Famille d'Accueil continue de s'occuper de l'animal, ce qui laisse à l'Association le temps de lui trouver un autre foyer. Si elle ne respecte pas ce délai, les frais de pension ou de garde supportés par l'Association pour héberger l'animal jusqu'à son placement dans une nouvelle famille d'accueil sont mis à sa charge. Ces frais lui sont facturés par e-mail et sont payables sous trente (30) jours ; passé ce délai, des pénalités de retard sont dues.`,
      ] },
      { titre: 'Article 11 — Protection des données personnelles', paragraphes: DONNEES },
      { titre: 'Article 12 — Signature électronique', paragraphes: [
        "Les parties signent électroniquement sur PetIA (signature électronique simple au sens du règlement eIDAS n° 910/2014). Chaque signature est authentifiée par deux facteurs : le mot de passe du compte et un code à usage unique généré par l'application Google Authenticator du signataire. La date, l'heure, l'adresse IP et le navigateur de chaque signataire sont conservés avec l'empreinte numérique (SHA-256) du texte signé.",
      ] },
      { titre: 'Article 13 — Loi applicable et tribunaux compétents', paragraphes: [
        `Le présent contrat est soumis au droit français. Tout litige relatif à sa formation ou à son exécution relève de la compétence des tribunaux ${tribunalTxt}.`,
      ] },
      { titre: 'Article 14 — Entrée en vigueur et modifications', paragraphes: [
        "Le présent contrat prend effet à la date de sa signature par les deux parties. Toute modification fait l'objet d'un avenant écrit, accepté par les deux parties.",
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
