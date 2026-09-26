const express = require('express');
const router = express.Router();
const Article = require('../models/Article');

// GET /api/articles — main feed, paginated
router.get('/', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;

  const articles = await Article.find({ status: 'published' })
    .sort({ isPinned: -1, createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit);

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
    .limit(limit);

  res.json(articles);
});

// GET /api/articles/source/:source
router.get('/source/:source', async (req, res) => {
  const articles = await Article.find({ status: 'published', source: req.params.source }).sort({
    createdAt: -1,
  });
  res.json(articles);
});

// GET /api/articles/search?q=...
router.get('/search', async (req, res) => {
  const q = req.query.q || '';
  const articles = await Article.find({
    status: 'published',
    $or: [{ headline: { $regex: q, $options: 'i' } }, { body: { $regex: q, $options: 'i' } }],
  }).limit(30);
  res.json(articles);
});

// GET /api/articles/:id — single article + related ("You may like")
router.get('/:id', async (req, res) => {
  const article = await Article.findById(req.params.id);
  if (!article) return res.status(404).json({ error: 'Article not found' });

  const related = await Article.find({
    status: 'published',
    category: article.category,
    _id: { $ne: article._id },
  })
    .sort({ createdAt: -1 })
    .limit(4);

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
