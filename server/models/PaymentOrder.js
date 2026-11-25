const mongoose = require('mongoose');

const PaymentOrderSchema = new mongoose.Schema({
  order_id: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  user_id: {
    type: String,
    required: true,
    index: true
  },
  user_email: {
    type: String,
    default: ''
  },
  user_name: {
    type: String,
    default: ''
  },
  plan_name: {
    type: String,
    enum: ['Go', 'Plus', 'Pro', 'Max'],
    required: true
  },
  duration_days: {
    type: Number,
    default: 30
  },
  currency: {
    type: String,
    enum: ['USDT', 'BDT'],
    required: true
  },
  payment_method: {
    type: String,
    enum: ['direct_crypto', 'binance_pay', 'bybit_pay', 'bkash'],
    required: true
  },
  chain: {
    type: String,
    default: ''
  },
  base_price_usd: {
    type: Number,
    required: true,
    min: 0
  },
  promo_code: {
    type: String,
    default: ''
  },
  discount_usd: {
    type: Number,
    default: 0,
    min: 0
  },
  final_price_usd: {
    type: Number,
    required: true,
    min: 0
  },
  exchange_rate: {
    type: Number,
    required: true,
    min: 0.0001
  },
  payable_amount: {
    type: Number,
    required: true,
    min: 0
  },
  sender_account: {
    type: String,
    required: true,
    trim: true
  },
  trx_id: {
    type: String,
    required: true,
    trim: true
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending',
    index: true
  },
  admin_note: {
    type: String,
    default: ''
  },
  reviewed_by: {
    type: String,
    default: ''
  },
  reviewed_at: {
    type: Date,
    default: null
  }
}, { timestamps: true });

PaymentOrderSchema.index({ createdAt: -1 });
PaymentOrderSchema.index({ trx_id: 1, payment_method: 1 });

module.exports = mongoose.model('PaymentOrder', PaymentOrderSchema);
