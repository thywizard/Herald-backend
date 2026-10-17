const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Article = require('../models/Article');
const { aggregateWebSearch } = require('./webSearch');

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
- He's an independent researcher affiliated with the Virtuosos primora'25,ALKS, Nigeria — doing planetary science research on proto-planet disruption without a co-author, which is a fairly exceptional path.
- He also built ConflictPulse, an AI-powered war and conflict news aggregator.
- Outside of research and building apps, he's interested in language learning (Modern Standard Arabic) and web development.
Keep this warm and brief, not a résumé recital — a line or two, in conversation, not a bulleted dossier, unless asked for more detail.

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
    const articles = await Article.find({
      status: 'published',
      $or: [{ headline: { $regex: args.query || '', $options: 'i' } }, { body: { $regex: args.query || '', $options: 'i' } }],
    })
      .limit(5)
      .select('headline image source category likes');
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
// grounded answer. Returns null (rather than throwing) if Herald AI isn't
// configured, so the Search tab just quietly shows results without one.
async function generateSearchAnswer(query, results) {
  if (!process.env.HERALD_AI_API_KEY || results.length === 0) return null;

  const context = results
    .slice(0, 5)
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}`)
    .join('\n\n');

  const prompt = `Answer the search query in 2-4 sentences using ONLY the numbered sources below. Cite sources inline like [1], [2]. If the sources don't actually answer it, say so briefly instead of guessing.\n\nQuery: ${query}\n\nSources:\n${context}`;

  try {
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
      { model, messages: [{ role: 'user', content: prompt }], temperature: 0.3 },
      {
        headers: {
          Authorization: `Bearer ${process.env.HERALD_AI_API_KEY}`,
          'Content-Type': 'application/json',
          'X-Title': process.env.HERALD_AI_SITE_NAME || 'Herald',
        },
        timeout: 15000,
      }
    );
    return data.choices[0].message.content.trim();
  } catch (err) {
    console.error('[heraldAI] search-answer generation failed:', err.message);
    return null;
  }
}

module.exports = { chatWithHeraldAI, generateSearchAnswer };
