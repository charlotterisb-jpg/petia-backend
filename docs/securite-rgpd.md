# PetIA — Mesures de sécurité et éléments RGPD

Document de travail tenu à jour au fil du développement. Il sert de base au
registre des traitements (art. 30 RGPD) et à la description des mesures de
sécurité (art. 32). Dernière mise à jour : 23 octobre 2026.

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
| `journal_acces` 🟡 | Tous | événements de connexion et d'accès, IP, appareil |

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

## 4. Authentification et mots de passe

- ✅ Mots de passe gérés par Supabase Auth (hachage, jamais stockés en clair).
- ✅ Connexion via un client Supabase propre à chaque requête (pas de session partagée entre utilisateurs).
- 🟡 Réinitialisation du mot de passe :
  - lien généré par PetIA, **valable 5 minutes**, à **usage unique** ; seule l'empreinte du jeton est conservée ;
  - code Google Authenticator exigé si la double authentification est activée ;
  - mot de passe de 12 caractères minimum, refus des mots de passe présents dans des fuites connues (service Have I Been Pwned, par k-anonymat : le mot de passe n'est jamais transmis) ;
  - fermeture de toutes les sessions après changement ;
  - e-mail d'alerte avec bouton « Ce n'était pas moi » qui bloque le compte ;
  - 3 demandes maximum par heure par e-mail et par IP ; message identique que le compte existe ou non.
- 🟡 Changement de mot de passe depuis son espace : mot de passe actuel + code MFA si activé.

## 5. Protection du serveur et des sites

- ✅ HTTPS partout (TLS) ; HSTS activé.
- ✅ Limitation des requêtes par adresse IP : 600 / 15 min au global ; 20 / 15 min sur connexion, inscription, mot de passe, double authentification.
- ✅ CORS limité aux deux sites PetIA.
- ✅ En-têtes de sécurité : Content-Security-Policy, X-Frame-Options (anti-clickjacking), X-Content-Type-Options, Referrer-Policy, Permissions-Policy ; site admin non indexé et non mis en cache.
- ✅ Taille des requêtes limitée (200 ko) ; aucune information technique renvoyée en cas d'erreur.
- ✅ Dépendances du serveur : 0 vulnérabilité connue (npm audit, 23/10/2026).
- ✅ Entrées utilisateur : listes blanches de champs et de valeurs côté serveur ; texte affiché neutralisé (protection XSS) ; noms insérés dans les e-mails neutralisés.
- ✅ Routes non protégées permettant d'envoyer des e-mails au nom de PetIA supprimées.

## 6. Chiffrement

- ✅ En transit : TLS sur tous les échanges.
- ✅ Au repos : chiffrement du stockage de la base par Supabase.
- ⬜ Chiffrement applicatif des champs les plus sensibles (téléphone, adresse, réponses libres) avec clé hors base — proposé, non décidé.

## 7. Journalisation, détection et alertes 🟡

- Journal des accès en **ajout seul** : toute modification est refusée par la base ; suppression impossible avant 1 an ; seule exception, l'anonymisation RGPD d'une personne.
- Événements journalisés : connexions réussies et échouées, double authentification, demandes et changements de mot de passe, décisions admin, consultation des dossiers FA par l'admin et par les refuges, changements de statut, clôtures, suppressions.
- **Conservation du journal : 1 an** (fourchette CNIL : 6 mois à 1 an).
- Détection : verrouillage temporaire après échecs répétés ; alerte « nouvel appareil / nouvelle IP » ; alerte à l'admin pour toute connexion admin ; alerte en cas de consultation anormale de profils par un refuge.
- Actions : « déconnecter toutes mes sessions » ; blocage d'un compte par l'admin.
- Dépend de Brevo pour l'envoi des alertes par e-mail.

## 8. Durées de conservation 🟡

| Donnée | Durée | Point de départ |
|---|---|---|
| Compte FA ou refuge clos | **2 ans** | Clôture du compte (bouton de clôture côté FA et refuge, ou par l'admin) |
| Compte inactif | **2 ans** | Dernière activité (avertissement par e-mail avant suppression) |
| Dossier refusé | **6 mois** | Date du refus |
| Journal des accès | **1 an** | Date de l'événement |
| Jetons de réinitialisation | 5 minutes de validité | Création |

- Suppression automatique quotidienne ; la suppression d'un compte supprime en cascade ses données liées (animaux et matchs pour un refuge ; matchs pour une FA).

## 9. Droits des personnes 🟡

- Outil DPO dans le site admin : recherche d'une personne (e-mail, nom, téléphone), inventaire de toutes ses données, export, suppression en une fois (compte, dossier, matchs, journal anonymisé), avec trace de l'opération.
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
