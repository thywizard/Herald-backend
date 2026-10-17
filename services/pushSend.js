const webpush = require('web-push');
const PushSubscription = require('../models/PushSubscription');

let configured = false;
function ensureConfigured() {
  if (configured) return;
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    throw new Error('VAPID keys are not set (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY)');
  }
  webpush.setVapidDetails(VAPID_SUBJECT || 'mailto:admin@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  configured = true;
}

/**
 * Sends a native push notification to every subscribed browser/device.
 * payload shape (kept intentionally small — this is what the service
 * worker's `push` event handler receives as event.data.json()):
 *   {
 *     headline: "Breaking: ...",
 *     source: "Vanguard",
 *     image: "https://...",     // used for the expanded BigPictureStyle image
 *     articleId: "66f...",      // used to build the deep link + for dedupe tag
 *     priority: "normal"|"high" // "high" = breaking news styling/vibration
 *   }
 * Returns { sent, failed, removed } counts.
 */
async function sendPushToAll(payload) {
  ensureConfigured();

  const subscriptions = await PushSubscription.find({});
  let sent = 0;
  let failed = 0;
  let removed = 0;

  const body = JSON.stringify(payload);

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
          body
        );
        sent++;
      } catch (err) {
        failed++;
        // 404/410 = the subscription is dead (uninstalled, browser data cleared, etc.)
        // — clean it up so future sends don't keep retrying it.
        if (err.statusCode === 404 || err.statusCode === 410) {
          await PushSubscription.deleteOne({ _id: sub._id });
          removed++;
        } else {
          console.error('[push] send failed:', err.message);
        }
      }
    })
  );

  return { sent, failed, removed, total: subscriptions.length };
}

module.exports = { sendPushToAll };
