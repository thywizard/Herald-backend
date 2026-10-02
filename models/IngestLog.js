const mongoose = require('mongoose');

const IngestLogSchema = new mongoose.Schema(
  {
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date },
    durationMs: { type: Number },
    candidatesFound: { type: Number, default: 0 }, // new (non-duplicate) items found across all sources
    added: { type: Number, default: 0 }, // successfully rewritten and saved
    failed: { type: Number, default: 0 }, // attempted but both AI providers failed
    triggeredBy: { type: String, enum: ['cron', 'manual'], default: 'cron' },
    status: { type: String, enum: ['success', 'partial', 'failed'], default: 'success' },
    errorSummary: { type: String }, // short note if status isn't 'success'
  },
  { timestamps: true }
);

module.exports = mongoose.model('IngestLog', IngestLogSchema);
