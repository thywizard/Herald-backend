const Parser = require('rss-parser');
const parser = new Parser({ timeout: 12000 });

// Sources that publish real RSS feeds of written articles.
// AJ+ deliberately excluded — it's video/social-first with no article RSS feed.
//
// `category` is the DEFAULT/fallback category for a source. For general-interest
// Nigerian outlets (Vanguard, Premium Times, Leadership, Channels TV, BusinessDay)
// we instead try to infer a real category per-article from its own RSS
// <category> tags + headline via inferCategory() below, since dumping an
// entire general newspaper feed into one tab was a big part of why some
// tabs (lifestyle, technology) stayed empty while others (world) were
// flooded. `forceCategory: true` sources (Zeteo, Techpoint, BellaNaija)
// skip inference entirely since they're already single-topic outlets.
const RSS_SOURCES = [
  { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml', category: 'world' },
  { name: 'France24', url: 'https://www.france24.com/en/rss', category: 'world' },
  { name: 'Zeteo', url: 'https://zeteo.com/feed', category: 'opinion', forceCategory: true },

  // Nigeria-focused general news — this is the core ask: most of our feed
  // was France24/Zeteo-heavy and barely Nigerian. These are verified-working
  // RSS feeds from major Nigerian outlets.
  { name: 'Vanguard', url: 'https://www.vanguardngr.com/feed/', category: 'world' },
  { name: 'Premium Times', url: 'https://www.premiumtimesng.com/feed', category: 'world' },
  { name: 'Leadership', url: 'https://leadership.ng/feed/', category: 'world' },
  { name: 'Channels TV', url: 'https://www.channelstv.com/feed/', category: 'world' },
  { name: 'BusinessDay', url: 'https://businessday.ng/feed/', category: 'business' },
  { name: 'Daily Post', url: 'https://dailypost.ng/feed/', category: 'world' },
  { name: 'Punch', url: 'https://punchng.com/feed/', category: 'world' },

  // Dedicated single-topic Nigerian outlets — these directly fill the
  // technology and lifestyle tabs that NewsData barely covers for Nigeria.
  { name: 'Techpoint Africa', url: 'https://techpoint.africa/feed/', category: 'technology', forceCategory: true },
  { name: 'BellaNaija', url: 'https://bellanaija.com/feed/', category: 'lifestyle', forceCategory: true },
];

const CATEGORY_KEYWORDS = {
  politics: ['politic', 'senate', 'election', 'president', 'governor', 'apc', 'pdp', 'national assembly', 'tinubu', 'atiku', 'obi', 'lawmaker', 'minister', 'inec'],
  sports: ['sport', 'football', 'afcon', 'premier league', 'athlete', 'olympic', 'nba', 'super eagles', 'uefa', 'basketball', 'tennis'],
  business: ['business', 'economy', 'market', 'naira', 'stock', 'trade', 'finance', 'gdp', 'inflation', 'bank', 'cbn', 'investment', 'oil price'],
  entertainment: ['entertainment', 'music', 'movie', 'nollywood', 'afrobeat', 'celebrity', 'wizkid', 'burna', 'davido', 'bbnaija', 'album', 'film'],
  technology: ['tech', 'startup', 'fintech', ' app ', 'artificial intelligence', ' ai ', 'software', 'gadget', 'smartphone', 'crypto', 'internet'],
  lifestyle: ['lifestyle', 'fashion', 'travel', 'food', 'beauty', 'relationship', 'wellness', 'recipe', 'wedding'],
};

function inferCategory(item, fallback) {
  const haystack = [
    item.title || '',
    ...(Array.isArray(item.categories) ? item.categories : []),
  ]
    .join(' ')
    .toLowerCase();

  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((kw) => haystack.includes(kw))) return cat;
  }
  return fallback;
}

// RSS feeds often embed the image inside the HTML content rather than
// a clean field — this pulls the first <img src="..."> found, if any.
function extractImageFromContent(html) {
  if (!html) return null;
  const match = html.match(/<img[^>]+src="([^">]+)"/i);
  return match ? match[1] : null;
}

/**
 * Fetches latest articles from all configured RSS sources.
 * Returns the same shape as newsFetch.js so both can feed the same
 * rewrite/save pipeline in cron/ingest.js.
 */
// Round-robins per-source arrays so one feed (e.g. a source with 50 items)
// can't dominate the shared ingest queue ahead of smaller feeds.
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

async function fetchRSSArticles() {
  const perSource = [];

  for (const source of RSS_SOURCES) {
    const sourceArticles = [];
    try {
      const feed = await parser.parseURL(source.url);

      for (const item of feed.items) {
        const image =
          item.enclosure?.url ||
          item['media:content']?.['$']?.url ||
          extractImageFromContent(item['content:encoded'] || item.content) ||
          null;

        const category = source.forceCategory ? source.category : inferCategory(item, source.category);

        sourceArticles.push({
          headline: item.title,
          rawBody: item.contentSnippet || item.content || item.summary || '',
          image,
          sourceUrl: item.link,
          source: source.name,
          category,
        });
      }
    } catch (err) {
      console.error(`[rss] error fetching ${source.name}:`, err.message);
      // one source failing shouldn't stop the others
    }
    perSource.push(sourceArticles);
  }

  return interleave(perSource);
}

module.exports = { fetchRSSArticles };
