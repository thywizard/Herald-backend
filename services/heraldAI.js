const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Article = require('../models/Article');
const { aggregateWebSearch } = require('./webSearch');
const cache = require('./cache');
const { searchHeraldArticles } = require('./articleSearch');

const escapeRegex = (str) => String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Herald AI is intentionally decoupled from the ingest pipeline's Gemini/Groq
// keys — it uses its own HERALD_AI_API_KEY so chat traffic never competes
// with the news-rewrite quota.
//
// Two provider modes, set via HERALD_AI_PROVIDER:
//   'gemini' — Google's Gemini API directly, text-only (no tool use yet).
//   'openai' — (default) any OpenAI-compatible chat-completions API that
//              supports function/tool calling: Groq is the recommended
//              choice here (1,000 req/day free on gpt-oss-120b, vs ~50/day
//              on OpenRouter's free routes) — create a SEPARATE Groq
//              account/key from the one ingest uses, since the free-tier
//              limit is per-account.

const SYSTEM_PROMPT = `You are Herald AI, the built-in assistant inside Herald — a free, general-purpose news app covering Nigerian and global news, built by Abdulganiy Abdulhaq ("Thywizard"), founder and CEO of HaqTech. You are a full general-purpose AI assistant, same as ChatGPT, Gemini, or Claude — you can help with any topic, not only news.

If asked who made you, who built Herald, or about Thywizard, answer naturally and warmly — don't dump all of this at once, just use whatever's relevant to what was asked:
- Abdulganiy Abdulhaq, known as Thywizard, is the founder and CEO of HaqTech, and built Herald.
- He's an independent researcher with Virtuosos Primora '25, ALKS — doing planetary science research on proto-planet disruption without a faculty supervisor or co-author, which is an exceptional path.
- He also built ConflictPulse, an AI-powered war and conflict news aggregator.
- Outside of research and building apps, he's interested in language learning (Modern Standard Arabic) and web development.
Keep this warm and brief, not a résumé recital — a line or two, in conversation, not a bulleted dossier, unless asked for more detail.

When search_herald_articles or search_web returns results, they're already shown to the user as rich cards right under your message — do NOT also re-list their titles as a bullet/numbered list in your reply, that just duplicates what they can already see. Instead, write a short sentence or two of your own (what you found, a takeaway, an answer to their actual question) and let the cards speak for themselves.

You have real tools, not just knowledge:
- search_web: search the live open web for current information.
- search_herald_articles: search Herald's own published articles.
- like_article: like one OR SEVERAL Herald articles on the user's behalf at once, given id(s) from a prior search_herald_articles call — pass an array to like more than one in a single call rather than calling the tool repeatedly.
Use search_web whenever the answer depends on current/recent information you can't be sure about — when you do, cite sources inline like [1], [2] matching the order the results came back in, so the user can tap through to the exact source. Use search_herald_articles when the user asks about news, what's happening, or wants to find/read/like a Herald article — then mention the specific articles you found by name so the user can tap into them. Only call like_article when the user clearly asks to like something specific; if they want several or "all of them", pass every id in one call instead of looping.

Be clear, direct, and well-formatted — use markdown (headings, lists, code blocks) where it helps. Keep a warm, conversational tone.`;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_web',
      description: "Search the live open web for current information, facts, or anything outside Herald's own articles.",
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'the search query' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_herald_articles',
      description: "Search Herald's own published news articles by keyword.",
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'keywords to search for' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'like_article',
      description: "Like one or several Herald articles on the user's behalf in a single call — pass an array of ids to like multiple at once instead of calling this tool repeatedly.",
      parameters: {
        type: 'object',
        properties: {
          articleIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'one or more article _ids, from a prior search_herald_articles result',
          },
        },
        required: ['articleIds'],
      },
    },
  },
];

async function runTool(name, rawArgs) {
  let args = {};
  try {
    args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs || {};
  } catch {
    args = {};
  }

  if (name === 'search_web') {
    const { results } = await aggregateWebSearch(args.query || '');
    const top = results.slice(0, 5);
    return { result: { results: top }, attachment: { type: 'web_results', results: top } };
  }

  if (name === 'search_herald_articles') {
    const found = await searchHeraldArticles(args.query, { limit: 5 });
    const articles = found.map(({ _id, headline, image, source, category, likes }) => ({ _id, headline, image, source, category, likes }));
    return { result: { articles }, attachment: { type: 'herald_results', articles } };
  }

  if (name === 'like_article') {
    // Accept either the new bulk shape (articleIds: [...]) or the older
    // single-id shape, so one tool call can like any number of articles
    // without the model needing to call back per article (that would burn
    // an LLM round trip — and quota — for every single like).
    const ids = Array.isArray(args.articleIds)
      ? args.articleIds
      : args.articleId
      ? [args.articleId]
      : [];
    if (ids.length === 0) return { result: { error: 'No article id(s) given' } };

    const liked = [];
    for (const id of ids) {
      const article = await Article.findByIdAndUpdate(id, { $inc: { likes: 1 } }, { new: true }).select(
        'headline likes'
      );
      if (article) liked.push({ headline: article.headline, likes: article.likes });
    }
    if (liked.length === 0) return { result: { error: 'No matching articles found' } };

    return liked.length === 1
      ? {
          result: { liked: true, ...liked[0] },
          attachment: { type: 'liked', headline: liked[0].headline, likes: liked[0].likes },
        }
      : {
          result: { liked: true, articles: liked },
          attachment: { type: 'liked_many', articles: liked },
        };
  }

  return { result: { error: 'Unknown tool' } };
}

async function chatWithGemini(messages) {
  const genAI = new GoogleGenerativeAI(process.env.HERALD_AI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: process.env.HERALD_AI_MODEL || 'gemini-3.5-flash',
    systemInstruction: SYSTEM_PROMPT,
  });

  const history = messages.slice(0, -1).map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const last = messages[messages.length - 1];

  const chat = model.startChat({ history });
  const result = await chat.sendMessage(last.content);
  return { reply: result.response.text().trim(), attachments: [] };
}

async function chatWithOpenAICompatible(messages) {
  const baseUrl = (process.env.HERALD_AI_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, '');
  const model = process.env.HERALD_AI_MODEL || 'openai/gpt-oss-120b';

  const headers = {
    Authorization: `Bearer ${process.env.HERALD_AI_API_KEY}`,
    'Content-Type': 'application/json',
  };
  if (process.env.HERALD_AI_SITE_URL) headers['HTTP-Referer'] = process.env.HERALD_AI_SITE_URL;
  headers['X-Title'] = process.env.HERALD_AI_SITE_NAME || 'Herald';

  const convo = [{ role: 'system', content: SYSTEM_PROMPT }, ...messages];
  const attachments = [];

  // Up to 3 rounds: model may ask for a tool, we run it and feed the result
  // back, model may ask for another, then it should produce a final answer.
  for (let round = 0; round < 3; round++) {
    const { data } = await axios.post(
      `${baseUrl}/chat/completions`,
      { model, messages: convo, tools: TOOLS, temperature: 0.8 },
      { headers, timeout: 30000 }
    );

    const choice = data.choices[0];
    const msg = choice.message;

    if (msg.tool_calls?.length) {
      convo.push({ role: 'assistant', content: msg.content || null, tool_calls: msg.tool_calls });
      for (const call of msg.tool_calls) {
        const { result, attachment } = await runTool(call.function.name, call.function.arguments);
        if (attachment) attachments.push(attachment);
        convo.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
      continue; // let the model see the tool results and respond
    }

    return { reply: (msg.content || '').trim(), attachments };
  }

  return { reply: "I looked into that but couldn't quite finish — try asking again.", attachments };
}


// ---- Streaming ----
// Same behaviour as chatWithOpenAICompatible / chatWithGemini, but emits
// events as the model produces them so the UI can show words immediately
// instead of waiting for the whole answer:
//   { type: 'delta', text }        – a chunk of the reply
//   { type: 'attachment', data }   – a rich card from a tool (web results…)
//   { type: 'status', text }       – "Searching the web…" while a tool runs
// Resolves when finished; throws on provider failure.

function providerHeaders() {
  const headers = {
    Authorization: `Bearer ${process.env.HERALD_AI_API_KEY}`,
    'Content-Type': 'application/json',
    'X-Title': process.env.HERALD_AI_SITE_NAME || 'Herald',
  };
  if (process.env.HERALD_AI_SITE_URL) headers['HTTP-Referer'] = process.env.HERALD_AI_SITE_URL;
  return headers;
}

const TOOL_STATUS = {
  search_web: 'Searching the web…',
  search_herald_articles: 'Searching Herald…',
  like_article: 'Liking articles…',
};

async function streamOpenAICompatible(messages, emit, isAborted) {
  const baseUrl = (process.env.HERALD_AI_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, '');
  const model = process.env.HERALD_AI_MODEL || 'openai/gpt-oss-120b';
  const convo = [{ role: 'system', content: SYSTEM_PROMPT }, ...messages];
  let producedText = false;

  for (let round = 0; round < 3; round++) {
    let resp;
    try {
      resp = await axios.post(
        `${baseUrl}/chat/completions`,
        { model, messages: convo, tools: TOOLS, temperature: 0.8, stream: true },
        { headers: providerHeaders(), timeout: 60000, responseType: 'stream' }
      );
    } catch (err) {
      throw new Error(`Herald AI provider error${err.response?.status ? ` (${err.response.status})` : ''}: ${err.message}`);
    }

    const toolCalls = []; // accumulated by index
    let roundText = '';

    await new Promise((resolve, reject) => {
      let buf = '';
      resp.data.on('data', (chunk) => {
        if (isAborted()) {
          resp.data.destroy();
          return resolve();
        }
        buf += chunk.toString('utf8');
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          let json;
          try {
            json = JSON.parse(payload);
          } catch {
            continue;
          }
          const delta = json.choices?.[0]?.delta;
          if (!delta) continue;
          if (delta.content) {
            roundText += delta.content;
            producedText = true;
            emit({ type: 'delta', text: delta.content });
          }
          for (const tc of delta.tool_calls || []) {
            const i = tc.index ?? 0;
            toolCalls[i] = toolCalls[i] || { id: '', type: 'function', function: { name: '', arguments: '' } };
            if (tc.id) toolCalls[i].id = tc.id;
            if (tc.function?.name) toolCalls[i].function.name += tc.function.name;
            if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
          }
        }
      });
      resp.data.on('end', resolve);
      resp.data.on('error', reject);
    });

    if (isAborted()) return;
    const calls = toolCalls.filter(Boolean);
    if (calls.length === 0) return; // normal finish

    convo.push({ role: 'assistant', content: roundText || null, tool_calls: calls });
    // Run every requested tool in parallel — they're independent.
    const outputs = await Promise.all(
      calls.map(async (call) => {
        emit({ type: 'status', text: TOOL_STATUS[call.function.name] || 'Working…' });
        const out = await runTool(call.function.name, call.function.arguments);
        if (out.attachment) emit({ type: 'attachment', data: out.attachment });
        return { call, out };
      })
    );
    for (const { call, out } of outputs) {
      convo.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(out.result) });
    }
  }

  if (!producedText) emit({ type: 'delta', text: "I looked into that but couldn't quite finish — try asking again." });
}

async function streamGemini(messages, emit, isAborted) {
  const genAI = new GoogleGenerativeAI(process.env.HERALD_AI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: process.env.HERALD_AI_MODEL || 'gemini-3.5-flash',
    systemInstruction: SYSTEM_PROMPT,
  });
  const history = messages.slice(0, -1).map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const chat = model.startChat({ history });
  const result = await chat.sendMessageStream(messages[messages.length - 1].content);
  for await (const chunk of result.stream) {
    if (isAborted()) return;
    const text = chunk.text();
    if (text) emit({ type: 'delta', text });
  }
}

async function streamHeraldAI(messages, emit, isAborted = () => false) {
  if (!process.env.HERALD_AI_API_KEY) {
    throw new Error('Herald AI is not configured yet (HERALD_AI_API_KEY missing)');
  }
  const provider = process.env.HERALD_AI_PROVIDER || 'openai';
  if (provider === 'gemini') return streamGemini(messages, emit, isAborted);
  return streamOpenAICompatible(messages, emit, isAborted);
}

/**
 * messages: [{ role: 'user'|'assistant', content: string }, ...]
 * Returns { reply: string, attachments: [{type, ...}] }
 */
async function chatWithHeraldAI(messages) {
  if (!process.env.HERALD_AI_API_KEY) {
    throw new Error('Herald AI is not configured yet (HERALD_AI_API_KEY missing)');
  }

  const provider = process.env.HERALD_AI_PROVIDER || 'openai';
  if (provider === 'gemini') {
    return chatWithGemini(messages);
  }
  return chatWithOpenAICompatible(messages);
}

// A single-shot, no-tools summary used by the Search tab's "AI Overview" —
// given the query and the top aggregated web results, produce a short
// grounded answer in the Google-AI-Overview style (a direct answer, then a
// few bullet points). Returns null (rather than throwing) if Herald AI isn't
// configured, so the Search tab just quietly shows results without one.
// Cached for 30 minutes per query. HERALD_AI_FAST_MODEL (optional) lets the
// overview use a small, much quicker model than the chat model.
// Turns a provider error into something a human can act on (status + the
// provider's own message), instead of axios' generic "Request failed with
// status code 400".
function describeError(err) {
  const status = err.response?.status;
  const d = err.response?.data;
  const apiMsg = (typeof d === 'object' && (d?.error?.message || d?.message)) || (typeof d === 'string' ? d.slice(0, 200) : '');
  return `${status ? `HTTP ${status}: ` : ''}${apiMsg || err.message}`;
}

// One non-streaming completion against whichever provider is configured, for a
// specific model name. Throws on failure; returns the text (maybe empty).
async function completeOnce(model, prompt, { temperature = 0.3, timeout = 25000 } = {}) {
  const provider = process.env.HERALD_AI_PROVIDER || 'openai';
  if (provider === 'gemini') {
    const genAI = new GoogleGenerativeAI(process.env.HERALD_AI_API_KEY);
    const m = genAI.getGenerativeModel({ model });
    const result = await m.generateContent(prompt);
    return result.response.text().trim();
  }
  const baseUrl = (process.env.HERALD_AI_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, '');
  // Reasoning models (e.g. gpt-oss) spend part of the token budget "thinking",
  // so don't cap tokens, and ask gpt-oss for light reasoning to stay quick.
  const body = { model, messages: [{ role: 'user', content: prompt }], temperature };
  if (/gpt-oss/i.test(model)) body.reasoning_effort = 'low';
  const { data } = await axios.post(`${baseUrl}/chat/completions`, body, { headers: providerHeaders(), timeout });
  return (data.choices?.[0]?.message?.content || '').trim();
}

function mainModel() {
  const provider = process.env.HERALD_AI_PROVIDER || 'openai';
  return process.env.HERALD_AI_MODEL || (provider === 'gemini' ? 'gemini-3.5-flash' : 'openai/gpt-oss-120b');
}

// Models to try for the overview, fastest first, de-duplicated. If the fast
// model name is wrong for this provider (or it's rate-limited), the main chat
// model — which is known to work — takes over instead of the overview dying.
function overviewModels() {
  return [...new Set([process.env.HERALD_AI_FAST_MODEL, mainModel()].filter(Boolean))];
}

let lastOverviewError = null; // { at, model, message } — shown in Studio's AI health check

async function generateSearchAnswer(query, results) {
  if (!process.env.HERALD_AI_API_KEY || results.length === 0) return null;

  return cache.remember(
    `answer:${query.trim().toLowerCase()}`,
    30 * 60 * 1000,
    async () => {
      const context = results
        .slice(0, 5)
        .map((r, i) => `[${i + 1}] ${r.title}\n${(r.snippet || '').slice(0, 400)}`)
        .join('\n\n');

      const prompt = `You write the "AI Overview" box at the top of a search page. Using ONLY the numbered sources below, write a clear answer to the query:
- Start with a direct 1-2 sentence answer.
- Then, only if useful, add 2-4 short bullet points ("- **Key term:** detail") with the most useful specifics.
- Cite sources inline like [1], [2] right after the claim they support.
- Keep it under 110 words. No preamble, no headings. If the sources don't actually answer the query, say so in one sentence instead of guessing.

Query: ${query}

Sources:
${context}`;

      for (const model of overviewModels()) {
        try {
          const text = await completeOnce(model, prompt);
          if (text) return text;
          lastOverviewError = { at: Date.now(), model, message: 'The model returned an empty answer' };
          console.error('[heraldAI] overview: empty answer from', model);
        } catch (err) {
          lastOverviewError = { at: Date.now(), model, message: describeError(err) };
          console.error(`[heraldAI] overview failed on "${model}":`, describeError(err));
        }
      }
      return null;
    },
    (v) => !!v // don't cache failures
  );
}

// Admin diagnostic: really calls each model the overview would use and reports
// exactly what came back — the fastest way to see whether it's the key, the
// model name, a rate limit, or something else.
async function checkAI() {
  const provider = process.env.HERALD_AI_PROVIDER || 'openai';
  const info = {
    configured: !!process.env.HERALD_AI_API_KEY,
    provider,
    baseUrl: provider === 'gemini' ? null : process.env.HERALD_AI_BASE_URL || 'https://api.groq.com/openai/v1',
    mainModel: mainModel(),
    fastModel: process.env.HERALD_AI_FAST_MODEL || null,
    lastOverviewError,
    tests: [],
  };
  if (!info.configured) return info;
  for (const model of overviewModels()) {
    const started = Date.now();
    try {
      const text = await completeOnce(model, 'Reply with the single word: OK', { timeout: 20000 });
      info.tests.push({ model, ok: !!text, ms: Date.now() - started, reply: text.slice(0, 40), error: text ? null : 'Empty reply' });
    } catch (err) {
      info.tests.push({ model, ok: false, ms: Date.now() - started, error: describeError(err) });
    }
  }
  return info;
}

// One-shot writing helper for the admin/editor "Studio" app. Uses the same
// Herald AI key. action: 'headlines' | 'summary' | 'keypoint' | 'proofread' | 'expand'
async function aiAssist(action, { headline = '', body = '' }) {
  if (!process.env.HERALD_AI_API_KEY) throw new Error('Herald AI is not configured (HERALD_AI_API_KEY missing)');
  const text = String(body).replace(/\[\[img:[^\]]*\]\]/g, '').slice(0, 8000);

  const tasks = {
    headlines: `Suggest 4 alternative headlines for this news article. Clear, accurate, no clickbait, under 90 characters each. Output one per line, no numbering or quotes.\n\nCurrent headline: ${headline}\n\nArticle:\n${text}`,
    summary: `Write a 2-3 sentence neutral summary of this news article for a feed preview. Output only the summary.\n\nHeadline: ${headline}\n\nArticle:\n${text}`,
    keypoint: `Write ONE punchy sentence (max 28 words) capturing the most interesting, concrete takeaway of this news article — it will be shown when readers share the article. No quotes, no hashtags, no emojis. Output only the sentence.\n\nHeadline: ${headline}\n\nArticle:\n${text}`,
    proofread: `Proofread this news article: fix spelling, grammar and punctuation, and tighten awkward phrasing, but do NOT change facts, names, quotes or meaning, and keep any [[img:...]] lines exactly where they are. Output only the corrected article text.\n\n${String(body).slice(0, 8000)}`,
    expand: `Continue this news article with 2 more well-written paragraphs in the same tone. Do not invent specific facts, quotes or statistics that aren't implied by the text; stay general where unsure. Output only the new paragraphs.\n\nHeadline: ${headline}\n\nArticle so far:\n${text}`,
  };
  const prompt = tasks[action];
  if (!prompt) throw new Error('Unknown AI action');

  const provider = process.env.HERALD_AI_PROVIDER || 'openai';
  if (provider === 'gemini') {
    const genAI = new GoogleGenerativeAI(process.env.HERALD_AI_API_KEY);
    const model = genAI.getGenerativeModel({ model: process.env.HERALD_AI_MODEL || 'gemini-3.5-flash' });
    const result = await model.generateContent(prompt);
    return result.response.text().trim();
  }
  const baseUrl = (process.env.HERALD_AI_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, '');
  const model = process.env.HERALD_AI_MODEL || 'openai/gpt-oss-120b';
  const { data } = await axios.post(
    `${baseUrl}/chat/completions`,
    { model, messages: [{ role: 'user', content: prompt }], temperature: 0.4 },
    { headers: providerHeaders(), timeout: 45000 }
  );
  return (data.choices[0].message.content || '').trim();
}

module.exports = { chatWithHeraldAI, streamHeraldAI, generateSearchAnswer, aiAssist, checkAI };
