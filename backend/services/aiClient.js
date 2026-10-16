// Single shared Anthropic client + model config, used by both the chat
// assistant (routes/assistant.js) and the generative AI Actions
// (routes/aiActions.js) — extracted so there's one place that reads
// ANTHROPIC_API_KEY / ASSISTANT_MODEL, not two independently-configured
// clients that could silently drift out of sync.

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.ASSISTANT_MODEL || 'claude-sonnet-5';
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

module.exports = { anthropic, MODEL };
