const cron = require('node-cron');
const Article = require('../models/Article');
const IngestLog = require('../models/IngestLog');
const { fetchLatestArticles } = require('../services/newsFetch');
const { fetchRSSArticles } = require('../services/rssFetch');
const { rewriteWithGemini } = require('../services/geminiRewrite');
const { rewriteWithGroq } = require('../services/groqRewrite');

const CATEGORIES = ['politics', 'sports', 'business', 'entertainment', 'world', 'technology'];
const MAX_ARTICLES_PER_RUN = 190;

// No single request — fetch or AI rewrite — is allowed to hang forever.
// This is what caused the multi-day freeze before: one stuck call blocked
// the whole run, and the "already running" flag never reset.
const REWRITE_TIMEOUT_MS = 20000;
const FETCH_TIMEOUT_MS = 15000;

// Gemini (5 RPM on this project) and Groq (much higher) now work the
// SAME queue at the SAME time, each at its own safe pace, instead of
// Groq only ever being a fallback after Gemini fails on one article.
// This roughly doubles+ real throughput per run.
const GEMINI_SPACING_MS = 13000; // 60/13 ≈ 4.6 calls/min, safely under 5 RPM
const GROQ_SPACING_MS = 2500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)),
  ]);
}

function interleave(arrays) {
  const result = [];
  const max = Math.max(...arrays.map((a) => a.length), 0);
  for (let i = 0; i < max; i++) {
    for (const arr of arrays) {
      if (arr[i]) result.push(arr[i]);
    }
  }
  return result;
}

let isRunning = false;

async function runIngestOnce(triggeredBy = 'cron') {
  if (isRunning) {
    console.log('[ingest] previous run still in progress — skipping this trigger');
    return;
  }
  isRunning = true;

  try {
    await doIngestRun(triggeredBy);
  } finally {
    isRunning = false;
  }
}

async function doIngestRun(triggeredBy) {
  const startedAt = new Date();
  console.log('[ingest] starting run...');
  const autoPublish = process.env.AUTO_PUBLISH === 'true';

  let added = 0;
  let failed = 0;
  let candidatesCount = 0;
  let errorSummary = '';

  try {
    const fetchedGroups = [];

    for (const category of CATEGORIES) {
      try {
        const raw = await withTimeout(fetchLatestArticles({ category }), FETCH_TIMEOUT_MS, `NewsData "${category}" fetch`);
        fetchedGroups.push(raw);
      } catch (err) {
        console.error(`[ingest] error fetching NewsData category "${category}":`, err.message);
        fetchedGroups.push([]);
      }
    }

    try {
      const rssArticles = await withTimeout(fetchRSSArticles(), FETCH_TIMEOUT_MS, 'RSS fetch');
      fetchedGroups.push(rssArticles);
    } catch (err) {
      console.error('[ingest] error fetching RSS:', err.message);
      fetchedGroups.push([]);
    }

    const MIN_RAW_BODY_LENGTH = 80; // below this, there's nothing real to rewrite (e.g. bare SEC filing headlines)

    const candidates = [];
    let skippedThin = 0;
    for (const raw of interleave(fetchedGroups)) {
      if (!raw.image || !raw.headline || !raw.sourceUrl) continue;
      if (!raw.rawBody || raw.rawBody.trim().length < MIN_RAW_BODY_LENGTH) {
        skippedThin++;
        continue;
      }
      const exists = await Article.findOne({ sourceUrl: raw.sourceUrl });
      if (exists) continue;
      candidates.push(raw);
    }
    if (skippedThin > 0) {
      console.log(`[ingest] skipped ${skippedThin} candidates with no real source content to rewrite`);
    }
    candidatesCount = candidates.length;

    console.log(`[ingest] ${candidates.length} new candidates found across all sources`);

    // Shared queue pointer — safe without a lock because JS only runs one
    // synchronous block at a time; the increment always completes before
    // either worker's next `await`.
    let queueIndex = 0;
    let processedTotal = 0;

    function nextCandidate() {
      if (queueIndex >= candidates.length || processedTotal >= MAX_ARTICLES_PER_RUN) return null;
      processedTotal++;
      return candidates[queueIndex++];
    }

    async function saveArticle(raw, rewritten, provider) {
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
      added++;
      console.log(`[ingest] saved (${provider}): "${rewritten.headline}" (${autoPublish ? 'published' : 'pending'})`);
    }

    async function geminiWorker() {
      while (true) {
        const raw = nextCandidate();
        if (!raw) break;
        try {
          const rewritten = await withTimeout(
            rewriteWithGemini({ headline: raw.headline, rawBody: raw.rawBody, source: raw.source }),
            REWRITE_TIMEOUT_MS,
            'Gemini rewrite'
          );
          await saveArticle(raw, rewritten, 'gemini');
        } catch (err) {
          failed++;
          console.error(`[ingest][gemini] error on "${raw.headline}":`, err.message);
        }
        await sleep(GEMINI_SPACING_MS);
      }
    }

    async function groqWorker() {
      while (true) {
        const raw = nextCandidate();
        if (!raw) break;
        try {
          const rewritten = await withTimeout(
            rewriteWithGroq({ headline: raw.headline, rawBody: raw.rawBody, source: raw.source }),
            REWRITE_TIMEOUT_MS,
            'Groq rewrite'
          );
          await saveArticle(raw, rewritten, 'groq');
        } catch (err) {
          failed++;
          console.error(`[ingest][groq] error on "${raw.headline}":`, err.message);
        }
        await sleep(GROQ_SPACING_MS);
      }
    }

    // Both run concurrently against the same shared queue.
    await Promise.all([geminiWorker(), groqWorker()]);

    console.log(`[ingest] run complete. Processed ${processedTotal}/${candidates.length} candidates.`);
  } catch (err) {
    errorSummary = err.message;
    console.error('[ingest] run failed unexpectedly:', err.message);
  }

  const finishedAt = new Date();
  const status = errorSummary ? 'failed' : failed > 0 && added > 0 ? 'partial' : failed > 0 ? 'failed' : 'success';

  try {
    await IngestLog.create({
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      candidatesFound: candidatesCount,
      added,
      failed,
      triggeredBy,
      status,
      errorSummary: errorSummary || undefined,
    });
  } catch (logErr) {
    console.error('[ingest] failed to write ingest log:', logErr.message);
  }
}

function startIngestSchedule() {
  cron.schedule('0 * * * *', () => runIngestOnce('cron'));
  console.log('[ingest] cron scheduled: hourly');
}

module.exports = { startIngestSchedule, runIngestOnce };
