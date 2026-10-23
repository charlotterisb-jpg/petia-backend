// petia-backend/services/refuge.js
// Informations d'inscription d'un refuge : nettoyage et contrôle du SIRET.

const TYPES = {
  'fourriere': 'fourriere', 'Fourrière municipale': 'fourriere',
  'spa': 'spa', 'SPA / Refuge': 'spa',
  'association': 'association', 'Association de protection animale': 'association',
  'autre': 'autre', 'Autre': 'autre',
};
const ESPECES = ['chien', 'chat', 'lapin', 'oiseau', 'rongeur'];
const DELAIS = ['moins_24h', '24_48h', '2_5_jours', 'plus_semaine'];

const texte = (v, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const entier = (v, max) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 && n <= max ? n : null; };

// SIRET : 14 chiffres + clé de Luhn (exception : établissements de La Poste, SIREN 356000000)
function siretValide(siret) {
  if (!/^\d{14}$/.test(siret)) return false;
  if (siret.startsWith('356000000')) return siret.split('').reduce((s, c) => s + Number(c), 0) % 5 === 0;
  let somme = 0;
  for (let i = 0; i < 14; i++) {
    let c = Number(siret[13 - i]);
    if (i % 2 === 1) { c *= 2; if (c > 9) c -= 9; }
    somme += c;
  }
  return somme % 10 === 0;
}

function nettoyerRefuge(b = {}) {
  const out = {};
  if (b.type_structure !== undefined) out.type_structure = TYPES[b.type_structure] || null;
  for (const k of ['adresse', 'telephone', 'contact_prenom', 'contact_nom', 'contact_fonction', 'site_web']) {
    const v = texte(b[k], k === 'adresse' ? 300 : 120);
    if (v) out[k] = v;
  }
  // « Prénom & Nom » saisi dans un seul champ
  if (b.contact && !out.contact_nom) {
    const parts = String(b.contact).trim().split(/\s+/);
    out.contact_prenom = texte(parts.shift(), 80);
    out.contact_nom = texte(parts.join(' '), 120);
  }
  if (b.siret) {
    const s = String(b.siret).replace(/\s/g, '');
    out.siret = /^\d{14}$/.test(s) ? s : null;
  }
  if (Array.isArray(b.especes)) out.especes = [...new Set(b.especes.filter(e => ESPECES.includes(e)))];
  const details = {};
  const cap = entier(b.capacite_mois, 10000); if (cap != null) details.capacite_mois = cap;
  const ray = entier(b.rayon_km, 500); if (ray != null) details.rayon_km = ray;
  if (DELAIS.includes(b.delai_urgence)) details.delai_urgence = b.delai_urgence;
  if (Object.keys(details).length) out.details = details;
  return out;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

module.exports = { nettoyerRefuge, siretValide, esc };
