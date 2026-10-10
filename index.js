require('dotenv').config();
const express = require('express');
const cors    = require('cors');

const app = express();

const ALLOWED = [
  'https://petia.fr',
  'https://www.petia.fr',
  'https://petia-app.vercel.app',
  /\.vercel\.app$/,
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    const ok = ALLOWED.some(p => p instanceof RegExp ? p.test(origin) : p === origin);
    cb(ok ? null : new Error('CORS'), ok);
  },
  credentials: true,
}));

app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.use('/api/auth', require('./routes/auth'));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`PetIA backend listening on port ${PORT}`));
