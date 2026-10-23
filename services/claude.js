require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');

// Clé lue depuis l'environnement Render (ANTHROPIC_API_KEY).
const client = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 20000, maxRetries: 1 })
  : null;

const SYSTEM = `Tu évalues la compatibilité entre un animal de refuge et une famille d'accueil temporaire (FA).
Tu reçois deux profils de critères (aucune donnée d'identité). Les règles impératives ont déjà été vérifiées :
concentre-toi sur l'adéquation fine (comportement, rythme de vie, expérience, réponses aux mises en situation).
Réponds UNIQUEMENT par un objet JSON, sans texte autour :
{"score": entier 0-100,
 "recommandation": "FORT_MATCH" | "BON_MATCH" | "MATCH_POSSIBLE" | "DECONSEILLE" | "INCOMPATIBLE",
 "points_attention": [jusqu'à 3 phrases courtes en français],
 "resume": "une phrase en français expliquant le score"}
Si une information manque, ne l'invente pas : baisse légèrement le score et signale-le.`;

function extraireJSON(texte) {
  const debut = texte.indexOf('{');
  const fin = texte.lastIndexOf('}');
  if (debut === -1 || fin <= debut) return null;
  try { return JSON.parse(texte.slice(debut, fin + 1)); } catch { return null; }
}

// Renvoie l'objet JSON de l'IA, ou null si l'IA est indisponible.
async function analyserMatch(profilAnimal, profilFamille) {
  if (!client) return null;
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 500,
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: `Animal : ${JSON.stringify(profilAnimal)}\nFamille d'accueil : ${JSON.stringify(profilFamille)}`,
    }],
  });
  const texte = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return extraireJSON(texte);
}

module.exports = { analyserMatch, iaDisponible: () => !!client };
