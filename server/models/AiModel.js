const mongoose = require('mongoose');

const AiModelSchema = new mongoose.Schema({
  model_id: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  provider: { type: String, default: 'Alora' },
  type: { type: String, default: 'custom' },
  base_url: { type: String, default: '' },
  api_key: { type: String, default: '' },
  premium: { type: Boolean, default: false },
  efficient: { type: Boolean, default: false },
  is_active: { type: Boolean, default: true },
  context_window: { type: Number, default: 8192 },
  order: { type: Number, default: 0 },
  // Tier 1: Primary API
  api_model_1: { type: String, default: '' },
  // Tier 2: Fallback API 1
  fallback_url_1: { type: String, default: '' },
  fallback_key_1: { type: String, default: '' },
  fallback_model_1: { type: String, default: '' },
  api_model_2: { type: String, default: '' },
  // Tier 3: Fallback API 2
  fallback_url_2: { type: String, default: '' },
  fallback_key_2: { type: String, default: '' },
  fallback_model_2: { type: String, default: '' },
  api_model_3: { type: String, default: '' }
}, { timestamps: true });

AiModelSchema.index({ order: 1, createdAt: 1 });

AiModelSchema.statics.seedDefaultModels = async function() {
  const count = await this.countDocuments();
  if (count === 0) {
    await this.create([
      {
        model_id: "openrouter/free",
        name: "Alora",
        provider: "Alora",
        type: "openrouter",
        base_url: "https://openrouter.ai/api/v1/chat/completions",
        api_key: process.env.OPENROUTER_API_KEY || "REDACTED_HISTORICAL_OPENROUTER_KEY",
        premium: false,
        efficient: false,
        order: 1,
        api_model_1: "openrouter/free",
        fallback_url_1: "https://api.groq.com/openai/v1/chat/completions",
        fallback_key_1: process.env.GROQ_API_KEY || "REDACTED_HISTORICAL_GROQ_KEY",
        fallback_model_1: "openai/gpt-oss-120b",
        api_model_2: "openai/gpt-oss-120b",
        fallback_url_2: "https://vyceai.com/v1/chat/completions",
        fallback_key_2: process.env.VYCE_API_KEY || "REDACTED_HISTORICAL_OPENAI_KEY",
        fallback_model_2: "gpt-5.6",
        api_model_3: "gpt-5.6"
      },
      {
        model_id: "openai/gpt-oss-120b",
        name: "Alora Pro",
        provider: "Alora",
        type: "groq",
        base_url: "https://api.groq.com/openai/v1/chat/completions",
        api_key: process.env.GROQ_API_KEY || "REDACTED_HISTORICAL_GROQ_KEY",
        premium: true,
        efficient: false,
        order: 2,
        api_model_1: "openai/gpt-oss-120b",
        fallback_url_1: "https://openrouter.ai/api/v1/chat/completions",
        fallback_key_1: process.env.OPENROUTER_API_KEY || "REDACTED_HISTORICAL_OPENROUTER_KEY",
        fallback_model_1: "openrouter/free",
        api_model_2: "openrouter/free",
        fallback_url_2: "https://vyceai.com/v1/chat/completions",
        fallback_key_2: process.env.VYCE_API_KEY || "REDACTED_HISTORICAL_OPENAI_KEY",
        fallback_model_2: "gpt-5.6",
        api_model_3: "gpt-5.6"
      },
      {
        model_id: "gpt-5.6",
        name: "Alora Max",
        provider: "Alora",
        type: "vyce",
        base_url: "https://vyceai.com/v1/chat/completions",
        api_key: process.env.VYCE_API_KEY || "REDACTED_HISTORICAL_OPENAI_KEY",
        premium: true,
        efficient: true,
        order: 3,
        api_model_1: "gpt-5.6",
        fallback_url_1: "https://api.groq.com/openai/v1/chat/completions",
        fallback_key_1: process.env.GROQ_API_KEY || "REDACTED_HISTORICAL_GROQ_KEY",
        fallback_model_1: "openai/gpt-oss-120b",
        api_model_2: "openai/gpt-oss-120b",
        fallback_url_2: "https://openrouter.ai/api/v1/chat/completions",
        fallback_key_2: process.env.OPENROUTER_API_KEY || "REDACTED_HISTORICAL_OPENROUTER_KEY",
        fallback_model_2: "openrouter/free",
        api_model_3: "openrouter/free"
      }
    ]);
    console.log('[Database Seed] Default AI Models created.');
  }
};

module.exports = mongoose.model('AiModel', AiModelSchema);
