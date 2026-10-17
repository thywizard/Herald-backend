const mongoose = require('mongoose');

// One document per browser/device subscribed to push notifications.
// No login system, so there's no user link — just the raw Push API
// subscription object the browser's pushManager.subscribe() returns.
const PushSubscriptionSchema = new mongoose.Schema(
  {
    endpoint: { type: String, required: true, unique: true },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('PushSubscription', PushSubscriptionSchema);
