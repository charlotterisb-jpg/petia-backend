# Umami — mesure d'audience exemptée de consentement

- Service Render `petia-stats` (Francfort), construit depuis ce dossier, déploiement manuel.
- Base : Supabase, schéma `umami`, rôle `umami` (aucun droit sur les tables PetIA).
- `DATABASE_URL` : chaîne « Session pooler » de Supabase, utilisateur `umami.teeprkpfrmpyuymaxxqe`, suffixe `?schema=umami`.
- `APP_SECRET` : chaîne aléatoire longue.
- Au premier lancement, changer immédiatement le mot de passe par défaut (admin / umami).
- Réglages CNIL : aucun cookie (Umami n'en dépose pas), IP non conservée, données réservées à PetIA, conservation 25 mois maximum.
