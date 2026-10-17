const axios = require('axios');
const { PROMPT_TEMPLATE, parseJsonResponse } = require('./geminiRewrite');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

/**
 * Fully rewrites a raw scraped article using Groq (Llama 3.3 70B).
 * Same task and prompt as the Gemini version — this exists to pool
 * two separate free-tier quotas rather than depend on just one.
 */
async function rewriteWithGroq(article) {
  const prompt = PROMPT_TEMPLATE(article);

  const { data } = await axios.post(
    GROQ_URL,
    {
      model: 'openai/gpt-oss-120b',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const text = data.choices[0].message.content.trim();
  return parseJsonResponse(text, 'Groq');
}

module.exports = { rewriteWithGroq };
