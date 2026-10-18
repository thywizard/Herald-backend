const express = require('express');
const router = express.Router();
const Article = require('../models/Article');
const { searchHeraldArticles } = require('../services/articleSearch');

// List views only need card fields — dropping the full body (and the
// internal sourceUrl) makes the feed responses several times smaller/faster.
const LIST_FIELDS = '-body -sourceUrl';
const escapeRegex = (str) => String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const listCache = (res) => res.set('Cache-Control', 'public, max-age=20, stale-while-revalidate=120');

// GET /api/articles — main feed, paginated
router.get('/', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;

  const articles = await Article.find({ status: 'published' })
    .sort({ isPinned: -1, createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .select(LIST_FIELDS)
    .lean();

  listCache(res);
  res.json(articles);
});

// GET /api/articles/category/:category
router.get('/category/:category', async (req, res) => {
  const { category } = req.params;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;

  const articles = await Article.find({ status: 'published', category })
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .select(LIST_FIELDS)
    .lean();

  listCache(res);
  res.json(articles);
});

// GET /api/articles/source/:source
router.get('/source/:source', async (req, res) => {
  const articles = await Article.find({ status: 'published', source: req.params.source })
    .sort({ createdAt: -1 })
    .select(LIST_FIELDS)
    .lean();
  listCache(res);
  res.json(articles);
});

// GET /api/articles/search?q=...
router.get('/search', async (req, res) => {
  const articles = await searchHeraldArticles(req.query.q, { limit: 30 });
  res.json(articles);
});

// GET /api/articles/:id — single article + related ("You may like")
router.get('/:id', async (req, res) => {
  const article = await Article.findByIdAndUpdate(req.params.id, { $inc: { views: 1 } }, { new: true });
  if (!article) return res.status(404).json({ error: 'Article not found' });

  const related = await Article.find({
    status: 'published',
    category: article.category,
    _id: { $ne: article._id },
  })
    .sort({ createdAt: -1 })
    .limit(4)
    .select(LIST_FIELDS)
    .lean();

  res.json({ article, related });
});

// POST /api/articles/:id/like — anonymous like counter
router.post('/:id/like', async (req, res) => {
  const article = await Article.findByIdAndUpdate(req.params.id, { $inc: { likes: 1 } }, { new: true });
  res.json({ likes: article.likes });
});

// POST /api/articles/:id/share — anonymous share counter
router.post('/:id/share', async (req, res) => {
  const article = await Article.findByIdAndUpdate(req.params.id, { $inc: { shares: 1 } }, { new: true });
  res.json({ shares: article.shares });
});

module.exports = router;
