const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-3.5-flash' });

const PROMPT_TEMPLATE = ({ headline, rawBody, source }) => `You are a news editor. Rewrite the following news article completely in your own words and sentence structure — do not copy phrases from the original. Keep all factual details (names, numbers, places, dates) accurate. Do not summarize or shorten — produce a full-length article. Do not mention that this is a rewrite or reference AI.

Original headline: ${headline}
Original source: ${source}
Original content: ${rawBody}

Respond ONLY in this exact JSON format, no markdown, no extra text:
{"headline": "...", "body": "..."}`;

const REFUSAL_PATTERNS = [
  "i'm sorry",
  'i am sorry',
  "i can't",
  'i cannot',
  "i'm unable",
  'i am unable',
  'unable to comply',
  'without seeing the original',
  'please provide the',
  'please share the',
];

function looksLikeRefusal(text) {
  const lower = text.toLowerCase();
  return REFUSAL_PATTERNS.some((p) => lower.includes(p));
}

function parseJsonResponse(text, sourceLabel) {
  let parsed;
  try {
    const clean = text.replace(/^```json|```$/g, '').trim();
    parsed = JSON.parse(clean);
  } catch (err) {
    throw new Error(`${sourceLabel} response was not valid JSON: ` + text.slice(0, 200));
  }

  const headline = (parsed.headline || '').trim();
  const body = (parsed.body || '').trim();

  if (!headline || headline.length < 10 || looksLikeRefusal(headline)) {
    throw new Error(`${sourceLabel} returned an invalid/refused headline: "${headline.slice(0, 100)}"`);
  }
  if (!body || body.length < 100 || looksLikeRefusal(body.slice(0, 200))) {
    throw new Error(`${sourceLabel} returned an invalid/refused body (length ${body.length})`);
  }

  return { headline, body };
}

/**
 * Fully rewrites a raw scraped article into original wording/structure
 * using Gemini. This is NOT a summary — output should be comparable in
 * length/detail to the source, just expressed independently.
 */
async function rewriteWithGemini(article) {
  const prompt = PROMPT_TEMPLATE(article);
  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  return parseJsonResponse(text, 'Gemini');
}

module.exports = { rewriteWithGemini, PROMPT_TEMPLATE, parseJsonResponse };
