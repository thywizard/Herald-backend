const express = require('express');
const router = express.Router();
const { chatWithHeraldAI, streamHeraldAI } = require('../services/heraldAI');

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

// POST /api/ai/stream — same input as /chat, but answers as a Server-Sent
// Events stream so the reply appears word-by-word instead of after the whole
// generation finishes. Events (each `data: <json>\n\n`):
//   {type:'delta', text}  {type:'attachment', data}  {type:'status', text}
//   {type:'error', message}  {type:'done'}
router.post('/stream', async (req, res) => {
  const messages = req.body?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }
  const trimmed = messages.slice(-20).map((m) => ({ role: m.role, content: String(m.content || '') }));

  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // stop proxies (Render/nginx) from buffering the stream
  });
  res.flushHeaders?.();

  let aborted = false;
  res.on('close', () => {
    aborted = true;
  });
  const send = (event) => {
    if (!aborted) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  try {
    await streamHeraldAI(trimmed, send, () => aborted);
    send({ type: 'done' });
  } catch (err) {
    send({ type: 'error', message: err.message });
  }
  res.end();
});

module.exports = router;
