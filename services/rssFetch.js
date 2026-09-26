const Parser = require('rss-parser');
const parser = new Parser();

// Sources that publish real RSS feeds of written articles.
// AJ+ deliberately excluded — it's video/social-first with no article RSS feed.
const RSS_SOURCES = [
  { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml', category: 'world' },
  { name: 'France24', url: 'https://www.france24.com/en/rss', category: 'world' },
  { name: 'Zeteo', url: 'https://zeteo.com/feed', category: 'opinion' },
];

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
async function fetchRSSArticles() {
  const allArticles = [];

  for (const source of RSS_SOURCES) {
    try {
      const feed = await parser.parseURL(source.url);

      for (const item of feed.items) {
        const image =
          item.enclosure?.url ||
          item['media:content']?.['$']?.url ||
          extractImageFromContent(item['content:encoded'] || item.content) ||
          null;

        allArticles.push({
          headline: item.title,
          rawBody: item.contentSnippet || item.content || item.summary || '',
          image,
          sourceUrl: item.link,
          source: source.name,
          category: source.category,
        });
      }
    } catch (err) {
      console.error(`[rss] error fetching ${source.name}:`, err.message);
      // one source failing shouldn't stop the others
    }
  }

  return allArticles;
}

module.exports = { fetchRSSArticles };
