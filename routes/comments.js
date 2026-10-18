const express = require('express');
const router = express.Router();
const Comment = require('../models/Comment');
const Article = require('../models/Article');

// GET /api/comments/:articleId — most recent first
router.get('/:articleId', async (req, res) => {
  const comments = await Comment.find({ article: req.params.articleId })
    .sort({ createdAt: -1 })
    .limit(200);
  res.json({ comments, total: comments.length });
});

// POST /api/comments/:articleId — { name, text }. No login: the commenter
// picks whatever display name they want to show for this comment.
router.post('/:articleId', async (req, res) => {
  const { name, text } = req.body || {};
  const trimmedName = (name || '').trim();
  const trimmedText = (text || '').trim();

  if (!trimmedName || !trimmedText) {
    return res.status(400).json({ error: 'name and text are required' });
  }
  if (trimmedName.length > 40) return res.status(400).json({ error: 'Name is too long (max 40 characters)' });
  if (trimmedText.length > 1000) return res.status(400).json({ error: 'Comment is too long (max 1000 characters)' });

  const article = await Article.findById(req.params.articleId).select('_id');
  if (!article) return res.status(404).json({ error: 'Article not found' });

  const comment = await Comment.create({ article: article._id, name: trimmedName, text: trimmedText });
  res.status(201).json(comment);
});

module.exports = router;
