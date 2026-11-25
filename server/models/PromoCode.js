const mongoose = require('mongoose');

const PromoCodeSchema = new mongoose.Schema({
  code: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    trim: true
  },
  discount_type: {
    type: String,
    enum: ['percent', 'fixed_usd'],
    default: 'percent'
  },
  discount_value: {
    type: Number,
    required: true,
    min: 0
  },
  applicable_plans: {
    type: [String],
    default: ['*']
  },
  max_uses: {
    type: Number,
    default: 100,
    min: 1
  },
  use_count: {
    type: Number,
    default: 0,
    min: 0
  },
  expires_at: {
    type: Date,
    default: null
  },
  is_active: {
    type: Boolean,
    default: true
  },
  note: {
    type: String,
    default: ''
  }
}, { timestamps: true });

PromoCodeSchema.index({ is_active: 1 });

module.exports = mongoose.model('PromoCode', PromoCodeSchema);
