# PetIA — Mesures de sécurité et éléments RGPD

Document de travail tenu à jour au fil du développement. Il sert de base au
registre des traitements (art. 30 RGPD) et à la description des mesures de
sécurité (art. 32). Dernière mise à jour : 24 octobre 2026.

Légende : ✅ en place · 🟡 décidé, en cours de construction · ⬜ à décider / à faire

---

## 1. Architecture et hébergement

| Composant | Rôle | Hébergeur | Localisation |
|---|---|---|---|
| Site public (`petia-frontend.vercel.app`) | Pages refuges et familles d'accueil (FA) | Vercel | Pages statiques, CDN mondial |
| Site admin (`petia-admin.vercel.app`) | Back-office PetIA (validation des dossiers) | Vercel | Projet séparé du site public |
| Serveur API (`petia-backend.onrender.com`) | Logique métier, contrôles d'accès | Render | Francfort (UE) |
| Base de données + authentification | Données et comptes | Supabase | Francfort (UE, eu-central-1) |
| IA de matching | Score de compatibilité animal / FA | Anthropic (Claude Haiku) | États-Unis |
| E-mails transactionnels | Notifications | Brevo | UE |

- ✅ Le navigateur ne parle jamais directement à la base : tout passe par le serveur.
- ✅ Le site admin est un projet distinct ; l'adresse `/admin` du site public redirige vers l'accueil.

## 2. Données traitées (inventaire)

| Table | Personnes concernées | Données |
|---|---|---|
| `auth.users` (Supabase) | FA, refuges, admins | e-mail, empreinte du mot de passe (jamais en clair), facteurs MFA |
| `familles_accueil` | FA | identité (prénom, nom), e-mail, téléphone, adresse/ville, logement, composition du foyer (enfants : tranches d'âge), animaux au foyer, rythme de vie, expérience, réponses libres au questionnaire (motivation, mises en situation), espèces acceptées, refus, engagement, statut du dossier, notes internes admin |
| `refuges` | Contacts des refuges | nom de la structure, SIRET, adresse, contact référent (prénom, nom, fonction), e-mail, téléphone, statut |
| `animaux` | — (animaux) | fiche animal ; numéro de puce |
| `matchs` | FA (indirect) | score, recommandation, réponse de la FA, dates d'accueil |
| `admins` | Admins | identifiant de compte |
| `journal_acces` | Tous (y compris personnes sans compte : e-mail saisi lors d'une tentative de connexion) | événement, date, compte, e-mail, rôle, cible consultée, IP, navigateur |
| `reinitialisations_mdp` | FA, refuges | empreinte du jeton de réinitialisation (jamais le jeton), expiration, IP de la demande |
| `jetons_blocage` | FA, refuges | empreinte du jeton « Ce n'était pas moi », expiration |

- ✅ Aucune donnée de santé humaine, aucune donnée bancaire collectée.
- ⬜ Les réponses libres du questionnaire peuvent contenir des informations sensibles saisies spontanément : à mentionner dans l'information des personnes.

## 3. Contrôle des accès

- ✅ RLS (Row Level Security) activé sur toutes les tables : la clé publique ne donne accès à aucune donnée ; seul le serveur (clé de service, conservée dans Render) lit et écrit.
- ✅ Chaque utilisateur n'accède qu'à ses propres données (refuge → ses animaux et matchs ; FA → son dossier et ses propositions).
- ✅ Une FA ne voit une proposition qu'après validation par le refuge ; les coordonnées du refuge ne lui sont transmises qu'après acceptation ; le numéro de puce ne lui est jamais transmis.
- ✅ Un refuge ne voit des FA proposées que prénom, ville, code postal et critères (logement, expérience, disponibilité, note) ; jamais nom de famille, e-mail, téléphone ni adresse.
- ✅ Refuges : validation obligatoire par l'admin avant de publier des animaux ; SIRET contrôlé (14 chiffres + clé de Luhn) et vérifiable dans l'annuaire officiel des entreprises.
- ✅ Familles : dossier validé par l'admin avant toute proposition.
- ✅ Admins : liste tenue dans une table protégée ; double authentification (TOTP Google Authenticator) **obligatoire**, exigée par le serveur (niveau `aal2`).
- ✅ FA et refuges : double authentification **facultative**, avec message d'incitation ; une fois activée, le serveur refuse toute session ouverte avec le seul mot de passe.
- ✅ Compte bloqué ou clôturé : refusé à chaque requête par le serveur, même si une session était encore ouverte ; connexion impossible (blocage côté Supabase Auth).

## 4. Authentification et mots de passe

- ✅ Mots de passe gérés par Supabase Auth (hachage, jamais stockés en clair).
- ✅ Connexion via un client Supabase propre à chaque requête (pas de session partagée entre utilisateurs).
- ✅ Réinitialisation du mot de passe (« Mot de passe oublié ») :
  - lien généré par PetIA, **valable 5 minutes**, à **usage unique** ; seule l'empreinte (SHA-256) du jeton est conservée ; le jeton est placé après `#` dans l'adresse (jamais transmis aux serveurs web) et retiré de la barre d'adresse dès lecture ;
  - code Google Authenticator exigé si la double authentification est activée (5 codes erronés : lien annulé) ;
  - mot de passe de 12 caractères minimum, ne contenant pas l'identifiant de l'e-mail, et refusé s'il figure dans des fuites connues (Have I Been Pwned, par k-anonymat : seuls 5 caractères de l'empreinte SHA-1 sont envoyés, jamais le mot de passe) ;
  - fermeture de toutes les sessions après changement ;
  - e-mail d'alerte avec bouton « Ce n'était pas moi » (valable 7 jours) qui bloque le compte, ferme les sessions et prévient l'admin ;
  - 3 demandes maximum par heure par e-mail et par IP ; réponse identique, au même moment, que le compte existe ou non.
- ✅ Changement de mot de passe depuis son espace : mot de passe actuel + code Google Authenticator si activé ; mêmes règles, fermeture des sessions et e-mail d'alerte.
- ✅ Déconnexion : la session est fermée côté serveur ; bouton « Déconnecter tous mes appareils ».

## 5. Protection du serveur et des sites

- ✅ HTTPS partout (TLS) ; HSTS activé.
- ✅ Limitation des requêtes par adresse IP : 600 / 15 min au global ; 20 / 15 min sur connexion, inscription, mot de passe, double authentification.
- ✅ CORS limité aux deux sites PetIA.
- ✅ En-têtes de sécurité : Content-Security-Policy, X-Frame-Options (anti-clickjacking), X-Content-Type-Options, Referrer-Policy, Permissions-Policy ; site admin non indexé et non mis en cache.
- ✅ Taille des requêtes limitée (200 ko) ; aucune information technique renvoyée en cas d'erreur.
- ✅ Dépendances du serveur : 0 vulnérabilité connue (npm audit, 23/10/2026).
- ✅ Entrées utilisateur : listes blanches de champs et de valeurs côté serveur ; texte affiché neutralisé (protection XSS) ; noms insérés dans les e-mails neutralisés.
- ✅ Routes non protégées permettant d'envoyer des e-mails au nom de PetIA supprimées.
- ✅ Limitation renforcée (20 / 15 min par IP) aussi sur mot de passe oublié, blocage, fermeture des sessions et clôture.

## 6. Chiffrement

- ✅ En transit : TLS sur tous les échanges.
- ✅ Au repos : chiffrement du stockage de la base par Supabase.
- ⬜ Chiffrement applicatif des champs les plus sensibles (téléphone, adresse, réponses libres) avec clé hors base — proposé, non décidé.

## 7. Journalisation, détection et alertes

- ✅ Journal des accès en **ajout seul** : toute modification est refusée par la base ; suppression impossible avant 1 an ; seule exception, l'anonymisation RGPD d'une personne (fonction réservée au serveur).
- ✅ Contenu d'une ligne : date, événement, compte, e-mail, rôle, cible (type + identifiant), IP, navigateur. Jamais de mot de passe, de jeton ni de contenu de dossier.
- ✅ Événements journalisés :
  - connexions réussies, échouées, refusées (verrouillage, compte bloqué, statut) ; codes de double authentification erronés ; activation / désactivation de la double authentification ; déconnexions ;
  - inscriptions, envoi du questionnaire ;
  - demandes de lien, réinitialisations et changements de mot de passe ;
  - admin : connexions, consultation des listes et des dossiers FA, décisions (familles, refuges), notes internes, blocages / déblocages ;
  - refuges : consultation des familles proposées, validation / refus des matchs, début et fin d'accueil ; FA : réponse aux propositions ;
  - clôtures, suppressions automatiques, avertissements d'inactivité, opérations DPO (recherche, inventaire, export, suppression).
- ✅ **Conservation du journal : 1 an** (fourchette CNIL : 6 mois à 1 an), puis suppression automatique.
- ✅ Détection et alertes :
  - verrouillage du compte 15 minutes après 5 échecs (mot de passe ou code) en 15 minutes ;
  - e-mail à l'utilisateur lors d'une connexion depuis un appareil **et** une IP jamais vus en 180 jours, avec bouton « Ce n'était pas moi » ;
  - e-mail aux admins pour **toute connexion à l'espace admin** ;
  - e-mail aux admins en cas de consultation inhabituelle : plus de 60 consultations de familles proposées par un refuge, ou plus de 80 dossiers FA ouverts par un admin, en une heure ;
  - e-mail aux admins quand un utilisateur bloque son compte.
- ✅ Actions : « Déconnecter tous mes appareils » ; blocage / déblocage d'un compte par l'admin (motif tracé) ; vue « Journal des accès » dans le site admin (filtres par période, événement, e-mail, alertes).
- ⬜ Les alertes par e-mail dépendent de Brevo (actuellement bloqué, voir § 11) ; en attendant, elles restent visibles dans le journal.
- ⬜ Les échecs de saisie du code sur le site admin se font directement auprès de Supabase et ne sont pas dans le journal PetIA (visibles dans les journaux Supabase Auth).

## 8. Durées de conservation

| Donnée | Durée | Point de départ |
|---|---|---|
| Compte FA ou refuge clos | **2 ans** | Clôture du compte (bouton « Clôturer mon compte » côté FA et refuge) |
| Compte inactif | **2 ans** | Dernière activité ; e-mail d'avertissement à 23 mois ; suppression au plus tôt 30 jours après l'avertissement ; toute connexion annule l'avertissement |
| Dossier FA ou refuge refusé | **6 mois** | Date du refus |
| Journal des accès | **1 an** | Date de l'événement |
| Lien de réinitialisation | 5 minutes de validité, supprimé après 1 jour | Création |
| Lien « Ce n'était pas moi » | 7 jours de validité, supprimé après 1 jour | Création |

- ✅ Clôture : impossible tant qu'un accueil est en cours ; les propositions en attente sont annulées ; mot de passe demandé ; sessions fermées ; e-mail indiquant la date de suppression.
- ✅ Suppression automatique : contrôlée toutes les 6 heures par le serveur, exécutée au plus une fois par 20 heures ; bilan inscrit au journal ; bouton « Lancer maintenant » dans l'outil DPO.
- ✅ La suppression d'un compte supprime en cascade ses données liées (dossier, matchs, évaluations ; animaux pour un refuge) et anonymise ses lignes du journal ; un compte également administrateur conserve son accès admin.
- ⬜ Le serveur (offre gratuite Render) s'endort sans visite : la suppression a lieu au réveil suivant. Pour une exécution garantie chaque jour : tâche planifiée Render (payante) ou extension `pg_cron` de Supabase.

## 9. Droits des personnes

- ✅ Outil DPO dans le site admin :
  - recherche d'une personne par e-mail, nom, prénom ou téléphone (familles, refuges, et journal pour les e-mails sans compte) ;
  - inventaire de toutes ses données : compte, dossier, matchs et accueils, animaux, évaluations, journal, jetons ;
  - export JSON (droit d'accès et portabilité) ;
  - suppression en une fois, après saisie de l'e-mail de la personne : compte, dossier, matchs, évaluations, animaux, et anonymisation du journal ;
  - chaque opération DPO est tracée (sans donnée personnelle de la personne supprimée).
- ⬜ Procédure de réponse aux demandes (délai d'un mois) à formaliser.

## 10. Intelligence artificielle

- ✅ Données transmises à l'IA : uniquement des critères (logement, rythme de vie, expérience, réponses aux mises en situation, caractéristiques de l'animal). Jamais de nom, e-mail, téléphone, adresse, coordonnées GPS ni numéro de puce.
- Ces critères restent des **données personnelles pseudonymisées**.
- ✅ Si l'IA est indisponible, le matching fonctionne sur des règles explicites.
- ⬜ Le score de compatibilité des FA s'apparente à du profilage : AIPD à envisager ; décision finale toujours humaine (validation par le refuge, réponse de la FA).
- ⬜ Transfert hors UE (Anthropic, États-Unis) : encadrement contractuel à vérifier.

## 11. Points ouverts (responsabilité DPO)

- ⬜ Contrats de sous-traitance (DPA) : Supabase, Render, Vercel, Anthropic, Brevo.
- ⬜ Sauvegardes de la base : vérifier ce que prévoit l'offre Supabase.
- ⬜ Débloquer Brevo (IP de Render non autorisée, clé API sans droit « transactional email »).
- ⬜ Politique de confidentialité et CGU à revoir (IA, double authentification, nouvelles données, durées).
- ⬜ AIPD.
- ⬜ Contrat FA / refuge : contenu à revoir avant intégration.
