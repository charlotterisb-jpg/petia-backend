const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Render place le serveur derrière un proxy : l'adresse IP réelle du client
// est lue dans X-Forwarded-For (nécessaire pour limiter les tentatives par IP).
app.set('trust proxy', 1);
app.disable('x-powered-by');

// En-têtes de sécurité (API JSON : aucune page à afficher)
app.use(helmet({
  contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
  crossOriginResourcePolicy: { policy: 'same-site' },
}));

// Seuls les sites PetIA peuvent appeler l'API depuis un navigateur.
// CORS_ORIGINS (Render) permet d'ajouter les futurs domaines, séparés par des virgules.
const ORIGINES = (process.env.CORS_ORIGINS || 'https://petia-frontend.vercel.app,https://petia-admin.vercel.app,https://petia-admin-charlotte-s-projects3.vercel.app')
  .split(',').map(o => o.trim()).filter(Boolean);
app.use(cors({
  // + les adresses Vercel du projet admin (petia-admin-…-charlotte-s-projects3.vercel.app)
  origin: (origin, cb) => cb(null, !origin || ORIGINES.includes(origin)
    || /^https:\/\/petia-admin(-[a-z0-9-]+)?-charlotte-s-projects3\.vercel\.app$/.test(origin)),
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 600,
}));

// Adresse IP réelle du visiteur. Render passe par Cloudflare, qui fournit l'IP du
// client dans un en-tête qu'il réécrit lui-même (non falsifiable par le visiteur).
let diagnosticIp = false;
app.use((req, res, next) => {
  const cf = req.headers['cf-connecting-ip'] || req.headers['true-client-ip'];
  req.ipClient = (typeof cf === 'string' && /^[0-9a-fA-F:.]{3,45}$/.test(cf)) ? cf : req.ip;
  if (!diagnosticIp) {
    diagnosticIp = true;
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').filter(Boolean).length;
    console.log(`🌍 IP visiteur : en-tête Cloudflare ${cf ? 'présent' : 'absent'}, ${xff} adresse(s) dans X-Forwarded-For`);
  }
  next();
});

app.use(express.json({ limit: '200kb' }));

// Limites de requêtes par adresse IP
const messageLimite = { message: 'Trop de requêtes. Réessayez dans quelques minutes.' };
const parIp = { keyGenerator: (req) => req.ipClient || req.ip };
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: 600, standardHeaders: 'draft-7', legacyHeaders: false, message: messageLimite, ...parIp }));
// Connexion, inscription, mot de passe, double authentification : protection contre les essais en masse
const limiteSensible = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false, ...parIp,
  message: { message: 'Trop de tentatives depuis cette connexion. Réessayez dans 15 minutes.' },
});
for (const chemin of ['/api/auth/login-fa', '/api/auth/login-fourriere', '/api/auth/register-fa', '/api/auth/register-refuge',
                      '/api/auth/mot-de-passe', '/api/auth/cloturer', '/api/auth/mfa', '/api/admin/moi', '/api/auth/compte-bloque', '/api/auth/sessions'])
  app.use(chemin, limiteSensible);

// Route de test
app.get('/', (req, res) => {
  res.json({ message: 'PetIA API fonctionne !', version: '1.1.0' });
});

// Routes
app.use('/api/animal', require('./routes/animal'));
app.use('/api/matching', require('./routes/matching'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/fa', require('./routes/fa'));

// Erreurs : jamais de détail technique renvoyé au navigateur
app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') return res.status(413).json({ message: 'Requête trop volumineuse.' });
  if (err instanceof SyntaxError) return res.status(400).json({ message: 'Requête invalide.' });
  console.error('Erreur non gérée:', err);
  res.status(500).json({ message: 'Erreur serveur.' });
});

app.listen(PORT, () => {
  console.log(`✅ PetIA API démarrée sur le port ${PORT}`);
  // Diagnostic sans divulgation : type de la clé serveur (jamais sa valeur)
  const cle = process.env.SUPABASE_SERVICE_KEY || '';
  let type = !cle ? 'ABSENTE' : cle.startsWith('sb_secret_') ? 'secret (OK)' : cle.startsWith('sb_publishable_') ? 'publishable (ERREUR : clé publique)' : 'inconnue';
  if (cle.split('.').length === 3) {
    try { const r = JSON.parse(Buffer.from(cle.split('.')[1], 'base64url').toString()).role; type = r === 'service_role' ? 'JWT service_role (OK)' : `JWT ${r} (ERREUR : pas service_role)`; } catch { type = 'JWT illisible'; }
  }
  console.log(`🔑 Clé Supabase serveur : ${type}`);
  console.log(`🌐 Sites autorisés (CORS) : ${ORIGINES.join(', ')}${process.env.CORS_ORIGINS ? ' [variable CORS_ORIGINS]' : ''}`);
  // Suppression automatique des données arrivées au terme de leur durée de conservation
  if (process.env.NODE_ENV !== 'test') require('./services/purge').planifierPurge();
});
