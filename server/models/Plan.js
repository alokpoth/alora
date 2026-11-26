const mongoose = require('mongoose');
const { PLAN_ORDER, DEFAULT_PLANS, DEFAULT_PLANS_MAP } = require('../utils/planDefaults');

const PlanSchema = new mongoose.Schema({
  name: {
    type: String,
    enum: PLAN_ORDER,
    required: true,
    unique: true
  },
  displayName: {
    type: String,
    required: true
  },
  message_limit: {
    type: Number,
    required: true
  },
  window_hours: {
    type: Number,
    required: true
  },
  image_limit: {
    type: Number,
    default: function() {
      return (DEFAULT_PLANS_MAP[this.name] && DEFAULT_PLANS_MAP[this.name].image_limit !== undefined)
        ? DEFAULT_PLANS_MAP[this.name].image_limit
        : 0;
    }
  },
  voice_limit: {
    type: Number,
    default: function() {
      return (DEFAULT_PLANS_MAP[this.name] && DEFAULT_PLANS_MAP[this.name].voice_limit !== undefined)
        ? DEFAULT_PLANS_MAP[this.name].voice_limit
        : 0;
    }
  },
  voice_model: {
    type: String,
    default: function() {
      return (DEFAULT_PLANS_MAP[this.name] && DEFAULT_PLANS_MAP[this.name].voice_model) || '';
    }
  },
  image_model: {
    type: String,
    default: function() {
      return (DEFAULT_PLANS_MAP[this.name] && DEFAULT_PLANS_MAP[this.name].image_model) || '';
    }
  },
  price_usd: {
    type: Number,
    default: function() {
      return (DEFAULT_PLANS_MAP[this.name] && DEFAULT_PLANS_MAP[this.name].price_usd !== undefined)
        ? DEFAULT_PLANS_MAP[this.name].price_usd
        : 0;
    }
  },
  price_bdt: {
    type: Number,
    default: function() {
      return (DEFAULT_PLANS_MAP[this.name] && DEFAULT_PLANS_MAP[this.name].price_bdt !== undefined)
        ? DEFAULT_PLANS_MAP[this.name].price_bdt
        : 0;
    }
  },
  tagline: {
    type: String,
    default: function() {
      return (DEFAULT_PLANS_MAP[this.name] && DEFAULT_PLANS_MAP[this.name].tagline) || '';
    }
  },
  allowed_models: [{
    type: String
  }],
  is_active: {
    type: Boolean,
    default: true
  }
}, { timestamps: true });

PlanSchema.index({ name: 1, is_active: 1 });

// Seed any missing canonical plans without overwriting existing custom limits
PlanSchema.statics.seedDefaultPlans = async function() {
  let created = 0;
  for (const def of DEFAULT_PLANS) {
    const exists = await this.exists({ name: def.name });
    if (!exists) {
      await this.create(def);
      created++;
    }
  }
  if (created > 0) {
    console.log(`[Database Seed] Seeded ${created} missing subscription plans (${PLAN_ORDER.join(', ')}).`);
  }
};

module.exports = mongoose.model('Plan', PlanSchema);
