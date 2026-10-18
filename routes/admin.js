const express = require('express');
const router = express.Router();
const multer = require('multer');
const cloudinary = require('cloudinary').v2; // auto-configures from CLOUDINARY_URL env var
const Article = require('../models/Article');
const IngestLog = require('../models/IngestLog');
const Comment = require('../models/Comment');
const PushSubscription = require('../models/PushSubscription');
const { aiAssist, checkAI } = require('../services/heraldAI');

const escapeRegex = (str) => String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const { runIngestOnce } = require('../cron/ingest');
const { sendPushToAll } = require('../services/pushSend');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

// POST /api/admin/run-ingest — deliberately BEFORE the auth check below.
// This is what cron-job.org calls hourly (?source is absent, defaults to
// 'cron'), and the authenticated admin dashboard also calls this same
// route with ?source=manual so ingest logs show which one triggered it.
// It doesn't send a password — it can only trigger ingestion, nothing
// destructive, so it's safe to leave open.
router.post('/run-ingest', async (req, res) => {
  const source = req.query.source === 'manual' ? 'manual' : 'cron';
  runIngestOnce(source);
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
  if (['admin', 'editor', 'ai'].includes(req.query.origin)) query.origin = req.query.origin;
  if (req.query.q) {
    query.headline = { $regex: escapeRegex(String(req.query.q).slice(0, 100)), $options: 'i' };
  }

  const articles = await Article.find(query)
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .select('-body')
    .lean();

  const total = await Article.countDocuments(query);

  res.json({ articles, total, page });
});

// POST /api/admin/articles — you or an editor writing directly
router.post('/articles', async (req, res) => {
  const { headline, body, image, category, source, origin, notify, priority, status } = req.body;

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
    // 'pending' = saved as a draft, not visible on the site until published
    status: status === 'pending' ? 'pending' : 'published',
  });

  let pushResult = null;
  if (notify && article.status === 'published') {
    try {
      pushResult = await sendPushToAll({
        headline: article.headline,
        source: article.source,
        image: article.image,
        articleId: article._id.toString(),
        priority: priority === 'high' ? 'high' : 'normal',
      });
    } catch (err) {
      console.error('[push] failed to send on publish:', err.message);
    }
  }

  res.status(201).json({ ...article.toObject(), push: pushResult });
});

// POST /api/admin/articles/:id/notify — send a push notification for an
// already-published article (used from the Articles list for anything,
// including AI-ingested articles, not just ones written in the dashboard).
router.post('/articles/:id/notify', requireAdmin, async (req, res) => {
  const article = await Article.findById(req.params.id);
  if (!article) return res.status(404).json({ error: 'Article not found' });

  const priority = req.body?.priority === 'high' ? 'high' : 'normal';

  try {
    const result = await sendPushToAll({
      headline: article.headline,
      source: article.source,
      image: article.image,
      articleId: article._id.toString(),
      priority,
    });
    res.json({ push: result });
  } catch (err) {
    res.status(500).json({ error: 'Push send failed: ' + err.message });
  }
});

// GET /api/admin/push-status — is push actually wired up? Shows whether the
// VAPID keys are set and how many devices have really subscribed (i.e. made
// it into the database, not just allowed notifications in their browser).
router.get('/push-status', requireAdmin, async (req, res) => {
  const PushSubscription = require('../models/PushSubscription');
  const subscribers = await PushSubscription.countDocuments({});
  res.json({
    vapidConfigured: !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY),
    subscribers,
    autoPush: process.env.AUTO_PUSH !== 'false',
    autoPublish: process.env.AUTO_PUBLISH === 'true',
  });
});

// POST /api/admin/push-test — sends a test notification to every subscribed
// device, so you can check the whole pipeline without publishing anything.
router.post('/push-test', requireAdmin, async (req, res) => {
  try {
    const result = await sendPushToAll({
      headline: 'Herald test notification',
      source: 'Herald',
      articleId: null,
      priority: 'normal',
    });
    res.json({ push: result });
  } catch (err) {
    res.status(500).json({ error: 'Push send failed: ' + err.message });
  }
});

// PATCH /api/admin/articles/:id — edit any article
router.patch('/articles/:id', async (req, res) => {
  // Only content fields can be edited through here (no likes/views/origin
  // tampering); status/pin have their own routes.
  const allowed = ['headline', 'body', 'image', 'category', 'source', 'isSponsored'];
  const updates = {};
  for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
  const article = await Article.findByIdAndUpdate(req.params.id, updates, { new: true });
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

// GET /api/admin/articles/:id — full article for the editor (no view count bump)
router.get('/articles/:id', async (req, res) => {
  if (!/^[a-f\d]{24}$/i.test(req.params.id)) return res.status(400).json({ error: 'Bad id' });
  const article = await Article.findById(req.params.id).lean();
  if (!article) return res.status(404).json({ error: 'Article not found' });
  res.json(article);
});

// GET /api/admin/stats — Overview page numbers
router.get('/stats', async (req, res) => {
  const [total, published, pending, unpublished, pinned, byCategory] = await Promise.all([
    Article.countDocuments({}),
    Article.countDocuments({ status: 'published' }),
    Article.countDocuments({ status: 'pending' }),
    Article.countDocuments({ status: 'unpublished' }),
    Article.countDocuments({ isPinned: true }),
    Article.aggregate([
      { $match: { status: 'published' } },
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
  ]);

  const lastIngest = await IngestLog.findOne().sort({ createdAt: -1 });

  // Engagement + activity numbers for the Studio dashboard.
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const [totals, byOrigin, daily, topArticles, commentCount, subscribers] = await Promise.all([
    Article.aggregate([
      { $group: { _id: null, views: { $sum: '$views' }, likes: { $sum: '$likes' }, shares: { $sum: '$shares' } } },
    ]),
    Article.aggregate([{ $group: { _id: '$origin', count: { $sum: 1 } } }]),
    Article.aggregate([
      { $match: { createdAt: { $gte: weekAgo } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    Article.find({ status: 'published' }).sort({ views: -1 }).limit(5).select('headline views likes shares category').lean(),
    Comment.countDocuments({}),
    PushSubscription.countDocuments({}),
  ]);
  const t = totals[0] || { views: 0, likes: 0, shares: 0 };

  res.json({
    engagement: { views: t.views, likes: t.likes, shares: t.shares, comments: commentCount },
    byOrigin: byOrigin.map((o) => ({ origin: o._id, count: o.count })),
    daily: daily.map((d) => ({ day: d._id, count: d.count })),
    topArticles,
    subscribers,
    config: {
      autoPublish: process.env.AUTO_PUBLISH === 'true',
      autoPush: process.env.AUTO_PUSH !== 'false',
      aiChat: !!process.env.HERALD_AI_API_KEY,
      search: !!process.env.SEARXNG_URL,
      vapid: !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY),
      cloudinary: !!process.env.CLOUDINARY_URL || !!process.env.CLOUDINARY_CLOUD_NAME,
    },
    total,
    published,
    pending,
    unpublished,
    pinned,
    byCategory: byCategory.map((c) => ({ category: c._id, count: c.count })),
    lastIngest,
  });
});

// GET /api/admin/ingest-logs — run history for the Logs page
router.get('/ingest-logs', async (req, res) => {
  const limit = parseInt(req.query.limit) || 30;
  const logs = await IngestLog.find().sort({ createdAt: -1 }).limit(limit);
  res.json(logs);
});

// POST /api/admin/upload-image — uploads a file to Cloudinary, returns the hosted URL
router.post('/upload-image', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream({ folder: 'herald' }, (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
      stream.end(req.file.buffer);
    });
    res.json({ url: result.secure_url });
  } catch (err) {
    res.status(500).json({ error: 'Upload failed: ' + err.message });
  }
});


// ---- Studio extras ----

// POST /api/admin/ai-assist — AI writing helper inside the editor.
// body: { action: 'headlines'|'summary'|'keypoint'|'proofread'|'expand', headline, body }
router.post('/ai-assist', async (req, res) => {
  const { action, headline, body } = req.body || {};
  if (!action || !(headline || body)) return res.status(400).json({ error: 'action and some text are required' });
  try {
    const result = await aiAssist(action, { headline, body });
    res.json({ result });
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

// GET /api/admin/ai-check — really calls the AI models and reports what
// happened (key / model-name / rate-limit problems show up here verbatim).
router.get('/ai-check', requireAdmin, async (req, res) => {
  try {
    res.json(await checkAI());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/comments — newest comments across all articles, for moderation
router.get('/comments', requireAdmin, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const comments = await Comment.find().sort({ createdAt: -1 }).limit(limit).populate('article', 'headline').lean();
  res.json(comments);
});

// DELETE /api/admin/comments/:id
router.delete('/comments/:id', requireAdmin, async (req, res) => {
  await Comment.findByIdAndDelete(req.params.id);
  res.json({ deleted: true });
});

// POST /api/admin/push-broadcast — custom notification not tied to publishing
// body: { title, articleId? , priority? }
router.post('/push-broadcast', requireAdmin, async (req, res) => {
  const title = String(req.body?.title || '').trim().slice(0, 140);
  if (!title) return res.status(400).json({ error: 'title is required' });
  let article = null;
  if (req.body.articleId && /^[a-f\d]{24}$/i.test(req.body.articleId)) {
    article = await Article.findById(req.body.articleId).select('image source');
  }
  try {
    const result = await sendPushToAll({
      headline: title,
      source: article?.source || 'Herald',
      image: article?.image,
      articleId: article ? article._id.toString() : null,
      priority: req.body.priority === 'high' ? 'high' : 'normal',
    });
    res.json({ push: result });
  } catch (err) {
    res.status(500).json({ error: 'Push send failed: ' + err.message });
  }
});

module.exports = router;
