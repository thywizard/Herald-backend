const mongoose = require('mongoose');

const ArticleSchema = new mongoose.Schema(
  {
    headline: { type: String, required: true },
    body: { type: String, required: true }, // full article text (rewritten if AI-sourced)
    image: { type: String, required: true }, // every article must have an image
    category: { type: String, required: true, index: true },
    source: { type: String, required: true }, // attribution — outlet name, or "Staff" / editor name

    // Which pipeline created this article
    origin: {
      type: String,
      enum: ['admin', 'editor', 'ai'],
      required: true,
    },

    // Only relevant for origin: 'ai' — lets you track/audit the pipeline
    sourceUrl: { type: String }, // original scraped article URL, for internal reference only (not shown as "read original")

    status: {
      type: String,
      enum: ['published', 'pending', 'unpublished'],
      default: 'published',
    },

    likes: { type: Number, default: 0 },
    shares: { type: Number, default: 0 },

    isSponsored: { type: Boolean, default: false },
    isPinned: { type: Boolean, default: false }, // admin can force to top of Home
  },
  { timestamps: true } // adds createdAt / updatedAt automatically
);

// Fast lookups for Home feed and Category feed
ArticleSchema.index({ status: 1, createdAt: -1 });
ArticleSchema.index({ category: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('Article', ArticleSchema);
