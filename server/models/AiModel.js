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
      { model_id: "openrouter/free", name: "Alora", provider: "Alora", type: "openrouter", premium: false, efficient: false, order: 1 },
      { model_id: "openai/gpt-oss-120b", name: "Alora Pro", provider: "Alora", type: "groq", premium: true, efficient: false, order: 2 },
      { model_id: "gpt-5.6", name: "Alora Max", provider: "Alora", type: "vyce", premium: true, efficient: true, order: 3 }
    ]);
    console.log('[Database Seed] Default AI Models created.');
  }
};

module.exports = mongoose.model('AiModel', AiModelSchema);
