const { rewriteWithGemini } = require('./geminiRewrite');
const { rewriteWithGroq } = require('./groqRewrite');

/**
 * Tries Gemini first (primary), and if it fails for any reason — rate
 * limit, quota, timeout, bad response — automatically retries the same
 * article with Groq instead. Pools both free-tier quotas so ingest
 * doesn't stall just because one provider's daily/per-minute limit is hit.
 * Returns { headline, body, provider } — provider is logged so you can
 * see which one actually handled each article.
 */
async function rewriteArticle(article) {
  try {
    const result = await rewriteWithGemini(article);
    return { ...result, provider: 'gemini' };
  } catch (geminiErr) {
    console.warn(`[rewrite] Gemini failed ("${geminiErr.message.slice(0, 100)}"), falling back to Groq...`);
    try {
      const result = await rewriteWithGroq(article);
      return { ...result, provider: 'groq' };
    } catch (groqErr) {
      throw new Error(`Both providers failed — Gemini: ${geminiErr.message.slice(0, 100)} | Groq: ${groqErr.message.slice(0, 100)}`);
    }
  }
}

module.exports = { rewriteArticle };
