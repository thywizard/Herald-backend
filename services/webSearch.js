const axios = require('axios');

// Aggregates web search results from up to three free sources at once:
//   - SearXNG (self-hosted metasearch — scrapes Google/Bing/DuckDuckGo/etc
//     directly, no API key, no per-query cost or cap)
//   - Brave Search API (free-tier subscription, needs BRAVE_API_KEY)
//   - Google Custom Search JSON API (free up to 100 queries/day, needs
//     GOOGLE_CSE_API_KEY + GOOGLE_CSE_ID)
// Each source is independently optional — whichever env vars are set get
// queried, in parallel, and the results are merged + de-duplicated by URL.
// If none are configured yet, this returns an empty list rather than
// throwing, so the feature just sits quietly idle until keys are added.

const TIMEOUT_MS = 8000;

async function fetchSearXNG(query) {
  const base = process.env.SEARXNG_URL;
  if (!base) return [];
  try {
    const { data } = await axios.get(`${base.replace(/\/$/, '')}/search`, {
      params: { q: query, format: 'json' },
      timeout: TIMEOUT_MS,
    });
    return (data.results || []).slice(0, 10).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content || '',
      source: 'SearXNG',
    }));
  } catch (err) {
    console.error('[websearch] SearXNG error:', err.message);
    return [];
  }
}

async function fetchBrave(query) {
  const key = process.env.BRAVE_API_KEY;
  if (!key) return [];
  try {
    const { data } = await axios.get('https://api.search.brave.com/res/v1/web/search', {
      params: { q: query },
      headers: { Accept: 'application/json', 'X-Subscription-Token': key },
      timeout: TIMEOUT_MS,
    });
    return (data.web?.results || []).slice(0, 10).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.description || '',
      source: 'Brave',
    }));
  } catch (err) {
    console.error('[websearch] Brave error:', err.message);
    return [];
  }
}

async function fetchGoogleCSE(query) {
  const key = process.env.GOOGLE_CSE_API_KEY;
  const cx = process.env.GOOGLE_CSE_ID;
  if (!key || !cx) return [];
  try {
    const { data } = await axios.get('https://www.googleapis.com/customsearch/v1', {
      params: { key, cx, q: query },
      timeout: TIMEOUT_MS,
    });
    return (data.items || []).slice(0, 10).map((r) => ({
      title: r.title,
      url: r.link,
      snippet: r.snippet || '',
      source: 'Google',
    }));
  } catch (err) {
    console.error('[websearch] Google CSE error:', err.message);
    return [];
  }
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.replace(/\/$/, '').toLowerCase();
  } catch {
    return url;
  }
}

async function aggregateWebSearch(query) {
  const [searx, brave, google] = await Promise.all([
    fetchSearXNG(query),
    fetchBrave(query),
    fetchGoogleCSE(query),
  ]);

  const seen = new Set();
  const merged = [];
  // Interleave sources rather than concatenating block-by-block, so one
  // configured source doesn't bury the others at the bottom of the list.
  const max = Math.max(searx.length, brave.length, google.length);
  for (let i = 0; i < max; i++) {
    for (const arr of [searx, brave, google]) {
      const item = arr[i];
      if (!item || !item.url) continue;
      const key = normalizeUrl(item.url);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }

  return {
    results: merged,
    sourcesConfigured: {
      searxng: !!process.env.SEARXNG_URL,
      brave: !!process.env.BRAVE_API_KEY,
      google: !!(process.env.GOOGLE_CSE_API_KEY && process.env.GOOGLE_CSE_ID),
    },
  };
}

module.exports = { aggregateWebSearch };
