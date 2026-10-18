const axios = require('axios');

const BASE_URL = 'https://newsdata.io/api/1/news';

/**
 * Fetches raw articles from NewsData.io for a given category/country.
 * Returns an array of { headline, body, image, sourceUrl, source, category }
 * NOTE: NewsData's free tier often returns only partial content —
 * the AI rewrite step expands/rewrites whatever is available.
 *
 * IMPORTANT: we force `category` to whatever we explicitly asked NewsData
 * for, rather than trusting item.category back from the API. NewsData
 * often tags a single article with a category that doesn't match what we
 * requested (or with a category outside our fixed taxonomy, like "top" or
 * "crime"), which silently stranded articles outside every category tab
 * on the frontend (e.g. nothing showing in "technology" even though
 * technology articles were being fetched and saved — just under a
 * different category string). Forcing it to the requested category keeps
 * every article consistent with the tab it was fetched for.
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
      category: category || item.category?.[0] || 'world',
    }));
}

module.exports = { fetchLatestArticles };
