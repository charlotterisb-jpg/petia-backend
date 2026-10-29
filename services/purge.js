// petia-backend/services/purge.js
// Suppression automatique des données (durées de conservation PetIA) :
//   • compte clôturé            → supprimé 2 ans après la clôture
//   • compte inactif            → avertissement par e-mail à 23 mois d'inactivité,
//                                 suppression à 2 ans (et au moins 30 jours après l'avertissement)
//   • dossier refusé            → supprimé 6 mois après le refus
//   • contrat signé             → conservé 5 ans après la fin de l'accueil, même si le compte
//                                 est supprimé (archivage automatique en base), puis supprimé
//   • journal des accès         → lignes de plus d'un an supprimées
//   • jetons expirés            → supprimés
// Exécution au plus une fois par 20 heures (vérifiée dans le journal), lancée
// par le serveur à son démarrage puis toutes les 6 heures, ou depuis l'admin.

const { supabaseAdmin, supprimerPersonne } = require('./comptes');
const { journaliser, envoyerMail } = require('./journal');

const JOUR = 86400000;
const ilYa = (jours) => new Date(Date.now() - jours * JOUR).toISOString();
const MOIS = 30.44;

async function supprimer(ids, raison, bilan) {
  for (const { id, email } of ids) {
    try {
      await supprimerPersonne(id, email);
      await journaliser(null, { evenement: 'suppression_automatique', cible_type: 'compte', cible_id: id, details: { raison } });
      bilan[raison] = (bilan[raison] || 0) + 1;
    } catch (e) {
      console.error('Purge', raison, id, e.message);
      bilan.erreurs = (bilan.erreurs || 0) + 1;
    }
  }
}

async function lancerPurge({ forcer = false, req = null } = {}) {
  if (!forcer) {
    const { count } = await supabaseAdmin.from('journal_acces').select('id', { count: 'exact', head: true })
      .eq('evenement', 'purge_executee').gte('cree_le', new Date(Date.now() - 20 * 3600000).toISOString());
    if (count) return { deja_faite: true };
  }
  const bilan = {};

  for (const table of ['familles_accueil', 'refuges']) {
    // 1. Comptes clôturés depuis plus de 2 ans
    const { data: clos } = await supabaseAdmin.from(table).select('id, email').lt('cloture_le', ilYa(730));
    await supprimer(clos || [], 'cloture_2_ans', bilan);

    // 2. Inactivité : suppression (2 ans, avertissement envoyé depuis au moins 30 jours)
    const { data: inactifs } = await supabaseAdmin.from(table).select('id, email')
      .is('cloture_le', null).lt('derniere_activite', ilYa(730)).lt('avertissement_suppression_le', ilYa(30));
    await supprimer(inactifs || [], 'inactivite_2_ans', bilan);

    // 3. Inactivité : avertissement à 23 mois
    const { data: aPrevenir } = await supabaseAdmin.from(table).select('id, email, derniere_activite')
      .is('cloture_le', null).is('avertissement_suppression_le', null).lt('derniere_activite', ilYa(23 * MOIS));
    for (const p of aPrevenir || []) {
      const date = new Date(Math.max(new Date(p.derniere_activite).getTime() + 730 * JOUR, Date.now() + 30 * JOUR))
        .toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' });
      const envoye = await envoyerMail({
        to: p.email, subject: 'Votre compte PetIA sera bientôt supprimé', badge: '⏳', couleur: '#F59E0B',
        label: 'Compte inactif', title: 'Votre compte PetIA<br>est inactif depuis presque 2 ans',
        body: `Sans connexion de votre part, votre compte et vos données seront supprimés définitivement le <strong style="color:#fff;">${date}</strong>.`
          + '<br><br>Pour conserver votre compte, il suffit de vous connecter.',
        ctaText: 'Me connecter →',
      });
      await supabaseAdmin.from(table).update({ avertissement_suppression_le: new Date().toISOString() }).eq('id', p.id);
      await journaliser(null, { evenement: 'avertissement_inactivite', cible_type: 'compte', cible_id: p.id, details: { email_envoye: envoye } });
      bilan.avertissements = (bilan.avertissements || 0) + 1;
    }
  }

  // 4. Dossiers refusés depuis plus de 6 mois
  const { data: faRefusees } = await supabaseAdmin.from('familles_accueil').select('id, email')
    .eq('statut_dossier', 'refuse').lt('decision_date', ilYa(6 * MOIS));
  await supprimer(faRefusees || [], 'refus_6_mois', bilan);
  const { data: refRefuses } = await supabaseAdmin.from('refuges').select('id, email')
    .eq('statut', 'refuse').lt('decision_date', ilYa(6 * MOIS));
  await supprimer(refRefuses || [], 'refus_6_mois', bilan);

  // 5. Documents des familles : 3 mois après la fin de l'accueil, 6 mois après le dépôt si jamais utilisés
  bilan.documents_supprimes = await require('./documents').purgerDocuments().catch(e => { console.error('Purge documents:', e.message); return 0; });

  // 6. Contrats signés : 5 ans après la fin de l'accueil (art. 2224 du Code civil)
  const { count: nC, error: eC } = await supabaseAdmin.from('contrats').delete({ count: 'exact' }).lt('conserver_jusqu_au', new Date().toISOString());
  if (eC) console.error('Purge contrats:', eC.message);
  bilan.contrats_supprimes = nC || 0;

  // 7. Journal de plus d'un an, jetons expirés
  const { count: nJ } = await supabaseAdmin.from('journal_acces').delete({ count: 'exact' }).lt('cree_le', ilYa(365));
  bilan.journal_supprime = nJ || 0;
  await supabaseAdmin.from('reinitialisations_mdp').delete().lt('expire_le', ilYa(1));
  await supabaseAdmin.from('jetons_blocage').delete().lt('expire_le', ilYa(1));

  await journaliser(req, { evenement: 'purge_executee', details: bilan });
  return bilan;
}

function planifierPurge() {
  const tourner = () => lancerPurge().then(b => { if (!b.deja_faite) console.log('Purge RGPD :', JSON.stringify(b)); })
    .catch(e => console.error('Purge RGPD échouée :', e.message));
  setTimeout(tourner, 2 * 60000);
  setInterval(tourner, 6 * 3600000);
}

module.exports = { lancerPurge, planifierPurge };
