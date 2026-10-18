const mongoose = require('mongoose');

// No login system in Herald, so a comment just carries whatever display
// name the commenter typed for that comment — not tied to an account.
const CommentSchema = new mongoose.Schema(
  {
    article: { type: mongoose.Schema.Types.ObjectId, ref: 'Article', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 40 },
    text: { type: String, required: true, trim: true, maxlength: 1000 },
  },
  { timestamps: true }
);

CommentSchema.index({ article: 1, createdAt: -1 });

module.exports = mongoose.model('Comment', CommentSchema);
