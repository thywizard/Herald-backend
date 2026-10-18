const Article = require('../models/Article');

const escapeRegex = (str) => String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Words that say nothing about WHAT the person wants ("today", "latest"…).
const STOPWORDS = new Set(
  'the a an of in on at and or to for is are was were what who how why when where with from by about today latest news now me my i it this that do does vs'.split(' ')
);

// Searches Herald's own published articles by MEANING of the words rather than
// the exact phrase. The old version looked for the whole query as one string,
// so "Premier League scores" found nothing unless an article literally
// contained those three words in that order.
//   - splits the query into words (ignoring filler like "today")
//   - an article qualifies when it matches at least half of the words
//   - ranked: headline hits count more than body hits, whole-phrase headline
//     matches get a bonus, newest wins ties
async function searchHeraldArticles(query, { limit = 30 } = {}) {
  const raw = String(query || '').toLowerCase().slice(0, 100).trim();
  if (!raw) return [];

  let terms = [...new Set(raw.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1 && !STOPWORDS.has(t)))];
  if (terms.length === 0) terms = [...new Set(raw.split(/[^\p{L}\p{N}]+/u).filter(Boolean))];
  if (terms.length === 0) return [];
  terms = terms.slice(0, 8);

  const patterns = terms.map((t) => new RegExp(escapeRegex(t), 'i'));
  const candidates = await Article.find({
    status: 'published',
    $or: patterns.flatMap((re) => [{ headline: re }, { body: re }]),
  })
    .sort({ createdAt: -1 })
    .limit(120)
    .lean();

  const need = Math.max(1, Math.ceil(terms.length / 2));
  const scored = [];
  for (const a of candidates) {
    const head = a.headline.toLowerCase();
    const body = (a.body || '').toLowerCase();
    let score = 0;
    let matched = 0;
    for (const t of terms) {
      const inHead = head.includes(t);
      const inBody = body.includes(t);
      if (inHead || inBody) matched++;
      if (inHead) score += 3;
      if (inBody) score += 1;
    }
    if (matched < need) continue;
    if (head.includes(raw)) score += 4;
    scored.push({ a, score });
  }

  scored.sort((x, y) => y.score - x.score || new Date(y.a.createdAt) - new Date(x.a.createdAt));
  return scored.slice(0, limit).map(({ a }) => {
    const { body, sourceUrl, ...rest } = a;
    return rest;
  });
}

module.exports = { searchHeraldArticles };
