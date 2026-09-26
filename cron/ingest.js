const cron = require('node-cron');
const Article = require('../models/Article');
const { fetchLatestArticles } = require('../services/newsFetch');
const { fetchRSSArticles } = require('../services/rssFetch');
const { rewriteArticle } = require('../services/geminiRewrite');

const CATEGORIES = ['politics', 'sports', 'business', 'entertainment', 'world', 'technology'];

// Shared by both NewsData.io and RSS sources — fetch shape is the same either way.
async function processRawArticles(rawArticles, autoPublish) {
  for (const raw of rawArticles) {
    try {
      if (!raw.image) continue; // images are mandatory — skip articles without one
      if (!raw.headline || !raw.sourceUrl) continue; // skip malformed entries

      const exists = await Article.findOne({ sourceUrl: raw.sourceUrl });
      if (exists) continue;

      const rewritten = await rewriteArticle({
        headline: raw.headline,
        rawBody: raw.rawBody,
        source: raw.source,
      });

      await Article.create({
        headline: rewritten.headline,
        body: rewritten.body,
        image: raw.image,
        category: raw.category,
        source: raw.source,
        origin: 'ai',
        sourceUrl: raw.sourceUrl,
        status: autoPublish ? 'published' : 'pending',
      });

      console.log(`[ingest] saved: "${rewritten.headline}" (${autoPublish ? 'published' : 'pending'})`);
    } catch (err) {
      console.error(`[ingest] error processing "${raw.headline || 'unknown'}":`, err.message);
    }
  }
}

async function runIngestOnce() {
  console.log('[ingest] starting run...');
  const autoPublish = process.env.AUTO_PUBLISH === 'true';

  // NewsData.io — category-based fetch (Nigeria-focused)
  for (const category of CATEGORIES) {
    try {
      const rawArticles = await fetchLatestArticles({ category });
      await processRawArticles(rawArticles, autoPublish);
    } catch (err) {
      console.error(`[ingest] error on NewsData category "${category}":`, err.message);
    }
  }

  // RSS sources — Al Jazeera, France24, Zeteo
  try {
    const rssArticles = await fetchRSSArticles();
    await processRawArticles(rssArticles, autoPublish);
  } catch (err) {
    console.error('[ingest] error on RSS fetch:', err.message);
  }

  console.log('[ingest] run complete.');
}

// Runs every hour — adjust schedule as needed once you see API usage/costs
function startIngestSchedule() {
  cron.schedule('0 * * * *', runIngestOnce);
  console.log('[ingest] cron scheduled: hourly');
}

module.exports = { startIngestSchedule, runIngestOnce };
