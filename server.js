require('dotenv').config();
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');
const articleRoutes = require('./routes/articles');
const adminRoutes = require('./routes/admin');
const pushRoutes = require('./routes/push');
const searchRoutes = require('./routes/search');
const aiRoutes = require('./routes/ai');
const commentRoutes = require('./routes/comments');
const { startIngestSchedule } = require('./cron/ingest');
const { warmSearXNG } = require('./services/webSearch');

// Express 4 doesn't catch errors thrown/rejected inside async route handlers:
// a bad id or a DB hiccup would leave the request hanging (and an unhandled
// rejection can take the whole process down). This makes any rejected async
// handler flow into the error middleware at the bottom instead.
try {
  const Layer = require('express/lib/router/layer');
  Layer.prototype.handle_request = function handle(req, res, next) {
    const fn = this.handle;
    if (fn.length > 3) return next();
    try {
      const ret = fn(req, res, next);
      if (ret && typeof ret.catch === 'function') ret.catch(next);
    } catch (err) {
      next(err);
    }
  };
} catch (e) {
  console.warn('[server] could not install async error handling:', e.message);
}

const app = express();

app.use(cors());
app.use(express.json());

app.use('/api/articles', articleRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/comments', commentRoutes);

app.get('/', (req, res) => {
  res.send('News app backend is running.');
});

// Must come after all routes.
app.use((err, req, res, next) => {
  console.error('[server] request failed:', req.method, req.originalUrl, '-', err.message);
  if (res.headersSent) return res.end();
  const status = err.name === 'CastError' ? 400 : 500;
  res.status(status).json({ error: status === 400 ? 'Bad request' : 'Something went wrong' });
});

const PORT = process.env.PORT || 5000;

connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    startIngestSchedule(); // begins hourly AI ingest pipeline
    warmSearXNG(); // wake the (free-tier, sleepy) search engine as soon as we're up
    // Optional: keep SearXNG awake while this backend is up. Off by default —
    // two always-on free Render services use up the shared 750 free hours/month.
    if (process.env.KEEP_SEARXNG_AWAKE === 'true') {
      setInterval(() => warmSearXNG(true), 9 * 60 * 1000);
    }
  });
});
