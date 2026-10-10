// petia-backend/server.js
// Point d'entrée Express — PetIA backend
// Dépendances : express, cors, dotenv, bcrypt, jsonwebtoken, @supabase/supabase-js, @anthropic-ai/sdk

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const app     = express();

// ─── CORS ─────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://petia.fr',
  'https://www.petia.fr',
  'https://petia-app.vercel.app',   // ← remplace par ton URL Vercel exacte
];

app.use(cors({
  origin: (origin, cb) => {
    // Autoriser les requêtes sans origin (Postman, curl) en dev
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS bloqué : ${origin}`));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '2mb' }));

// ─── SANTÉ ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', app: 'PetIA backend', env: process.env.NODE_ENV }));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.use('/api/auth',    require('./routes/auth'));
// À ajouter au fur et à mesure :
// app.use('/api/familles', require('./routes/familles'));
// app.use('/api/animaux',  require('./routes/animaux'));
// app.use('/api/matching', require('./routes/matching'));

// ─── ERREURS ──────────────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error(err.message);
  res.status(err.status || 500).json({ message: err.message || 'Erreur interne.' });
});

// ─── DÉMARRAGE ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ PetIA backend — port ${PORT}`));
