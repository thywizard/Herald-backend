const axios = require('axios');
const cache = require('./cache');

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
const SEARCH_TTL_MS = 10 * 60 * 1000; // repeat searches within 10 min are instant
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// category: 'general' (default) | 'news' | 'images' | 'videos' — passed
// straight to SearXNG, which routes it to the matching engines. Also pulls
// out SearXNG's "suggestions" (related searches) and "infoboxes" (the
// Wikipedia-style knowledge card), which Google shows as related searches
// and the knowledge panel.
async function fetchSearXNG(query, category = 'general') {
  const base = process.env.SEARXNG_URL;
  if (!base) return { results: [], suggestions: [], infobox: null, failed: false };
  const url = `${base.replace(/\/$/, '')}/search`;

  // Render's free tier puts SearXNG to sleep after ~15 idle minutes, and the
  // first request after that either times out or comes back empty while the
  // engines spin up — which used to surface as a bogus "no results" on the
  // first search of a session (the second try worked). So: try quickly, and
  // if that fails or comes back empty, try once more with a much longer
  // timeout instead of giving up.
  const attempts = [{ timeout: 9000 }, { timeout: 25000, wait: 1500 }];
  let lastErr = null;

  for (const attempt of attempts) {
    if (attempt.wait) await sleep(attempt.wait);
    try {
      const { data } = await axios.get(url, {
        params: { q: query, format: 'json', categories: category },
        timeout: attempt.timeout,
      });

      const results = (data.results || []).slice(0, category === 'images' ? 30 : 12).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content || '',
        source: 'SearXNG',
        image: r.img_src || null,
        thumbnail: r.thumbnail_src || r.thumbnail || r.img_src || null,
        published: r.publishedDate || null,
        length: r.length || null,
      }));

      if (results.length === 0) {
        lastErr = new Error('empty response');
        continue; // engines may still be warming — retry once
      }

      const ib = (data.infoboxes || [])[0];
      const infobox = ib
        ? {
            title: ib.infobox,
            content: ib.content || '',
            image: ib.img_src || null,
            url: (ib.urls || [])[0]?.url || ib.id || null,
            links: (ib.urls || []).slice(0, 3).map((u) => ({ title: u.title, url: u.url })),
          }
        : null;

      const suggestions = [...(data.suggestions || []), ...(data.corrections || [])].slice(0, 8);
      return { results, suggestions, infobox, failed: false };
    } catch (err) {
      lastErr = err;
    }
  }

  console.error('[websearch] SearXNG gave nothing:', lastErr?.message);
  // failed:true tells the caller this was an engine problem, not a genuinely
  // empty query — so it is never cached and the frontend retries.
  return { results: [], suggestions: [], infobox: null, failed: true };
}

// Wakes SearXNG without waiting for it. Called when someone opens the app or
// focuses the search box, so the engine is already warm by the time they hit
// Search. Throttled so a burst of opens doesn't spam it.
let lastWarm = 0;
function warmSearXNG(force = false) {
  const base = process.env.SEARXNG_URL;
  if (!base || (!force && Date.now() - lastWarm < 4 * 60 * 1000)) return false;
  lastWarm = Date.now();
  axios.get(`${base.replace(/\/$/, '')}/healthz`, { timeout: 60000 }).catch(() => {});
  return true;
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

async function runAggregate(query, category) {
  // Brave and Google CSE only do plain web results, so they're skipped for
  // the news/images/videos tabs — those come from SearXNG alone.
  const general = category === 'general';
  const [searxData, brave, google] = await Promise.all([
    fetchSearXNG(query, category),
    general ? fetchBrave(query) : [],
    general ? fetchGoogleCSE(query) : [],
  ]);
  const searx = searxData.results;

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
    suggestions: searxData.suggestions,
    infobox: searxData.infobox,
    category,
    // true when every source came back empty because of an error/cold start,
    // not because the query genuinely has no results
    degraded: merged.length === 0 && searxData.failed,
    sourcesConfigured: {
      searxng: !!process.env.SEARXNG_URL,
      brave: !!process.env.BRAVE_API_KEY,
      google: !!(process.env.GOOGLE_CSE_API_KEY && process.env.GOOGLE_CSE_ID),
    },
  };
}

// Cached + de-duplicated: the Search tab's results request and its AI
// Overview request (and Herald AI's search tool) all share one upstream call.
function aggregateWebSearch(query, category = 'general') {
  const key = `web:${category}:${query.trim().toLowerCase()}`;
  return cache.remember(
    key,
    SEARCH_TTL_MS,
    () => runAggregate(query.trim(), category),
    (v) => v.results.length > 0 // never cache an empty/failed search
  );
}

module.exports = { aggregateWebSearch, warmSearXNG };
