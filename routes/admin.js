const express = require('express');
const router = express.Router();
const Article = require('../models/Article');
const { runIngestOnce } = require('../cron/ingest');

// POST /api/admin/run-ingest — deliberately BEFORE the auth check below.
// This is what cron-job.org calls hourly, and it doesn't send a password —
// it can only trigger ingestion, nothing destructive, so it's safe to leave open.
router.post('/run-ingest', async (req, res) => {
  runIngestOnce();
  res.json({ message: 'Ingest triggered - check logs' });
});

// Everything below requires either the admin key or an editor key.
// Admin: full access. Editor: can create/edit articles, cannot delete,
// pin, unpublish, or trigger destructive/site-config actions.
router.use((req, res, next) => {
  const key = req.headers['x-admin-key'];
  if (key && key === process.env.ADMIN_KEY) {
    req.role = 'admin';
    return next();
  }
  const editorKeys = (process.env.EDITOR_KEYS || '').split(',').map((k) => k.trim()).filter(Boolean);
  if (key && editorKeys.includes(key)) {
    req.role = 'editor';
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized' });
});

// GET /api/admin/whoami — lets the dashboard know which role logged in
router.get('/whoami', (req, res) => {
  res.json({ role: req.role });
});

function requireAdmin(req, res, next) {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// GET /api/admin/articles — list ALL articles regardless of status, for the dashboard
router.get('/articles', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 30;
  const statusFilter = req.query.status; // optional: published | pending | unpublished

  const query = statusFilter ? { status: statusFilter } : {};

  const articles = await Article.find(query)
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit);

  const total = await Article.countDocuments(query);

  res.json({ articles, total, page });
});

// POST /api/admin/articles — you or an editor writing directly
router.post('/articles', async (req, res) => {
  const { headline, body, image, category, source, origin } = req.body;

  if (!headline || !body || !image || !category) {
    return res.status(400).json({ error: 'headline, body, image, and category are required' });
  }

  const article = await Article.create({
    headline,
    body,
    image,
    category,
    source: source || 'Staff',
    origin: origin === 'editor' ? 'editor' : 'admin',
    status: 'published',
  });

  res.status(201).json(article);
});

// PATCH /api/admin/articles/:id — edit any article
router.patch('/articles/:id', async (req, res) => {
  const article = await Article.findByIdAndUpdate(req.params.id, req.body, { new: true });
  if (!article) return res.status(404).json({ error: 'Article not found' });
  res.json(article);
});

// DELETE /api/admin/articles/:id
router.delete('/articles/:id', requireAdmin, async (req, res) => {
  await Article.findByIdAndDelete(req.params.id);
  res.json({ deleted: true });
});

// PATCH /api/admin/articles/:id/unpublish
router.patch('/articles/:id/unpublish', requireAdmin, async (req, res) => {
  const article = await Article.findByIdAndUpdate(req.params.id, { status: 'unpublished' }, { new: true });
  res.json(article);
});

// PATCH /api/admin/articles/:id/publish — re-publish a pending/unpublished article
router.patch('/articles/:id/publish', async (req, res) => {
  const article = await Article.findByIdAndUpdate(req.params.id, { status: 'published' }, { new: true });
  res.json(article);
});

// PATCH /api/admin/articles/:id/pin — toggle pin state (forces to top of Home)
router.patch('/articles/:id/pin', requireAdmin, async (req, res) => {
  const article = await Article.findById(req.params.id);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  article.isPinned = !article.isPinned;
  await article.save();
  res.json(article);
});

// GET /api/admin/articles/recent-ai — quick scan list for post-publish review
router.get('/articles/recent-ai', async (req, res) => {
  const articles = await Article.find({ origin: 'ai' }).sort({ createdAt: -1 }).limit(50);
  res.json(articles);
});

module.exports = router;
