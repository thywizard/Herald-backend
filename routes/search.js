const express = require('express');
const router = express.Router();
const { aggregateWebSearch, warmSearXNG } = require('../services/webSearch');
const { generateSearchAnswer } = require('../services/heraldAI');

const CATEGORIES = ['general', 'news', 'images', 'videos'];

// GET /api/search/web?q=...&category=general|news|images|videos
// Aggregated open-web search (SearXNG + Brave + Google CSE, whichever are
// configured) plus related searches and a knowledge-panel "infobox".
// The AI Overview is deliberately NOT generated here any more: it used to
// make every search wait for a second, slower LLM call. The frontend now
// fetches it separately from /answer so results appear immediately and the
// overview fills in on its own. Separate from /api/articles/search, which
// only searches Herald's own articles.
router.get('/web', async (req, res) => {
  const q = (req.query.q || '').trim();
  const category = CATEGORIES.includes(req.query.category) ? req.query.category : 'general';
  if (!q) return res.json({ results: [], suggestions: [], infobox: null, sourcesConfigured: {}, degraded: false });

  try {
    const data = await aggregateWebSearch(q, category);
    // A degraded (cold-start) response must not be cached by the browser/CDN,
    // otherwise the "empty" answer would stick around even after SearXNG wakes.
    res.set('Cache-Control', data.degraded ? 'no-store' : 'public, max-age=60');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Search failed: ' + err.message });
  }
});

// GET /api/search/answer?q=... — the AI Overview for the All tab. Reuses the
// (cached) results of /web, so it adds no extra search call. Returns
// { answer: string|null, sources: [{title, url}] } where sources[i] is the
// result that the answer's "[i+1]" citation points to.
router.get('/answer', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ answer: null, sources: [] });

  try {
    const data = await aggregateWebSearch(q, 'general');
    const top = data.results.slice(0, 5);
    const answer = await generateSearchAnswer(q, top);
    res.set('Cache-Control', answer ? 'public, max-age=300' : 'no-store');
    res.json({ answer, sources: top.map((r) => ({ title: r.title, url: r.url })) });
  } catch (err) {
    res.json({ answer: null, sources: [] });
  }
});

// GET /api/search/warm — fire-and-forget wake-up call. The app calls this on
// open / when the search box is focused so the (sleeping) free-tier search
// engine is already awake by the time the first real search is made.
router.get('/warm', (req, res) => {
  const started = warmSearXNG();
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, warming: started });
});

module.exports = router;
