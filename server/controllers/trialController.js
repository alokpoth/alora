const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { getIsMongoConnected } = require('../config/db');
const { memoryStore, debouncedSave } = require('../config/memoryStore');
const { JWT_SECRET } = require('../config/jwtSecret');
const { invalidateCachedUser } = require('../config/dbCache');
const { PLAN_HIERARCHY, PAID_PLANS } = require('../utils/planDefaults');

// Normalised, public-safe view of the admin-controlled free trial offer.
function buildPromo(settings = {}) {
  const plan = PAID_PLANS.includes(settings.free_trial_plan) ? settings.free_trial_plan : 'Pro';
  const days = Math.floor(Math.min(Math.max(Number(settings.free_trial_days) || 7, 1), 365));
  return {
    enabled: settings.free_trial_enabled === true || settings.free_trial_enabled === 'true',
    plan,
    days,
    label: String(settings.free_trial_label || '').trim().slice(0, 40) || 'Claim offer',
    description: String(settings.free_trial_description || '').trim().slice(0, 200) ||
      `Try ${plan} free for ${days} days`
  };
}

function claimKeysFor(user) {
  const keys = [];
  const id = user && (user._id || user.id);
  if (id) keys.push(String(id));
  if (user && user.email) keys.push(String(user.email).toLowerCase().trim());
  return keys;
}

// GET /api/redeem/promo  (public, optional auth handled client-side)
const getPromo = async (req, res) => {
  try {
    const { getSystemSettings } = require('../../utils/getModelConfig');
    const settings = await getSystemSettings();
    const promo = buildPromo(settings);
    let alreadyClaimed = false;
    if (req.user) {
      const claimed = Array.isArray(settings.free_trial_claimed) ? settings.free_trial_claimed : [];
      alreadyClaimed = claimKeysFor(req.user).some(k => claimed.includes(k));
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ success: true, promo: { ...promo, alreadyClaimed } });
  } catch (error) {
    return res.json({ success: true, promo: { enabled: false } });
  }
};

// POST /api/redeem/trial  (requires login)
const claimFreeTrial = async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ success: false, error: 'Please log in to claim the free trial.' });
    }
    const { getSystemSettings, saveSystemSettings, getPersistedUsers, savePersistedUsers } = require('../../utils/getModelConfig');
    const settings = await getSystemSettings();
    const promo = buildPromo(settings);
    if (!promo.enabled) {
      return res.status(400).json({ success: false, error: 'No free trial offer is available right now.' });
    }

    const claimed = Array.isArray(settings.free_trial_claimed) ? [...settings.free_trial_claimed] : [];
    const keys = claimKeysFor(user);
    if (keys.some(k => claimed.includes(k))) {
      return res.status(400).json({ success: false, error: 'You have already claimed this free trial.' });
    }

    const now = new Date();
    const sub = user.subscription || {};
    const currentTier = PLAN_HIERARCHY[sub.plan_name] || 1;
    const isActivePaid = currentTier > 1 && (!sub.expires_at || new Date(sub.expires_at) > now);
    if (user.role === 'admin' || (isActivePaid && currentTier >= PLAN_HIERARCHY[promo.plan])) {
      return res.status(400).json({ success: false, error: `You already have an active ${sub.plan_name || 'paid'} plan.` });
    }

    const expiresAt = new Date(now.getTime() + promo.days * 24 * 60 * 60 * 1000);
    const subscriptionData = { plan_name: promo.plan, starts_at: now, expires_at: expiresAt, is_active: true, is_trial: true, payment_source: 'trial' };
    const userId = user._id || user.id;
    const email = (user.email || '').toLowerCase().trim();

    // Reserve the claim first so double clicks cannot grant twice.
    claimed.push(...keys);
    await saveSystemSettings({ free_trial_claimed: claimed });

    if (getIsMongoConnected()) {
      const mongoose = require('mongoose');
      const q = mongoose.Types.ObjectId.isValid(userId) ? { _id: userId } : { email };
      await User.updateOne(q, { $set: { subscription: { plan_name: promo.plan, starts_at: now, expires_at: expiresAt, is_active: true, payment_source: 'trial' } } });
    }

    try {
      let users = [...(await getPersistedUsers())];
      const idx = users.findIndex(u => String(u._id || u.id) === String(userId) || (email && u.email && u.email.toLowerCase().trim() === email));
      if (idx !== -1) users[idx].subscription = subscriptionData;
      else users.push({ _id: String(userId), id: String(userId), name: user.name || 'User', email: user.email || '', role: user.role || 'user', is_blocked: false, subscription: subscriptionData, createdAt: now });
      await savePersistedUsers(users);
      if (memoryStore.users) {
        const m = memoryStore.users.find(u => String(u._id || u.id) === String(userId) || (email && u.email && u.email.toLowerCase().trim() === email));
        if (m) m.subscription = subscriptionData;
      }
      debouncedSave();
    } catch (syncErr) {
      console.warn('[Free Trial Sync Warning]:', syncErr.message);
    }

    const { invalidateUserUsageCache, invalidateUsersCache } = require('../../utils/getModelConfig');
    [userId, email].filter(Boolean).forEach(k => {
      invalidateCachedUser(String(k));
      if (typeof invalidateUserUsageCache === 'function') invalidateUserUsageCache(String(k));
    });
    if (typeof invalidateUsersCache === 'function') invalidateUsersCache();

    const token = jwt.sign({
      id: String(userId), role: user.role || 'user', plan: promo.plan,
      expires_at: expiresAt.toISOString(), name: user.name || '', email: user.email || ''
    }, JWT_SECRET, { expiresIn: '30d' });

    return res.json({
      success: true,
      message: `Your ${promo.days}-day ${promo.plan} free trial is now active.`,
      token,
      plan_name: promo.plan,
      duration_days: promo.days,
      expires_at: expiresAt.toISOString(),
      subscription: subscriptionData
    });
  } catch (error) {
    console.error('[Free Trial Error]:', error);
    return res.status(500).json({ success: false, error: 'Could not activate the free trial. Please try again.' });
  }
};

module.exports = { getPromo, claimFreeTrial, buildPromo };
