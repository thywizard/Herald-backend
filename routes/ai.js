const express = require('express');
const router = express.Router();
const { chatWithHeraldAI } = require('../services/heraldAI');

// POST /api/ai/chat — stateless: the frontend keeps the conversation in
// localStorage (no login, same pattern as everything else in Herald) and
// resends the whole message list each turn.
// body: { messages: [{ role: 'user'|'assistant', content: string }, ...] }
router.post('/chat', async (req, res) => {
  const messages = req.body?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }
  // Cap how much history gets sent/billed per request.
  const trimmed = messages.slice(-20);

  try {
    const { reply, attachments } = await chatWithHeraldAI(trimmed);
    res.json({ reply, attachments });
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

module.exports = router;
