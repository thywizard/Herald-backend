const axios = require('axios');

const BASE_URL = 'https://newsdata.io/api/1/news';

/**
 * Fetches raw articles from NewsData.io for a given category/country.
 * Returns an array of { headline, body, image, sourceUrl, source, category }
 * NOTE: NewsData's free tier often returns only partial content —
 * the Gemini rewrite step expands/rewrites whatever is available.
 */
async function fetchLatestArticles({ category = null, country = 'ng' } = {}) {
  const params = {
    apikey: process.env.NEWSDATA_API_KEY,
    country,
    language: 'en',
  };
  if (category) params.category = category;

  const { data } = await axios.get(BASE_URL, { params });

  if (!data?.results) return [];

  return data.results
    .filter((item) => item.title && item.link) // skip malformed entries
    .map((item) => ({
      headline: item.title,
      // 'content' is often truncated on free tier — 'description' as fallback
      rawBody: item.content || item.description || '',
      image: item.image_url || null,
      sourceUrl: item.link,
      source: item.source_id || 'Unknown',
      category: item.category?.[0] || category || 'general',
    }));
}

module.exports = { fetchLatestArticles };
