const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

/**
 * Fully rewrites a raw scraped article into original wording/structure.
 * This is NOT a summary — output should be comparable in length/detail
 * to the source, just expressed independently.
 */
async function rewriteArticle({ headline, rawBody, source }) {
  const prompt = `You are a news editor. Rewrite the following news article completely in your own words and sentence structure — do not copy phrases from the original. Keep all factual details (names, numbers, places, dates) accurate. Do not summarize or shorten — produce a full-length article. Do not mention that this is a rewrite or reference AI.

Original headline: ${headline}
Original source: ${source}
Original content: ${rawBody}

Respond ONLY in this exact JSON format, no markdown, no extra text:
{"headline": "...", "body": "..."}`;

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();

  try {
    // Strip accidental code fences if the model adds them
    const clean = text.replace(/^```json|```$/g, '').trim();
    return JSON.parse(clean);
  } catch (err) {
    throw new Error('Gemini response was not valid JSON: ' + text.slice(0, 200));
  }
}

module.exports = { rewriteArticle };
