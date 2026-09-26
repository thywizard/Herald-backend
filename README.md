# News App — Backend

## Setup
1. `npm install`
2. Copy `.env.example` to `.env` and fill in your real keys:
   - `MONGODB_URI` — your MongoDB Atlas connection string
   - `GEMINI_API_KEY` — from Google AI Studio
   - `NEWSDATA_API_KEY` — from newsdata.io
   - `AUTO_PUBLISH` — `true` to auto-publish AI-ingested articles immediately, `false` to hold them as `pending` for review
3. `npm run dev` (or `npm start` for production)

## What this does
- Exposes `/api/articles` routes for the frontend (feed, category, search, single article, like/share)
- Exposes `/api/admin` routes for you/editors to write articles directly and manage any article (edit/delete/unpublish)
- Runs an hourly cron job (`cron/ingest.js`) that:
  1. Pulls latest articles per category from NewsData.io
  2. Sends each through Gemini to be **fully rewritten** (not summarized)
  3. Saves to MongoDB, tagged with the original outlet as `source`
  4. Publishes immediately or queues as `pending`, based on `AUTO_PUBLISH`

## Before deploying to Render
- **Add a basic auth check to `/api/admin` routes** — right now anyone who finds the URL could hit them. At minimum, require a shared secret header (`x-admin-key`) checked against an env var. A real login system can come later, but this can't ship without at least that.
- Set all `.env` values as environment variables in Render's dashboard (never commit `.env`)
- Confirm your NewsData.io free-tier rate limit (requests/day) comfortably covers 6 categories × hourly runs — adjust the cron schedule in `cron/ingest.js` if not

## Next steps
- Frontend (Next.js, deployed on Vercel) — consumes these API routes
- Swap the placeholder cron schedule/category list once you've tested real ingest runs
