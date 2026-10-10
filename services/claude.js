require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function analyserMatch(animal, famille) {
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 1024,
    messages: [{ role: 'user', content: `Compatibilité animal/famille. Animal: ${JSON.stringify(animal)} Famille: ${JSON.stringify(famille)}. Réponds en JSON: {"score":0,"recommandation":"BON_MATCH","incompatibilites":[],"details_score":{}}` }],
  });
  return JSON.parse(msg.content[0].text);
}

module.exports = { analyserMatch };
