const crypto = require('crypto');
const mongoose = require('mongoose');
const Plan = require('../models/Plan');
const PromoCode = require('../models/PromoCode');
const PaymentOrder = require('../models/PaymentOrder');
const { getIsMongoConnected } = require('../config/db');
const { memoryStore, debouncedSave, saveBackup } = require('../config/memoryStore');
const { sendServerError } = require('../utils/safeError');
const { PAID_PLANS, ensureAllCanonicalPlans } = require('../utils/planDefaults');
const {
  getSystemSettings,
  getPersistedPlans,
  getPersistedPromoCodes,
  savePersistedPromoCodes,
  getPersistedPaymentOrders,
  savePersistedPaymentOrders
} = require('../../utils/getModelConfig');

function getBillingConfigFromSettings(s = {}) {
  const bdtRate = Number(s.usd_to_bdt_rate);
  const usdtRate = Number(s.usd_to_usdt_rate);
  return {
    usd_to_bdt_rate: (!isNaN(bdtRate) && bdtRate > 0) ? Math.round(bdtRate * 100) / 100 : 130,
    usd_to_usdt_rate: (!isNaN(usdtRate) && usdtRate > 0) ? Math.round(usdtRate * 10000) / 10000 : 1,
    direct_crypto: {
      enabled: s.payment_crypto_enabled !== false && s.payment_crypto_enabled !== 'false',
      chains: [
        {
          id: 'BSC (BEP-20)',
          label: 'BNB Smart Chain (BEP-20 / BSC)',
          address: String(s.crypto_bsc_address || '').trim(),
          pay_url: String(s.crypto_bsc_url || '').trim(),
          token: 'USDT'
        },
        {
          id: 'TRC-20',
          label: 'TRON Network (TRC-20)',
          address: String(s.crypto_trc20_address || '').trim(),
          pay_url: String(s.crypto_trc20_url || '').trim(),
          token: 'USDT'
        }
      ]
    },
    binance_pay: {
      enabled: s.payment_binance_enabled !== false && s.payment_binance_enabled !== 'false',
      pay_id: String(s.binance_pay_id || '').trim()
    },
    bybit_pay: {
      enabled: s.payment_bybit_enabled !== false && s.payment_bybit_enabled !== 'false',
      pay_id: String(s.bybit_pay_id || '').trim()
    },
    bkash: {
      enabled: s.payment_bkash_enabled !== false && s.payment_bkash_enabled !== 'false',
      number: String(s.bkash_number || '').trim(),
      account_type: String(s.bkash_account_type || 'Send Money').trim() || 'Send Money'
    }
  };
}

async function getAllActivePlans() {
  let plans = [];
  if (getIsMongoConnected()) {
    const mongoPlans = await Plan.find().lean();
    if (mongoPlans && mongoPlans.length > 0) {
      plans = mongoPlans;
    }
  }
  if (!plans.length) {
    plans = await getPersistedPlans();
  }
  return ensureAllCanonicalPlans(plans).filter(p => p.is_active !== false);
}

async function findPromoDoc(rawCode) {
  const cleanCode = String(rawCode || '').trim().toUpperCase();
  if (!cleanCode) return null;
  if (getIsMongoConnected()) {
    const doc = await PromoCode.findOne({ code: cleanCode }).lean();
    if (doc) return doc;
  }
  const persisted = await getPersistedPromoCodes();
  return (persisted || []).find(p => p && String(p.code || '').trim().toUpperCase() === cleanCode) || null;
}

function validatePromoEligibility(promo, planName) {
  if (!promo) return 'প্রোমো / ডিসকাউন্ট কোডটি সঠিক নয়।';
  if (promo.is_active === false) return 'এই ডিসকাউন্ট কোডটি বর্তমানে বন্ধ রয়েছে।';
  if (promo.expires_at && new Date(promo.expires_at) <= new Date()) {
    return 'এই ডিসকাউন্ট কোডটির মেয়াদ শেষ হয়ে গেছে।';
  }
  const maxUses = Number(promo.max_uses) || 1;
  const useCount = Number(promo.use_count) || 0;
  if (useCount >= maxUses) {
    return 'এই ডিসকাউন্ট কোডটির ব্যবহারের সীমা শেষ হয়ে গেছে।';
  }
  const plansList = Array.isArray(promo.applicable_plans) ? promo.applicable_plans : ['*'];
  if (!plansList.includes('*') && !plansList.includes(planName)) {
    return `এই কোডটি শুধুমাত্র ${plansList.join(', ')} প্ল্যানের জন্য প্রযোজ্য।`;
  }
  return null;
}

function computeOrderQuote({ planDoc, promoDoc, billing, currency, billingCycle = 'monthly' }) {
  const safeCurrency = currency === 'BDT' ? 'BDT' : 'USDT';
  const safeCycle = billingCycle === 'yearly' ? 'yearly' : 'monthly';
  const monthlyUsd = Math.max(0, Number(planDoc && planDoc.price_usd) || 0);
  const rawBaseUsd = safeCycle === 'yearly' ? (monthlyUsd * 12 * 0.8) : monthlyUsd;
  const baseUsd = Math.max(0, Math.round(rawBaseUsd * 100) / 100);
  let discountUsd = 0;
  if (promoDoc) {
    const val = Math.max(0, Number(promoDoc.discount_value) || 0);
    if (promoDoc.discount_type === 'fixed_usd') {
      discountUsd = Math.min(baseUsd, val);
    } else {
      const pct = Math.min(100, val);
      discountUsd = baseUsd * (pct / 100);
    }
    discountUsd = Math.round(discountUsd * 100) / 100;
  }
  const finalUsd = Math.max(0, Math.round((baseUsd - discountUsd) * 100) / 100);
  const exchangeRate = safeCurrency === 'BDT' ? billing.usd_to_bdt_rate : billing.usd_to_usdt_rate;
  const payableAmount = safeCurrency === 'BDT'
    ? Math.round(finalUsd * exchangeRate)
    : Math.round(finalUsd * exchangeRate * 100) / 100;

  return {
    billing_cycle: safeCycle,
    duration_days: safeCycle === 'yearly' ? 365 : 30,
    base_usd: baseUsd,
    discount_usd: discountUsd,
    final_usd: finalUsd,
    currency: safeCurrency,
    exchange_rate: exchangeRate,
    payable_amount: payableAmount
  };
}

const getPaymentConfig = async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const [settings, plans] = await Promise.all([getSystemSettings(), getAllActivePlans()]);
    const billing = getBillingConfigFromSettings(settings);
    const paidPlans = plans
      .filter(p => PAID_PLANS.includes(p.name))
      .map(p => ({
        name: p.name,
        displayName: p.displayName,
        tagline: p.tagline,
        message_limit: p.message_limit,
        window_hours: p.window_hours,
        image_limit: p.image_limit,
        price_usd: p.price_usd,
        price_usdt: Math.round((Number(p.price_usd) || 0) * billing.usd_to_usdt_rate * 100) / 100,
        price_bdt: Math.round((Number(p.price_usd) || 0) * billing.usd_to_bdt_rate),
        legacy_price_bdt: p.price_bdt
      }));

    return res.json({ success: true, billing, plans: paidPlans });
  } catch (error) {
    return sendServerError(res, error, 'পেমেন্ট কনফিগারেশন লোড করতে সমস্যা হয়েছে', '[Payment Config Error]:');
  }
};

const validatePromo = async (req, res) => {
  try {
    const { code, plan_name, currency = 'USDT', billing_cycle = 'monthly' } = req.body || {};
    if (!plan_name || !PAID_PLANS.includes(plan_name)) {
      return res.status(400).json({ success: false, error: `প্ল্যান অবশ্যই ${PAID_PLANS.join(', ')} এর মধ্যে হতে হবে।` });
    }
    if (!code || typeof code !== 'string' || !code.trim()) {
      return res.status(400).json({ success: false, error: 'অনুগ্রহ করে ডিসকাউন্ট / প্রোমো কোড লিখুন।' });
    }

    const [settings, plans, promo] = await Promise.all([
      getSystemSettings(),
      getAllActivePlans(),
      findPromoDoc(code)
    ]);

    const errMsg = validatePromoEligibility(promo, plan_name);
    if (errMsg) {
      return res.status(400).json({ success: false, error: errMsg });
    }

    const planDoc = plans.find(p => p.name === plan_name);
    if (!planDoc) {
      return res.status(404).json({ success: false, error: 'নির্বাচিত প্ল্যান পাওয়া যায়নি।' });
    }

    const billing = getBillingConfigFromSettings(settings);
    const quote = computeOrderQuote({ planDoc, promoDoc: promo, billing, currency, billingCycle: billing_cycle });

    return res.json({
      success: true,
      valid: true,
      promo: {
        code: promo.code,
        discount_type: promo.discount_type,
        discount_value: promo.discount_value
      },
      quote
    });
  } catch (error) {
    return sendServerError(res, error, 'প্রোমো কোড যাচাই করতে সমস্যা হয়েছে', '[Payment Validate Promo Error]:');
  }
};

const submitOrder = async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ success: false, error: 'অর্ডার জমা দিতে আগে লগইন করুন।' });
    }
    const {
      plan_name,
      currency = 'USDT',
      billing_cycle = 'monthly',
      payment_method,
      chain = '',
      promo_code = '',
      sender_account = '',
      trx_id = ''
    } = req.body || {};

    if (!plan_name || !PAID_PLANS.includes(plan_name)) {
      return res.status(400).json({ success: false, error: `প্ল্যান অবশ্যই ${PAID_PLANS.join(', ')} এর মধ্যে হতে হবে।` });
    }
    const cleanCurrency = String(currency || 'USDT').toUpperCase().trim();
    if (!['USDT', 'BDT'].includes(cleanCurrency)) {
      return res.status(400).json({ success: false, error: 'কারেন্সি অবশ্যই USDT অথবা BDT হতে হবে।' });
    }
    const cleanMethod = String(payment_method || '').toLowerCase().trim();
    if (!['direct_crypto', 'binance_pay', 'bybit_pay', 'bkash'].includes(cleanMethod)) {
      return res.status(400).json({ success: false, error: 'সঠিক পেমেন্ট মাধ্যম নির্বাচন করুন।' });
    }

    const cleanChain = String(chain || '').trim();
    if (cleanMethod === 'direct_crypto' && !['BSC (BEP-20)', 'TRC-20'].includes(cleanChain)) {
      return res.status(400).json({ success: false, error: 'Direct Crypto এর জন্য BSC (BEP-20) অথবা TRC-20 চেইন নির্বাচন করুন।' });
    }

    const cleanSender = String(sender_account || '').trim().slice(0, 120);
    const cleanTrxId = String(trx_id || '').trim().slice(0, 140);
    if (cleanSender.length < 2) {
      return res.status(400).json({ success: false, error: 'প্রেরকের নম্বর / ওয়ালেট / পে-আইডি লিখুন।' });
    }
    if (cleanTrxId.length < 4) {
      return res.status(400).json({ success: false, error: 'সঠিক Transaction Hash / TrxID লিখুন (কমপক্ষে ৪ অক্ষর)।' });
    }

    const [settings, plans] = await Promise.all([getSystemSettings(), getAllActivePlans()]);
    const billing = getBillingConfigFromSettings(settings);
    if (cleanMethod === 'direct_crypto' && !billing.direct_crypto.enabled) {
      return res.status(400).json({ success: false, error: 'Direct Crypto পেমেন্ট বর্তমানে বন্ধ রয়েছে।' });
    }
    if (cleanMethod === 'binance_pay' && !billing.binance_pay.enabled) {
      return res.status(400).json({ success: false, error: 'Binance Pay বর্তমানে বন্ধ রয়েছে।' });
    }
    if (cleanMethod === 'bybit_pay' && !billing.bybit_pay.enabled) {
      return res.status(400).json({ success: false, error: 'Bybit Pay বর্তমানে বন্ধ রয়েছে।' });
    }
    if (cleanMethod === 'bkash' && !billing.bkash.enabled) {
      return res.status(400).json({ success: false, error: 'bKash পেমেন্ট বর্তমানে বন্ধ রয়েছে।' });
    }

    const planDoc = plans.find(p => p.name === plan_name);
    if (!planDoc) {
      return res.status(404).json({ success: false, error: 'নির্বাচিত প্ল্যান পাওয়া যায়নি।' });
    }

    // Prevent duplicate TrxID across non-rejected orders
    const normTrxLower = cleanTrxId.toLowerCase();
    if (getIsMongoConnected()) {
      const dup = await PaymentOrder.findOne({
        trx_id: new RegExp(`^${normTrxLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
        payment_method: cleanMethod,
        status: { $ne: 'rejected' }
      }).lean();
      if (dup) {
        return res.status(409).json({ success: false, error: 'এই TrxID / Transaction Hash ইতিমধ্যে একটি অর্ডারে জমা দেওয়া হয়েছে!' });
      }
    } else {
      const existingOrders = await getPersistedPaymentOrders();
      const dup = (existingOrders || []).find(o =>
        o &&
        String(o.payment_method || '').toLowerCase() === cleanMethod &&
        String(o.trx_id || '').trim().toLowerCase() === normTrxLower &&
        o.status !== 'rejected'
      );
      if (dup) {
        return res.status(409).json({ success: false, error: 'এই TrxID / Transaction Hash ইতিমধ্যে একটি অর্ডারে জমা দেওয়া হয়েছে!' });
      }
    }

    let appliedPromo = null;
    let promoClaimedInMongo = false;
    let promoClaimedInMemory = false;
    const cleanPromo = String(promo_code || '').trim().toUpperCase();
    if (cleanPromo) {
      const promoDoc = await findPromoDoc(cleanPromo);
      const errMsg = validatePromoEligibility(promoDoc, plan_name);
      if (errMsg) {
        return res.status(400).json({ success: false, error: errMsg });
      }

      const promoNow = new Date();
      if (getIsMongoConnected()) {
        const claimed = await PromoCode.findOneAndUpdate(
          {
            code: cleanPromo,
            is_active: true,
            use_count: { $lt: Number(promoDoc.max_uses) || 1 },
            $or: [{ expires_at: null }, { expires_at: { $gt: promoNow } }]
          },
          { $inc: { use_count: 1 } },
          { new: true }
        ).lean();
        if (!claimed) {
          return res.status(400).json({ success: false, error: 'ডিসকাউন্ট কোডটি এই মুহূর্তে ব্যবহারযোগ্য নয়।' });
        }
        appliedPromo = claimed;
        promoClaimedInMongo = true;
        try {
          let promos = [...(await getPersistedPromoCodes())];
          const pIdx = promos.findIndex(p => String(p.code || '').toUpperCase() === cleanPromo);
          if (pIdx !== -1) {
            promos[pIdx].use_count = claimed.use_count;
            await savePersistedPromoCodes(promos);
          }
        } catch (e) {}
      } else {
        let promos = [...(await getPersistedPromoCodes())];
        const pIdx = promos.findIndex(p => String(p.code || '').toUpperCase() === cleanPromo);
        if (pIdx === -1) {
          return res.status(400).json({ success: false, error: 'প্রোমো কোড পাওয়া যায়নি।' });
        }
        const maxU = Number(promos[pIdx].max_uses) || 1;
        if ((Number(promos[pIdx].use_count) || 0) >= maxU) {
          return res.status(400).json({ success: false, error: 'এই ডিসকাউন্ট কোডটির ব্যবহারের সীমা শেষ হয়ে গেছে।' });
        }
        promos[pIdx].use_count = (Number(promos[pIdx].use_count) || 0) + 1;
        await savePersistedPromoCodes(promos);
        appliedPromo = promos[pIdx];
        promoClaimedInMemory = true;
      }
    }

    const quote = computeOrderQuote({ planDoc, promoDoc: appliedPromo, billing, currency: cleanCurrency, billingCycle: billing_cycle });
    const orderId = 'ORD-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
    const userId = String(user._id || user.id || '');
    const now = new Date();

    const orderPayload = {
      order_id: orderId,
      user_id: userId,
      user_email: String(user.email || '').toLowerCase().trim(),
      user_name: String(user.name || 'Alora User').trim(),
      plan_name,
      duration_days: quote.duration_days,
      currency: quote.currency,
      payment_method: cleanMethod,
      chain: cleanMethod === 'direct_crypto' ? cleanChain : '',
      base_price_usd: quote.base_usd,
      promo_code: appliedPromo ? appliedPromo.code : '',
      discount_usd: quote.discount_usd,
      final_price_usd: quote.final_usd,
      exchange_rate: quote.exchange_rate,
      payable_amount: quote.payable_amount,
      sender_account: cleanSender,
      trx_id: cleanTrxId,
      status: 'pending',
      admin_note: '',
      reviewed_by: '',
      reviewed_at: null,
      createdAt: now
    };

    if (getIsMongoConnected()) {
      try {
        await PaymentOrder.create(orderPayload);
      } catch (orderErr) {
        if (promoClaimedInMongo && appliedPromo) {
          await PromoCode.updateOne({ code: appliedPromo.code, use_count: { $gt: 0 } }, { $inc: { use_count: -1 } }).catch(() => {});
        }
        if (promoClaimedInMemory && appliedPromo) {
          try {
            let promos = [...(await getPersistedPromoCodes())];
            const pIdx = promos.findIndex(p => String(p.code || '').toUpperCase() === appliedPromo.code);
            if (pIdx !== -1 && (Number(promos[pIdx].use_count) || 0) > 0) {
              promos[pIdx].use_count = Number(promos[pIdx].use_count) - 1;
              await savePersistedPromoCodes(promos);
            }
          } catch {}
        }
        throw orderErr;
      }
    }

    let persistedOrders = (await getPersistedPaymentOrders()).filter(o => o && o.order_id !== orderId);
    persistedOrders.unshift(orderPayload);
    await savePersistedPaymentOrders(persistedOrders);
    debouncedSave();
    await saveBackup();

    return res.status(201).json({
      success: true,
      order: orderPayload,
      message: 'আপনার পেমেন্ট অনুরোধ জমা হয়েছে! অ্যাডমিন যাচাই করে অনুমোদন করলে প্ল্যান ও Verified Paid ব্যাজ চালু হবে।'
    });
  } catch (error) {
    return sendServerError(res, error, 'পেমেন্ট অর্ডার জমা দিতে সমস্যা হয়েছে', '[Payment Submit Error]:');
  }
};

const getMyOrders = async (req, res) => {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ success: false, error: 'অননুমোদিত রিকোয়েস্ট' });
    const userId = String(user._id || user.id || '');
    const userEmail = String(user.email || '').toLowerCase().trim();

    let orders = [];
    if (getIsMongoConnected()) {
      orders = await PaymentOrder.find({
        $or: [{ user_id: userId }, ...(userEmail ? [{ user_email: userEmail }] : [])]
      }).sort({ createdAt: -1 }).lean();
    }
    if (!orders || orders.length === 0) {
      const persisted = await getPersistedPaymentOrders();
      orders = (persisted || []).filter(o =>
        o && (String(o.user_id || '') === userId || (userEmail && String(o.user_email || '').toLowerCase().trim() === userEmail))
      ).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    }

    return res.json({ success: true, orders });
  } catch (error) {
    return sendServerError(res, error, 'অর্ডার তালিকা আনতে সমস্যা হয়েছে', '[My Orders Error]:');
  }
};

module.exports = {
  getBillingConfigFromSettings,
  getPaymentConfig,
  validatePromo,
  submitOrder,
  getMyOrders
};
