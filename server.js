const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Route de test
app.get('/', (req, res) => {
  res.json({
    message: 'PetIA API fonctionne !',
    version: '1.0.0',
  });
});

// Routes
app.use('/api/fourriere', require('./routes/fourriere'));
app.use('/api/animal', require('./routes/animal'));
app.use('/api/famille', require('./routes/famille'));
app.use('/api/matching', require('./routes/matching'));

app.listen(PORT, () => {
  console.log(`✅ PetIA API démarrée sur le port ${PORT}`);
});
