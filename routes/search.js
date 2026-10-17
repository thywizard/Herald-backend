const express = require('express');
const router = express.Router();
const { aggregateWebSearch } = require('../services/webSearch');
const { generateSearchAnswer } = require('../services/heraldAI');

// GET /api/search/web?q=... — aggregated open-web search (SearXNG + Brave +
// Google CSE, whichever are configured), plus a short AI-generated overview
// when Herald AI is configured (silently omitted otherwise). This is
// separate from /api/articles/search, which only searches Herald's own
// published articles.
router.get('/web', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ results: [], sourcesConfigured: {}, answer: null });

  try {
    const data = await aggregateWebSearch(q);
    const answer = await generateSearchAnswer(q, data.results);
    res.json({ ...data, answer });
  } catch (err) {
    res.status(500).json({ error: 'Search failed: ' + err.message });
  }
});

module.exports = router;
