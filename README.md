# Herald — Backend

## This pass
1. **Fixed Groq 404** — `llama-3.3-70b-versatile` was deprecated by Groq on
   Aug 16, 2026. Switched to `openai/gpt-oss-120b`.
2. **Gemini and Groq now run concurrently, not sequentially.** Previously
   Groq only ever fired as a fallback after Gemini failed on the exact same
   article. Now both pull from the same candidate queue and process
   different articles at the same time — Gemini at its safe 5 RPM pace,
   Groq much faster — roughly doubling+ real throughput per run toward
   your 100/day target. Logs now show `[gemini]` or `[groq]` per line so
   you can see the split.
3. **Cloudinary image upload** — `POST /api/admin/upload-image` (protected,
   multipart). Just set `CLOUDINARY_URL` in Render exactly as Cloudinary
   gives it to you — the SDK auto-configures from that one variable.

## Setup
`npm install`, fill in `.env` from `.env.example` — now includes
`CLOUDINARY_URL` alongside the existing keys. `npm run dev`.

## This pass (addendum)
- **Thin-content filter** — candidates with no real source text (e.g. bare
  SEC filing headlines like "Form 8K X Corp For: 1 October") are now
  skipped before ever attempting a rewrite, instead of wasting a provider
  call on content that can't be rewritten anyway.
- **Refusal/validation guard** — any AI output that's suspiciously short or
  contains refusal phrases ("I'm sorry", "I can't", "unable to comply",
  etc.) is now rejected before saving, instead of silently publishing it.
  This is what let "Unable to comply" get published as a real article
  before — that specific one needs manually deleting from `/admin` once,
  since it was already live before this fix shipped.
