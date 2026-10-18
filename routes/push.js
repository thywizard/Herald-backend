const express = require('express');
const router = express.Router();
const PushSubscription = require('../models/PushSubscription');

// GET /api/push/vapid-public-key — the frontend fetches this at runtime
// rather than hardcoding it, so rotating keys never needs a frontend deploy.
router.get('/vapid-public-key', (req, res) => {
  if (!process.env.VAPID_PUBLIC_KEY) {
    return res.status(503).json({ error: 'Push notifications are not configured on this server' });
  }
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// POST /api/push/subscribe — browser sends its PushSubscription object
// (from pushManager.subscribe()) after the user grants permission.
router.post('/subscribe', async (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'Invalid subscription object' });
  }

  await PushSubscription.findOneAndUpdate(
    { endpoint },
    { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } },
    { upsert: true, new: true }
  );

  res.status(201).json({ subscribed: true });
});

// POST /api/push/unsubscribe — called when the user turns notifications off
router.post('/unsubscribe', async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'endpoint is required' });

  await PushSubscription.deleteOne({ endpoint });
  res.json({ unsubscribed: true });
});

module.exports = router;
