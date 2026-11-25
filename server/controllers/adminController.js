const User = require('../models/User');
const Plan = require('../models/Plan');
const RedeemCode = require('../models/RedeemCode');
const UsageLog = require('../models/UsageLog');
const AiModel = require('../models/AiModel');
const { getIsMongoConnected } = require('../config/db');
const { memoryStore, debouncedSave, saveBackup } = require('../config/memoryStore');
const supabase = require('../config/supabase');
const { invalidateModelKeyCache, invalidateUsersCache, invalidateUserUsageCache } = require('../../utils/getModelConfig');
const { invalidateCachedUser, invalidateCachedPlans, invalidateCachedModels } = require('../config/dbCache');
const { sendServerError, redactSecrets } = require('../utils/safeError');

const SUPER_ADMIN_EMAILS = ['zihanfakir@gmail.com', 'x@zihan.uk'];
const isSuperAdminEmail = (email) => !!email && SUPER_ADMIN_EMAILS.includes(String(email).toLowerCase().trim());

// Supabase তে api_key upsert করার helper
async function upsertApiKeyToSupabase(modelId, apiKey) {
  if (!supabase || !modelId) return;
  try {
    const { error } = await supabase
      .from('api_keys')
      .upsert({ model_id: modelId, api_key: apiKey || '', updated_at: new Date().toISOString() }, { onConflict: 'model_id' });
    if (error) console.error('[Supabase] api_key upsert error:', error.message);
    else {
      invalidateModelKeyCache(modelId); // Cache clear করো
      invalidateCachedModels();
      console.log(`[Supabase] api_key saved for model: ${modelId}`);
    }
  } catch (e) {
    console.error('[Supabase] api_key upsert exception:', e.message);
  }
}

const getAdminStats = async (req, res) => {
  try {
    const now = new Date();
    if (getIsMongoConnected()) {
      // High-performance metadata counts (O(1)) and covered index scans
      const [totalUsers, proUsers, maxUsers, totalRedeemCodes, usedRedeemCodes, totalMessages] = await Promise.all([
        User.estimatedDocumentCount(),
        User.countDocuments({
          'subscription.plan_name': 'Pro',
          $or: [{ 'subscription.expires_at': null }, { 'subscription.expires_at': { $gt: now } }]
        }),
        User.countDocuments({
          'subscription.plan_name': 'Max',
          $or: [{ 'subscription.expires_at': null }, { 'subscription.expires_at': { $gt: now } }]
        }),
        RedeemCode.estimatedDocumentCount(),
        RedeemCode.countDocuments({ is_used: true }),
        UsageLog.estimatedDocumentCount()
      ]);

      const stats = {
        totalUsers,
        total_users: totalUsers,
        proUsers,
        pro_users: proUsers,
        maxUsers,
        max_users: maxUsers,
        totalRedeemCodes,
        total_codes: totalRedeemCodes,
        total_redeem_codes: totalRedeemCodes,
        usedRedeemCodes,
        used_codes: usedRedeemCodes,
        used_redeem_codes: usedRedeemCodes,
        availableRedeemCodes: totalRedeemCodes - usedRedeemCodes,
        totalMessages,
        total_messages: totalMessages,
        mongo_connected: true,
        server_uptime: Math.floor(process.uptime())
      };
      return res.json({ success: true, stats });
    } else {
      const { getPersistedUsers, getPersistedRedeemCodes } = require('../../utils/getModelConfig');
      const persistedUsers = await getPersistedUsers();
      const totalUsers = persistedUsers.length;
      const proUsers = persistedUsers.filter(u => u.subscription && u.subscription.plan_name === 'Pro' && (!u.subscription.expires_at || new Date(u.subscription.expires_at) > now)).length;
      const maxUsers = persistedUsers.filter(u => u.subscription && u.subscription.plan_name === 'Max' && (!u.subscription.expires_at || new Date(u.subscription.expires_at) > now)).length;
      const persistedCodes = await getPersistedRedeemCodes();
      const totalRedeemCodes = persistedCodes.length;
      const usedRedeemCodes = persistedCodes.filter(c => c.is_used).length;
      const totalMessages = memoryStore.usageLogs.length;

      const stats = {
        totalUsers,
        total_users: totalUsers,
        proUsers,
        pro_users: proUsers,
        maxUsers,
        max_users: maxUsers,
        totalRedeemCodes,
        total_codes: totalRedeemCodes,
        total_redeem_codes: totalRedeemCodes,
        usedRedeemCodes,
        used_codes: usedRedeemCodes,
        used_redeem_codes: usedRedeemCodes,
        availableRedeemCodes: totalRedeemCodes - usedRedeemCodes,
        totalMessages,
        total_messages: totalMessages,
        total_messages_capped: totalMessages >= 5000,
        mongo_connected: false,
        server_uptime: Math.floor(process.uptime())
      };
      return res.json({ success: true, stats });
    }
  } catch (error) {
    return sendServerError(res, error, 'Internal server error', '[Admin Error]:');
  }
};

const getUsers = async (req, res) => {
  try {
    if (getIsMongoConnected()) {
      const users = await User.find().select('-password').sort({ createdAt: -1 }).lean();
      return res.json({ success: true, count: users.length, users });
    } else {
      const { getPersistedUsers } = require('../../utils/getModelConfig');
      const persistedUsers = await getPersistedUsers();
      const users = persistedUsers.map(({ password, ...u }) => u);
      return res.json({ success: true, count: users.length, users });
    }
  } catch (error) {
    return sendServerError(res, error, 'Internal server error', '[Admin Error]:');
  }
};

const updateUserPlan = async (req, res) => {
  try {
    const { userId } = req.params;
    const { plan_name, duration_days = 30 } = req.body;
    // A missing/blank plan_name must be rejected: defaulting to 'Free' silently revoked paid plans.
    if (!['Free', 'Pro', 'Max'].includes(plan_name)) {
      return res.status(400).json({ success: false, error: 'প্ল্যান অবশ্যই Free, Pro অথবা Max হতে হবে' });
    }

    const days = Math.floor(Math.min(Math.max(Number(duration_days) || 30, 1), 3650));
    const now = new Date();
    let expiresAt = null;
    if (plan_name && plan_name !== 'Free') {
      expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    }

    const cleanTarget = String(userId).toLowerCase().trim();
    if (isSuperAdminEmail(cleanTarget) && plan_name !== 'Max') {
      return res.status(400).json({ success: false, error: 'মূল অ্যাডমিন অ্যাকাউন্টের প্ল্যান পরিবর্তন বা ডাউনগ্রেড করা সম্ভব নয়।' });
    }

    if (getIsMongoConnected()) {
      const mongoose = require('mongoose');
      const user = mongoose.Types.ObjectId.isValid(userId)
        ? await User.findById(userId)
        : await User.findOne({ email: cleanTarget });
      if (!user) {
        return res.status(404).json({ success: false, error: 'ইউজার পাওয়া যায়নি।' });
      }

      if (isSuperAdminEmail(user.email) && plan_name !== 'Max') {
        return res.status(400).json({ success: false, error: 'মূল অ্যাডমিন অ্যাকাউন্টের প্ল্যান পরিবর্তন বা ডাউনগ্রেড করা সম্ভব নয়।' });
      }

      user.subscription = {
        plan_name: plan_name || 'Free',
        starts_at: now,
        expires_at: expiresAt,
        is_active: true
      };

      await user.save();

      // Multi-store sync to Supabase __users_metadata__ and memoryStore.users
      try {
        const { getPersistedUsers, savePersistedUsers } = require('../../utils/getModelConfig');
        let users = await getPersistedUsers();
        users = [...users];
        const pUser = users.find(u => String(u._id) === String(user._id) || String(u.id) === String(user._id) || (u.email && u.email.toLowerCase().trim() === user.email.toLowerCase().trim()));
        if (pUser) {
          pUser.subscription = user.subscription;
          await savePersistedUsers(users);
        } else {
          users.push({
            _id: String(user._id),
            id: String(user._id),
            name: user.name,
            email: user.email,
            role: user.role,
            is_blocked: user.is_blocked || false,
            subscription: user.subscription,
            createdAt: user.createdAt
          });
          await savePersistedUsers(users);
        }
        if (memoryStore.users) {
          const mUser = memoryStore.users.find(u => String(u._id) === String(user._id) || String(u.id) === String(user._id) || (u.email && u.email.toLowerCase().trim() === user.email.toLowerCase().trim()));
          if (mUser) mUser.subscription = user.subscription;
        }
        debouncedSave();
      } catch (syncErr) {
        console.warn('[Admin updateUserPlan Sync Warning]:', syncErr.message);
      }

      invalidateCachedUser(userId);
      if (user._id) invalidateCachedUser(String(user._id));
      if (user.id) invalidateCachedUser(String(user.id));
      if (user.email) invalidateCachedUser(user.email);
      if (typeof invalidateUsersCache === 'function') invalidateUsersCache();
      if (typeof invalidateUserUsageCache === 'function') {
        invalidateUserUsageCache(userId);
        if (user._id) invalidateUserUsageCache(String(user._id));
        if (user.id) invalidateUserUsageCache(String(user.id));
        if (user.email) invalidateUserUsageCache(user.email);
      }

      return res.json({
        success: true,
        message: `${user.name}-এর প্ল্যান ${plan_name} করা হয়েছে (${days} দিন)।`,
        subscription: user.subscription
      });
    } else {
      const { getPersistedUsers, savePersistedUsers } = require('../../utils/getModelConfig');
      let users = await getPersistedUsers();
      users = [...users];
      const user = users.find(u => String(u._id) === String(userId) || String(u.id) === String(userId) || (u.email && u.email.toLowerCase().trim() === cleanTarget));
      if (!user) {
        return res.status(404).json({ success: false, error: 'ইউজার পাওয়া যায়নি।' });
      }

      if (isSuperAdminEmail(user.email) && plan_name !== 'Max') {
        return res.status(400).json({ success: false, error: 'মূল অ্যাডমিন অ্যাকাউন্টের প্ল্যান পরিবর্তন বা ডাউনগ্রেড করা সম্ভব নয়।' });
      }

      user.subscription = {
        plan_name: plan_name || 'Free',
        starts_at: now,
        expires_at: expiresAt,
        is_active: true
      };
      await savePersistedUsers(users);
      debouncedSave();

      invalidateCachedUser(userId);
      if (user._id) invalidateCachedUser(String(user._id));
      if (user.id) invalidateCachedUser(String(user.id));
      if (user.email) invalidateCachedUser(user.email);
      if (typeof invalidateUsersCache === 'function') invalidateUsersCache();
      if (typeof invalidateUserUsageCache === 'function') {
        invalidateUserUsageCache(userId);
        if (user._id) invalidateUserUsageCache(String(user._id));
        if (user.id) invalidateUserUsageCache(String(user.id));
        if (user.email) invalidateUserUsageCache(user.email);
      }

      return res.json({
        success: true,
        message: `${user.name}-এর প্ল্যান ${plan_name} করা হয়েছে (${days} দিন)।`,
        subscription: user.subscription
      });
    }
  } catch (error) {
    return sendServerError(res, error, 'Internal server error', '[Admin Error]:');
  }
};


const updateUserRole = async (req, res) => {
  try {
    const { userId } = req.params;
    const { role } = req.body;
    if (!role || !['user', 'admin'].includes(role)) {
      return res.status(400).json({ success: false, error: 'রোল অবশ্যই user অথবা admin হতে হবে' });
    }

    const cleanTarget = String(userId).toLowerCase().trim();
    if (isSuperAdminEmail(cleanTarget) && role !== 'admin') {
      return res.status(400).json({ success: false, error: 'মূল সুপার অ্যাডমিন অ্যাকাউন্টের রোল পরিবর্তন করা সম্ভব নয়।' });
    }

    if (getIsMongoConnected()) {
      const mongoose = require('mongoose');
      const user = mongoose.Types.ObjectId.isValid(userId)
        ? await User.findById(userId)
        : await User.findOne({ email: cleanTarget });
      if (!user) {
        return res.status(404).json({ success: false, error: 'ইউজার পাওয়া যায়নি।' });
      }

      if (isSuperAdminEmail(user.email) && role !== 'admin') {
        return res.status(400).json({ success: false, error: 'মূল সুপার অ্যাডমিন অ্যাকাউন্টের রোল পরিবর্তন করা সম্ভব নয়।' });
      }

      user.role = role;
      await user.save();

      try {
        const { getPersistedUsers, savePersistedUsers } = require('../../utils/getModelConfig');
        let users = await getPersistedUsers();
        users = [...users];
        const pUser = users.find(u => String(u._id) === String(user._id) || String(u.id) === String(user._id) || (u.email && u.email.toLowerCase().trim() === user.email.toLowerCase().trim()));
        if (pUser) {
          pUser.role = role;
          await savePersistedUsers(users);
        }
        if (memoryStore.users) {
          const mUser = memoryStore.users.find(u => String(u._id) === String(user._id) || String(u.id) === String(user._id) || (u.email && u.email.toLowerCase().trim() === user.email.toLowerCase().trim()));
          if (mUser) mUser.role = role;
        }
        debouncedSave();
      } catch (e) {}

      invalidateCachedUser(userId);
      if (user._id) invalidateCachedUser(String(user._id));
      if (user.id) invalidateCachedUser(String(user.id));
      if (user.email) invalidateCachedUser(user.email);
      if (typeof invalidateUsersCache === 'function') invalidateUsersCache();

      return res.json({
        success: true,
        message: `${user.name}-এর রোল '${role}' নির্ধারণ করা হয়েছে।`,
        role: user.role
      });
    } else {
      const { getPersistedUsers, savePersistedUsers } = require('../../utils/getModelConfig');
      let users = await getPersistedUsers();
      users = [...users];
      const user = users.find(u => String(u._id) === String(userId) || String(u.id) === String(userId) || (u.email && u.email.toLowerCase().trim() === cleanTarget));
      if (!user) {
        return res.status(404).json({ success: false, error: 'ইউজার পাওয়া যায়নি।' });
      }

      if (isSuperAdminEmail(user.email) && role !== 'admin') {
        return res.status(400).json({ success: false, error: 'মূল সুপার অ্যাডমিন অ্যাকাউন্টের রোল পরিবর্তন করা সম্ভব নয়।' });
      }

      user.role = role;
      await savePersistedUsers(users);
      debouncedSave();

      invalidateCachedUser(userId);
      if (user._id) invalidateCachedUser(String(user._id));
      if (user.id) invalidateCachedUser(String(user.id));
      if (user.email) invalidateCachedUser(user.email);
      if (typeof invalidateUsersCache === 'function') invalidateUsersCache();

      return res.json({
        success: true,
        message: `${user.name}-এর রোল '${role}' নির্ধারণ করা হয়েছে।`,
        role: user.role
      });
    }
  } catch (error) {
    return sendServerError(res, error, 'Internal server error', '[Admin Error]:');
  }
};

const toggleBlockUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const { is_blocked } = req.body;
    const cleanTarget = String(userId).toLowerCase().trim();
    const requesterId = String((req.user && (req.user._id || req.user.id)) || '').toLowerCase().trim();

    // Only the TARGET account may block the operation: a super-admin account, or the requester blocking themselves.
    if (isSuperAdminEmail(cleanTarget) || (requesterId && cleanTarget === requesterId)) {
      return res.status(400).json({ success: false, error: 'মূল অ্যাডমিন অ্যাকাউন্ট ব্লক করা সম্ভব নয়।' });
    }

    if (getIsMongoConnected()) {
      const mongoose = require('mongoose');
      const user = mongoose.Types.ObjectId.isValid(userId)
        ? await User.findById(userId)
        : await User.findOne({ email: cleanTarget });
      if (!user) {
        return res.status(404).json({ success: false, error: 'ইউজার পাওয়া যায়নি।' });
      }

      if (isSuperAdminEmail(user.email)) {
        return res.status(400).json({ success: false, error: 'মূল অ্যাডমিন অ্যাকাউন্ট ব্লক করা সম্ভব নয়।' });
      }

      user.is_blocked = is_blocked !== undefined ? Boolean(is_blocked) : !user.is_blocked;
      await user.save();

      // Multi-store sync to Supabase __users_metadata__ and memoryStore.users
      try {
        const { getPersistedUsers, savePersistedUsers } = require('../../utils/getModelConfig');
        let users = await getPersistedUsers();
        users = [...users];
        const pUser = users.find(u => String(u._id) === String(user._id) || String(u.id) === String(user._id) || (u.email && u.email.toLowerCase().trim() === user.email.toLowerCase().trim()));
        if (pUser) {
          pUser.is_blocked = user.is_blocked;
          await savePersistedUsers(users);
        }
        if (memoryStore.users) {
          const mUser = memoryStore.users.find(u => String(u._id) === String(user._id) || String(u.id) === String(user._id) || (u.email && u.email.toLowerCase().trim() === user.email.toLowerCase().trim()));
          if (mUser) mUser.is_blocked = user.is_blocked;
        }
        debouncedSave();
      } catch (syncErr) {
        console.warn('[Admin toggleBlockUser Sync Warning]:', syncErr.message);
      }

      invalidateCachedUser(userId);
      if (user._id) invalidateCachedUser(String(user._id));
      if (user.id) invalidateCachedUser(String(user.id));
      if (user.email) invalidateCachedUser(user.email);
      if (typeof invalidateUsersCache === 'function') invalidateUsersCache();

      return res.json({
        success: true,
        message: `ইউজার ${user.is_blocked ? 'ব্লক' : 'আনব্লক'} করা হয়েছে।`,
        is_blocked: user.is_blocked
      });
    } else {
      const { getPersistedUsers, savePersistedUsers } = require('../../utils/getModelConfig');
      let users = await getPersistedUsers();
      users = [...users];
      const user = users.find(u => String(u._id) === String(userId) || String(u.id) === String(userId) || (u.email && u.email.toLowerCase().trim() === cleanTarget));
      if (!user) {
        return res.status(404).json({ success: false, error: 'ইউজার পাওয়া যায়নি।' });
      }

      if (isSuperAdminEmail(user.email)) {
        return res.status(400).json({ success: false, error: 'মূল অ্যাডমিন অ্যাকাউন্ট ব্লক করা সম্ভব নয়।' });
      }

      user.is_blocked = is_blocked !== undefined ? Boolean(is_blocked) : !user.is_blocked;
      await savePersistedUsers(users);
      debouncedSave();

      invalidateCachedUser(userId);
      if (user._id) invalidateCachedUser(String(user._id));
      if (user.id) invalidateCachedUser(String(user.id));
      if (user.email) invalidateCachedUser(user.email);
      if (typeof invalidateUsersCache === 'function') invalidateUsersCache();

      return res.json({
        success: true,
        message: `ইউজার ${user.is_blocked ? 'ব্লক' : 'আনব্লক'} করা হয়েছে।`,
        is_blocked: user.is_blocked
      });
    }
  } catch (error) {
    return sendServerError(res, error, 'Internal server error', '[Admin Error]:');
  }
};

const deleteUser = async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId || typeof userId !== 'string' || !userId.trim()) {
      return res.status(400).json({ success: false, error: 'সঠিক ইউজার আইডি প্রদান করুন' });
    }
    const cleanTarget = String(userId).toLowerCase().trim();

    const isSelfTarget = Boolean(req.user && (
      cleanTarget === String(req.user._id || '').toLowerCase() ||
      cleanTarget === String(req.user.id || '').toLowerCase() ||
      (req.user.email && cleanTarget === String(req.user.email).toLowerCase().trim())
    ));
    if (isSuperAdminEmail(cleanTarget) || isSelfTarget) {
      return res.status(400).json({ success: false, error: 'মূল অ্যাডমিন অ্যাকাউন্ট মুছে ফেলা সম্ভব নয়।' });
    }

    let targetId = String(userId);
    let targetEmail = '';

    // 1. If Mongo connected, purge user, sessions, and usage logs
    if (getIsMongoConnected()) {
      const mongoose = require('mongoose');
      const UsageLog = require('../models/UsageLog');

      const queryOr = [{ email: cleanTarget }];
      if (mongoose.Types.ObjectId.isValid(userId)) {
        queryOr.push({ _id: userId });
      }
      queryOr.push({ id: userId });

      const existingUser = await User.findOne({ $or: queryOr });

      if (existingUser && isSuperAdminEmail(existingUser.email)) {
        return res.status(400).json({ success: false, error: 'মূল অ্যাডমিন অ্যাকাউন্ট মুছে ফেলা সম্ভব নয়।' });
      }

      if (existingUser) {
        targetId = String(existingUser._id);
        if (existingUser.email) targetEmail = existingUser.email.toLowerCase().trim();
      }

      await User.deleteMany({ $or: queryOr }).catch(() => {});
      if (targetEmail) {
        await User.deleteMany({ email: targetEmail }).catch(() => {});
      }
      await UsageLog.deleteMany({ $or: [{ user_id: targetId }, { user_id: userId }] }).catch(() => {});
    }

    // Helper matcher to purge across stores
    const matchesTarget = u => {
      if (!u) return false;
      const uId = String(u._id || u.id || '');
      if (uId === String(userId) || uId === String(targetId)) return true;
      if (u.email) {
        const uEmail = u.email.toLowerCase().trim();
        if (uEmail === cleanTarget || (targetEmail && uEmail === targetEmail)) return true;
      }
      return false;
    };

    // 2. ALWAYS purge from Supabase __users_metadata__
    const { getPersistedUsers, savePersistedUsers, invalidateUsersCache } = require('../../utils/getModelConfig');
    let users = await getPersistedUsers();
    const targetUser = users.find(matchesTarget);
    if (targetUser && isSuperAdminEmail(targetUser.email)) {
      return res.status(400).json({ success: false, error: 'মূল অ্যাডমিন অ্যাকাউন্ট মুছে ফেলা সম্ভব নয়।' });
    }
    users = users.filter(u => !matchesTarget(u));
    await savePersistedUsers(users);
    invalidateUsersCache();

    // 3. Purge user usage quota rows from Supabase api_keys table (by userId AND targetId AND email)
    if (supabase) {
      try {
        await supabase.from('api_keys').delete().eq('model_id', `__usage_${userId}__`);
        await supabase.from('api_keys').delete().eq('model_id', `__img_usage_${userId}__`);
        if (targetId !== userId) {
          await supabase.from('api_keys').delete().eq('model_id', `__usage_${targetId}__`);
          await supabase.from('api_keys').delete().eq('model_id', `__img_usage_${targetId}__`);
        }
        // Also purge by email-based key patterns in case new registrations would match
        if (targetEmail) {
          await supabase.from('api_keys').delete().eq('model_id', `__usage_${targetEmail}__`);
          await supabase.from('api_keys').delete().eq('model_id', `__img_usage_${targetEmail}__`);
          // Purge any profile or quota rows with email as key
          await supabase.from('api_keys').delete().eq('model_id', `__profile_${targetEmail}__`);
        }
      } catch (e) {
        console.warn('[Supabase] Usage row purge warning:', e.message);
      }
    }

    // 4. ALWAYS purge from memoryStore and write synchronously to disk
    if (memoryStore.users) {
      memoryStore.users = memoryStore.users.filter(u => !matchesTarget(u));
    }
    if (memoryStore.usageLogs) {
      memoryStore.usageLogs = memoryStore.usageLogs.filter(l => String(l.user_id) !== String(userId) && String(l.user_id) !== String(targetId));
    }

    // 5. Deep auto-purge orphaned caches & references
    const { autoPurgeOrphanedDatabaseCaches, invalidateUserUsageCache } = require('../../utils/getModelConfig');
    await autoPurgeOrphanedDatabaseCaches().catch(() => {});

    invalidateCachedUser(userId);
    if (targetId && targetId !== userId) invalidateCachedUser(targetId);
    if (targetEmail) invalidateCachedUser(targetEmail);
    if (typeof invalidateUserUsageCache === 'function') {
      invalidateUserUsageCache(userId);
      if (targetId) invalidateUserUsageCache(targetId);
      if (targetEmail) invalidateUserUsageCache(targetEmail);
    }

    return res.json({ success: true, message: 'ইউজার অ্যাকাউন্ট ডাটাবেস থেকে সম্পূর্ণ মুছে ফেলা হয়েছে।' });
  } catch (error) {
    return sendServerError(res, error, 'Internal server error', '[Admin Error]:');
  }
};

const getPlans = async (req, res) => {
  try {
    let rawPlans;
    if (getIsMongoConnected()) {
      rawPlans = await Plan.find().lean();
    } else {
      const { getPersistedPlans } = require('../../utils/getModelConfig');
      rawPlans = await getPersistedPlans();
    }
    const plans = (rawPlans || []).map(p => {
      const obj = { ...p };
      obj.image_limit = (obj.image_limit !== undefined && obj.image_limit !== null && !isNaN(Number(obj.image_limit)))
        ? Number(obj.image_limit)
        : (obj.name === 'Free' ? 5 : (obj.name === 'Pro' ? 25 : 100));
      return obj;
    });
    return res.json({ success: true, count: plans.length, plans });
  } catch (error) {
    return sendServerError(res, error, 'Internal server error', '[Admin Error]:');
  }
};

const updatePlanLimits = async (req, res) => {
  try {
    const { planName } = req.params;
    if (!planName || !['Free', 'Pro', 'Max'].includes(planName)) {
      return res.status(400).json({ success: false, error: 'সঠিক প্ল্যানের নাম দিন (Free, Pro, Max)' });
    }
    const { message_limit, window_hours, image_limit, displayName, allowed_models, is_active } = req.body;

    let validLimit = undefined;
    if (message_limit !== undefined) {
      const n = parseInt(message_limit, 10);
      if (isNaN(n) || n < 1 || n > 1000000) return res.status(400).json({ success: false, error: 'বার্তা সীমা ১ থেকে ১০,০০,০০০ এর মধ্যে হতে হবে।' });
      validLimit = n;
    }

    let validWindow = undefined;
    if (window_hours !== undefined) {
      const n = parseInt(window_hours, 10);
      if (isNaN(n) || n < 1 || n > 168) return res.status(400).json({ success: false, error: 'উইন্ডো সময় ১ থেকে ১৬৮ ঘণ্টার মধ্যে হতে হবে।' });
      validWindow = n;
    }

    let validImageLimit = undefined;
    if (image_limit !== undefined) {
      const n = parseInt(image_limit, 10);
      if (isNaN(n) || n < 0 || n > 100000) return res.status(400).json({ success: false, error: 'ছবি তৈরির সীমা ০ থেকে ১,০০,০০০ এর মধ্যে হতে হবে।' });
      validImageLimit = n;
    }

    let validDisplayName = undefined;
    if (displayName && typeof displayName === 'string' && displayName.trim()) {
      validDisplayName = displayName.trim().slice(0, 50);
    }

    let validModels = undefined;
    if (allowed_models !== undefined) {
      if (Array.isArray(allowed_models)) {
        validModels = allowed_models.map(m => String(m).trim()).filter(Boolean);
      } else if (typeof allowed_models === 'string') {
        validModels = allowed_models.split(',').map(m => m.trim()).filter(Boolean);
      }
    }

    if (getIsMongoConnected()) {
      let plan = await Plan.findOne({ name: planName });
      if (!plan) {
        // If not in Mongo yet, create it from default
        const defaultNames = { Free: 'ফ্রি প্ল্যান', Pro: 'প্রো প্ল্যান', Max: 'ম্যাক্স প্ল্যান' };
        plan = await Plan.create({
          name: planName,
          displayName: validDisplayName || defaultNames[planName] || (planName + ' প্ল্যান'),
          message_limit: validLimit !== undefined ? validLimit : 10,
          window_hours: validWindow !== undefined ? validWindow : 3,
          image_limit: validImageLimit !== undefined ? validImageLimit : (planName === 'Free' ? 5 : (planName === 'Pro' ? 25 : 100)),
          allowed_models: validModels || ['*'],
          is_active: true
        });
      }

      if (validLimit !== undefined) plan.message_limit = validLimit;
      if (validWindow !== undefined) plan.window_hours = validWindow;
      if (validImageLimit !== undefined) plan.image_limit = validImageLimit;
      if (validDisplayName !== undefined) plan.displayName = validDisplayName;
      if (validModels !== undefined) plan.allowed_models = validModels;
      if (is_active !== undefined) {
        const activeBool = is_active === true || is_active === 'true' || is_active === 1 || is_active === '1';
        plan.is_active = activeBool;
      }

      await plan.save();
      try {
        const { getPersistedPlans, savePersistedPlans, invalidatePlansCache } = require('../../utils/getModelConfig');
        let plans = await getPersistedPlans();
        plans = JSON.parse(JSON.stringify(plans));
        const pIdx = plans.findIndex(p => p.name === planName);
        if (pIdx !== -1) {
          if (validLimit !== undefined) plans[pIdx].message_limit = validLimit;
          if (validWindow !== undefined) plans[pIdx].window_hours = validWindow;
          if (validImageLimit !== undefined) plans[pIdx].image_limit = validImageLimit;
          if (validDisplayName !== undefined) plans[pIdx].displayName = validDisplayName;
          if (validModels !== undefined) plans[pIdx].allowed_models = validModels;
          if (is_active !== undefined) {
            const activeBool = is_active === true || is_active === 'true' || is_active === 1 || is_active === '1';
            plans[pIdx].is_active = activeBool;
          }
        } else {
          plans.push({
            name: plan.name,
            displayName: plan.displayName,
            message_limit: plan.message_limit,
            window_hours: plan.window_hours,
            image_limit: plan.image_limit !== undefined ? plan.image_limit : 3,
            allowed_models: plan.allowed_models || ['*'],
            is_active: plan.is_active !== false
          });
        }
        await savePersistedPlans(plans);
        if (typeof invalidatePlansCache === 'function') invalidatePlansCache();
        invalidateCachedPlans();
        debouncedSave();
      } catch (syncErr) {
        console.warn('[updatePlanLimits Supabase sync warn]:', syncErr.message);
      }
      invalidateCachedPlans();

      return res.json({
        success: true,
        message: `${plan.name} প্ল্যানের লিমিট সফলভাবে আপডেট করা হয়েছে।`,
        plan
      });
    } else {
      const { getPersistedPlans, savePersistedPlans, invalidatePlansCache } = require('../../utils/getModelConfig');
      let plans = await getPersistedPlans();
      plans = JSON.parse(JSON.stringify(plans));
      let plan = plans.find(p => p.name === planName);
      if (!plan) {
        const defaultNames = { Free: 'ফ্রি প্ল্যান', Pro: 'প্রো প্ল্যান', Max: 'ম্যাক্স প্ল্যান' };
        plan = {
          name: planName,
          displayName: validDisplayName || defaultNames[planName] || (planName + ' প্ল্যান'),
          message_limit: validLimit !== undefined ? validLimit : 10,
          window_hours: validWindow !== undefined ? validWindow : 3,
          image_limit: validImageLimit !== undefined ? validImageLimit : (planName === 'Free' ? 5 : (planName === 'Pro' ? 25 : 100)),
          allowed_models: validModels || ['*'],
          is_active: true
        };
        plans.push(plan);
      }

      if (validLimit !== undefined) plan.message_limit = validLimit;
      if (validWindow !== undefined) plan.window_hours = validWindow;
      if (validImageLimit !== undefined) plan.image_limit = validImageLimit;
      if (validDisplayName !== undefined) plan.displayName = validDisplayName;
      if (validModels !== undefined) plan.allowed_models = validModels;
      if (is_active !== undefined) {
        const activeBool = is_active === true || is_active === 'true' || is_active === 1 || is_active === '1';
        plan.is_active = activeBool;
      }

      await savePersistedPlans(plans);
      if (typeof invalidatePlansCache === 'function') invalidatePlansCache();
      invalidateCachedPlans();
      debouncedSave();

      return res.json({
        success: true,
        message: `${plan.name} প্ল্যানের লিমিট সফলভাবে আপডেট করা হয়েছে।`,
        plan
      });
    }
  } catch (error) {
    return sendServerError(res, error, 'Internal server error', '[Admin Error]:');
  }
};

const generateRandomCode = (planName) => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let rand = '';
  for (let i = 0; i < 12; i++) {
    rand += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `ALO-${planName.toUpperCase()}-${rand}`;
};

const generateRedeemCodes = async (req, res) => {
  try {
    const { plan_name, count = 1, duration_days = 30 } = req.body;
    if (!['Pro', 'Max'].includes(plan_name)) {
      return res.status(400).json({ success: false, error: 'প্ল্যান অবশ্যই Pro অথবা Max হতে হবে' });
    }

    const createdCodes = [];
    const numToCreate = Math.floor(Math.min(Math.max(Number(count) || 1, 1), 100));
    const validDurationDays = Math.floor(Math.min(Math.max(Number(duration_days) || 30, 1), 3650));

    if (getIsMongoConnected()) {
      for (let i = 0; i < numToCreate; i++) {
        let codeStr = generateRandomCode(plan_name);
        let attempts = 0;
        while (await RedeemCode.exists({ code: codeStr })) {
          attempts++;
          if (attempts > 30) { codeStr += '-' + Date.now().toString(36); break; }
          codeStr = generateRandomCode(plan_name);
        }
        const codeDoc = await RedeemCode.create({
          code: codeStr,
          plan_name,
          duration_days: validDurationDays,
          created_by: req.user._id || req.user.id
        });
        createdCodes.push(codeDoc);
      }

      try {
        const { getPersistedRedeemCodes, savePersistedRedeemCodes } = require('../../utils/getModelConfig');
        let currentCodes = await getPersistedRedeemCodes();
        currentCodes = [...currentCodes, ...createdCodes.map(c => ({
          _id: String(c._id),
          code: c.code,
          plan_name: c.plan_name,
          duration_days: c.duration_days,
          is_used: false,
          used_by: null,
          used_at: null,
          createdAt: c.createdAt
        }))];
        await savePersistedRedeemCodes(currentCodes);
        debouncedSave();
      } catch {}
    } else {
      const { getPersistedRedeemCodes, savePersistedRedeemCodes } = require('../../utils/getModelConfig');
      let currentCodes = await getPersistedRedeemCodes();
      currentCodes = [...currentCodes];

      for (let i = 0; i < numToCreate; i++) {
        let codeStr = generateRandomCode(plan_name);
        let attempts = 0;
        while (currentCodes.some(c => c.code === codeStr)) {
          attempts++;
          if (attempts > 30) { codeStr += '-' + Date.now().toString(36); break; }
          codeStr = generateRandomCode(plan_name);
        }
        const codeDoc = {
          _id: 'code_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          code: codeStr,
          plan_name,
          duration_days: validDurationDays,
          is_used: false,
          used_by: null,
          used_at: null,
          createdAt: new Date()
        };
        currentCodes.push(codeDoc);
        createdCodes.push(codeDoc);
      }
      // Save all generated codes once
      await savePersistedRedeemCodes(currentCodes);
      debouncedSave();
    }

    res.status(201).json({
      success: true,
      message: `${createdCodes.length}টি ${plan_name} রিডিম কোড সফলভাবে জেনারেট করা হয়েছে।`,
      codes: createdCodes
    });
  } catch (error) {
    return sendServerError(res, error, 'Internal server error', '[Admin Error]:');
  }
};

const getRedeemCodes = async (req, res) => {
  try {
    if (getIsMongoConnected()) {
      const codes = await RedeemCode.find()
        .populate({ path: 'used_by', model: 'User', select: 'name email', strictPopulate: false })
        .sort({ createdAt: -1 })
        .lean();
      return res.json({ success: true, count: codes.length, codes });
    } else {
      const { getPersistedRedeemCodes, getPersistedUsers } = require('../../utils/getModelConfig');
      const persisted = await getPersistedRedeemCodes();
      const users = await getPersistedUsers();
      const codes = persisted.map(c => {
        let used_by = c.used_by;
        if (typeof used_by === 'string') {
          const u = users.find(usr => String(usr._id || usr.id) === String(used_by));
          if (u) used_by = { name: u.name, email: u.email };
        }
        return { ...c, used_by };
      });
      return res.json({ success: true, count: codes.length, codes });
    }
  } catch (error) {
    return sendServerError(res, error, 'Internal server error', '[Admin Error]:');
  }
};

const deleteRedeemCode = async (req, res) => {
  try {
    const { codeId } = req.params;
    if (!codeId || typeof codeId !== 'string' || !codeId.trim()) {
      return res.status(400).json({ success: false, error: 'সঠিক রিডিম কোড আইডি প্রদান করুন' });
    }
    const cleanId = String(codeId).trim().toUpperCase();
    let codeStrToFilter = cleanId;

    // 1. If Mongo connected, purge from MongoDB
    if (getIsMongoConnected()) {
      const mongoose = require('mongoose');
      const queryList = [{ code: cleanId }];
      if (mongoose.Types.ObjectId.isValid(codeId)) {
        const found = await RedeemCode.findById(codeId);
        if (found && found.code) {
          codeStrToFilter = String(found.code).trim().toUpperCase();
          queryList.push({ code: codeStrToFilter });
        }
        queryList.push({ _id: codeId });
      }
      await RedeemCode.deleteMany({ $or: queryList }).catch(() => {});
    }

    // 2. ALWAYS purge from Supabase __redeem_codes__
    const { getPersistedRedeemCodes, savePersistedRedeemCodes, invalidateRedeemCodesCache } = require('../../utils/getModelConfig');
    let codes = await getPersistedRedeemCodes();
    codes = codes.filter(c => String(c._id) !== String(codeId) && String(c.code).trim().toUpperCase() !== cleanId && String(c.code).trim().toUpperCase() !== codeStrToFilter);
    await savePersistedRedeemCodes(codes);
    invalidateRedeemCodesCache();

    // 3. ALWAYS purge from memoryStore and persist synchronously to backup disk
    if (memoryStore.redeemCodes) {
      memoryStore.redeemCodes = memoryStore.redeemCodes.filter(c => String(c._id) !== String(codeId) && String(c.code).trim().toUpperCase() !== cleanId && String(c.code).trim().toUpperCase() !== codeStrToFilter);
    }
    
    // 4. Deep auto-purge orphaned caches & references
    const { autoPurgeOrphanedDatabaseCaches } = require('../../utils/getModelConfig');
    await autoPurgeOrphanedDatabaseCaches().catch(() => {});

    res.json({ success: true, message: 'রিডিম কোডটি ডাটাবেস থেকে সম্পূর্ণ মুছে ফেলা হয়েছে।' });
  } catch (error) {
    return sendServerError(res, error, 'Internal server error', '[Admin Error]:');
  }
};

const createCustomRedeemCode = async (req, res) => {
  try {
    const { custom_code, plan_name, duration_days = 30, max_uses = 10 } = req.body;
    
    if (!custom_code || typeof custom_code !== 'string' || !custom_code.trim()) {
      return res.status(400).json({ success: false, error: 'কাস্টম রিডিম কোড অবশ্যই লিখতে হবে' });
    }
    if (!['Pro', 'Max'].includes(plan_name)) {
      return res.status(400).json({ success: false, error: 'প্ল্যান অবশ্যই Pro অথবা Max হতে হবে' });
    }
    
    const cleanCode = custom_code.trim().toUpperCase();
    if (cleanCode.length < 3 || cleanCode.length > 50) {
      return res.status(400).json({ success: false, error: 'কাস্টম কোড ৩ থেকে ৫০ অক্ষরের মধ্যে হতে হবে' });
    }
    
    const validDuration = Math.floor(Math.min(Math.max(Number(duration_days) || 30, 1), 3650));
    const validMaxUses = Math.floor(Math.min(Math.max(Number(max_uses) || 10, 1), 100000));
    
    if (getIsMongoConnected()) {
      const existing = await RedeemCode.findOne({ code: cleanCode });
      if (existing) {
        return res.status(400).json({ success: false, error: 'এই কোডটি ইতিমধ্যে বিদ্যমান আছে!' });
      }
      
      const codeDoc = await RedeemCode.create({
        code: cleanCode,
        plan_name,
        duration_days: validDuration,
        is_used: false,
        is_custom: true,
        max_uses: validMaxUses,
        use_count: 0,
        used_by_list: [],
        created_by: req.user._id || req.user.id
      });
      
      // Sync to Supabase
      try {
        const { getPersistedRedeemCodes, savePersistedRedeemCodes } = require('../../utils/getModelConfig');
        let currentCodes = await getPersistedRedeemCodes();
        currentCodes = [...currentCodes, {
          _id: String(codeDoc._id),
          code: cleanCode,
          plan_name,
          duration_days: validDuration,
          is_used: false,
          is_custom: true,
          max_uses: validMaxUses,
          use_count: 0,
          used_by_list: [],
          used_by: null,
          used_at: null,
          createdAt: codeDoc.createdAt
        }];
        await savePersistedRedeemCodes(currentCodes);
        debouncedSave();
      } catch {}
      
      return res.status(201).json({
        success: true,
        message: `কাস্টম রিডিম কোড "${cleanCode}" সফলভাবে তৈরি হয়েছে (সর্বোচ্চ ${validMaxUses} জন ব্যবহার করতে পারবে)।`,
        code: codeDoc
      });
    } else {
      const { getPersistedRedeemCodes, savePersistedRedeemCodes } = require('../../utils/getModelConfig');
      let currentCodes = await getPersistedRedeemCodes();
      
      if (currentCodes.some(c => c.code === cleanCode)) {
        return res.status(400).json({ success: false, error: 'এই কোডটি ইতিমধ্যে বিদ্যমান আছে!' });
      }
      
      const codeDoc = {
        _id: 'custom_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        code: cleanCode,
        plan_name,
        duration_days: validDuration,
        is_used: false,
        is_custom: true,
        max_uses: validMaxUses,
        use_count: 0,
        used_by_list: [],
        used_by: null,
        used_at: null,
        createdAt: new Date()
      };
      
      currentCodes = [...currentCodes, codeDoc];
      await savePersistedRedeemCodes(currentCodes);
      debouncedSave();
      
      return res.status(201).json({
        success: true,
        message: `কাস্টম রিডিম কোড "${cleanCode}" সফলভাবে তৈরি হয়েছে (সর্বোচ্চ ${validMaxUses} জন ব্যবহার করতে পারবে)।`,
        code: codeDoc
      });
    }
  } catch (error) {
    return sendServerError(res, error, 'Internal server error', '[Admin Error]:');
  }
};

const getModels = async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    const { getPersistedModels, getApiKeyFromSupabase, getDeletedModelIds } = require('../../utils/getModelConfig');
    const deletedSet = await getDeletedModelIds();

    let models = [];
    if (getIsMongoConnected()) {
      models = await AiModel.find().sort({ order: 1 }).lean();
    } else {
      models = await getPersistedModels();
    }
    models = [...models].filter(m => {
      if (!m) return false;
      const mId = String(m.id || m.model_id || '').toLowerCase().trim();
      const mName = String(m.name || '').toLowerCase().trim();
      return !deletedSet.has(mId) && !deletedSet.has(mName);
    });

    // Ensure api_key and all 3 API tier fields are populated for all models
    for (let m of models) {
      const mId = m.id || m.model_id;
      if (!m.api_key) {
        const k = await getApiKeyFromSupabase(mId);
        if (k) m.api_key = k;
      }
      m.api_model_1 = m.api_model_1 || m.model_id || m.id || '';
      m.fallback_url_1 = m.fallback_url_1 || '';
      m.fallback_key_1 = m.fallback_key_1 || '';
      m.fallback_model_1 = m.fallback_model_1 || m.api_model_2 || '';
      m.api_model_2 = m.api_model_2 || m.fallback_model_1 || '';
      m.fallback_url_2 = m.fallback_url_2 || '';
      m.fallback_key_2 = m.fallback_key_2 || '';
      m.fallback_model_2 = m.fallback_model_2 || m.api_model_3 || '';
      m.api_model_3 = m.api_model_3 || m.fallback_model_2 || '';
      m.is_active = m.is_active !== undefined ? Boolean(m.is_active) : true;
      m.context_window = m.context_window !== undefined && !isNaN(Number(m.context_window)) ? Number(m.context_window) : 8192;
    }

    const sorted = models.sort((a, b) => (a.order || 0) - (b.order || 0));
    return res.json({ success: true, models: sorted });
  } catch (error) {
    return sendServerError(res, error, 'Internal server error', '[Admin Error]:');
  }
};

const normalizeBaseUrl = (url) => {
  if (!url || typeof url !== 'string') return '';
  let trimmed = url.trim();
  if (!trimmed) return '';
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) return '';
  if (
    trimmed.includes(':streamGenerateContent') ||
    trimmed.includes(':generateContent') ||
    trimmed.includes('/v1/messages') ||
    trimmed.includes('/models/')
  ) {
    return trimmed;
  }
  trimmed = trimmed.replace(/\/+$/, '');
  if (!trimmed.endsWith('/chat/completions')) {
    if (trimmed.endsWith('/completions')) {
      trimmed = trimmed.replace(/\/completions$/, '/chat/completions');
    } else {
      trimmed = trimmed + '/chat/completions';
    }
  }
  return trimmed;
};

const updateModel = async (req, res) => {
  try {
    let { modelId } = req.params;
    try { modelId = decodeURIComponent(modelId); } catch {}
    const {
      premium, efficient, name, description, provider, type, is_active, context_window, order,
      base_url, api_key, clear_api_key, api_model_1,
      fallback_url_1, fallback_key_1, fallback_model_1, api_model_2, clear_fallback_key_1,
      fallback_url_2, fallback_key_2, fallback_model_2, api_model_3, clear_fallback_key_2
    } = req.body;

    const effPremium = premium !== undefined ? (premium === true || premium === 'true' || premium === 1 || premium === '1') : undefined;
    const effEfficient = efficient !== undefined ? (efficient === true || efficient === 'true' || efficient === 1 || efficient === '1') : undefined;
    const cleanIsActive = is_active !== undefined ? (is_active === true || is_active === 'true' || is_active === 1 || is_active === '1') : undefined;
    const cleanContext = (context_window !== undefined && !isNaN(Number(context_window)) && Number(context_window) > 0) ? Number(context_window) : undefined;
    const cleanOrder = (order !== undefined && !isNaN(Number(order))) ? Number(order) : undefined;
    const cleanProvider = (typeof provider === 'string' && provider.trim()) ? provider.trim().slice(0, 50) : undefined;
    const cleanType = (typeof type === 'string' && type.trim()) ? type.trim().slice(0, 50) : undefined;
    const cleanDesc = description !== undefined ? String(description || '').trim().slice(0, 300) : undefined;

    const hasValidKey = typeof api_key === 'string' && api_key.trim().length > 0;
    const shouldClearKey = clear_api_key === true || (typeof api_key === 'string' && api_key.trim() === '');
    const cleanBaseUrl = base_url !== undefined ? normalizeBaseUrl(base_url) : undefined;
    const cleanApiModel1 = api_model_1 !== undefined ? String(api_model_1).trim() : undefined;

    const cleanFbUrl1 = fallback_url_1 !== undefined ? (fallback_url_1.trim() ? normalizeBaseUrl(fallback_url_1) : '') : undefined;
    const cleanFbModel1 = (api_model_2 !== undefined || fallback_model_1 !== undefined)
      ? String(api_model_2 !== undefined ? api_model_2 : fallback_model_1).trim()
      : undefined;
    const hasFbKey1 = typeof fallback_key_1 === 'string' && fallback_key_1.trim().length > 0;
    const shouldClearFbKey1 = clear_fallback_key_1 === true || (typeof fallback_key_1 === 'string' && fallback_key_1.trim() === '');

    const cleanFbUrl2 = fallback_url_2 !== undefined ? (fallback_url_2.trim() ? normalizeBaseUrl(fallback_url_2) : '') : undefined;
    const cleanFbModel2 = (api_model_3 !== undefined || fallback_model_2 !== undefined)
      ? String(api_model_3 !== undefined ? api_model_3 : fallback_model_2).trim()
      : undefined;
    const hasFbKey2 = typeof fallback_key_2 === 'string' && fallback_key_2.trim().length > 0;
    const shouldClearFbKey2 = clear_fallback_key_2 === true || (typeof fallback_key_2 === 'string' && fallback_key_2.trim() === '');

    if (hasValidKey) {
      await upsertApiKeyToSupabase(modelId, api_key.trim());
    } else if (shouldClearKey) {
      await upsertApiKeyToSupabase(modelId, '');
    }

    const { getPersistedModels, savePersistedModels, invalidateModelsCache, invalidateModelKeyCache, getApiKeyFromSupabase, removeDeletedModelId } = require('../../utils/getModelConfig');
    if (typeof removeDeletedModelId === 'function') {
      await removeDeletedModelId(modelId);
    }

    if (getIsMongoConnected()) {
      let mongoModel = await AiModel.findOne({ $or: [{ model_id: modelId }, { id: modelId }] });
      if (mongoModel) {
        if (effPremium !== undefined) mongoModel.premium = effPremium;
        if (effEfficient !== undefined) mongoModel.efficient = effEfficient;
        if (cleanIsActive !== undefined) mongoModel.is_active = cleanIsActive;
        if (cleanContext !== undefined) mongoModel.context_window = cleanContext;
        if (cleanOrder !== undefined) mongoModel.order = cleanOrder;
        if (cleanProvider !== undefined) mongoModel.provider = cleanProvider;
        if (cleanType !== undefined) mongoModel.type = cleanType;
        if (name !== undefined) mongoModel.name = (typeof name === 'string' && name.trim()) ? name.trim().slice(0, 100) : (modelId || 'Alo AI');
        if (cleanBaseUrl !== undefined) mongoModel.base_url = cleanBaseUrl;
        if (cleanApiModel1 !== undefined) mongoModel.api_model_1 = cleanApiModel1;
        if (hasValidKey) mongoModel.api_key = api_key.trim();
        else if (shouldClearKey) mongoModel.api_key = '';

        if (cleanFbUrl1 !== undefined) mongoModel.fallback_url_1 = cleanFbUrl1;
        if (cleanFbModel1 !== undefined) {
          mongoModel.fallback_model_1 = cleanFbModel1;
          mongoModel.api_model_2 = cleanFbModel1;
        }
        if (hasFbKey1) mongoModel.fallback_key_1 = fallback_key_1.trim();
        else if (shouldClearFbKey1) mongoModel.fallback_key_1 = '';

        if (cleanFbUrl2 !== undefined) mongoModel.fallback_url_2 = cleanFbUrl2;
        if (cleanFbModel2 !== undefined) {
          mongoModel.fallback_model_2 = cleanFbModel2;
          mongoModel.api_model_3 = cleanFbModel2;
        }
        if (hasFbKey2) mongoModel.fallback_key_2 = fallback_key_2.trim();
        else if (shouldClearFbKey2) mongoModel.fallback_key_2 = '';

        await mongoModel.save();
      } else {
        const count = await AiModel.countDocuments();
        mongoModel = await AiModel.create({
          model_id: modelId,
          name: (typeof name === 'string' && name.trim()) ? name.trim().slice(0, 100) : (modelId || 'Alo AI'),
          base_url: cleanBaseUrl || '',
          api_key: hasValidKey ? api_key.trim() : '',
          api_model_1: cleanApiModel1 || modelId,
          fallback_url_1: cleanFbUrl1 || '',
          fallback_key_1: hasFbKey1 ? fallback_key_1.trim() : '',
          fallback_model_1: cleanFbModel1 || '',
          api_model_2: cleanFbModel1 || '',
          fallback_url_2: cleanFbUrl2 || '',
          fallback_key_2: hasFbKey2 ? fallback_key_2.trim() : '',
          fallback_model_2: cleanFbModel2 || '',
          api_model_3: cleanFbModel2 || '',
          premium: Boolean(effPremium),
          efficient: Boolean(effEfficient),
          is_active: cleanIsActive !== undefined ? cleanIsActive : true,
          context_window: cleanContext || 8192,
          provider: cleanProvider || 'Alora',
          type: cleanType || 'custom',
          order: cleanOrder !== undefined ? cleanOrder : (count + 1)
        });
      }

      const freshMongo = await AiModel.find().sort({ order: 1, createdAt: 1 }).lean();
      const syncedModels = freshMongo.map(m => ({ ...m, id: m.id || m.model_id, model_id: m.model_id || m.id }));
      await savePersistedModels(syncedModels);
      invalidateModelsCache();
      invalidateModelKeyCache(modelId);
      invalidateCachedModels();
      await saveBackup();

      const modelOut = syncedModels.find(m => m.id === modelId || m.model_id === modelId) || mongoModel;
      return res.json({ success: true, message: 'মডেল ও ৩টি API কনফিগারেশন সফলভাবে আপডেট হয়েছে', model: modelOut });
    }

    let models = await getPersistedModels();
    models = [...models];
    let model = models.find(m => m.id === modelId || m.model_id === modelId || (m.id && decodeURIComponent(m.id) === modelId));
    if (!model) {
      const dbKey = await getApiKeyFromSupabase(modelId);
      model = {
        id: modelId,
        model_id: modelId,
        name: (typeof name === 'string' && name.trim()) ? name.trim().slice(0, 100) : (modelId || 'Alo AI'),
        description: cleanDesc || '',
        base_url: cleanBaseUrl || '',
        api_key: hasValidKey ? api_key.trim() : (dbKey || ''),
        api_model_1: cleanApiModel1 || modelId,
        fallback_url_1: cleanFbUrl1 || '',
        fallback_key_1: hasFbKey1 ? fallback_key_1.trim() : '',
        fallback_model_1: cleanFbModel1 || '',
        api_model_2: cleanFbModel1 || '',
        fallback_url_2: cleanFbUrl2 || '',
        fallback_key_2: hasFbKey2 ? fallback_key_2.trim() : '',
        fallback_model_2: cleanFbModel2 || '',
        api_model_3: cleanFbModel2 || '',
        premium: Boolean(effPremium),
        efficient: Boolean(effEfficient),
        is_active: cleanIsActive !== undefined ? cleanIsActive : true,
        context_window: cleanContext || 8192,
        provider: cleanProvider || 'Alora',
        type: cleanType || 'custom',
        order: cleanOrder !== undefined ? cleanOrder : (models.length + 1)
      };
      models.push(model);
    } else {
      model.id = modelId;
      model.model_id = modelId;
      if (name !== undefined) model.name = (typeof name === 'string' && name.trim()) ? name.trim().slice(0, 100) : (modelId || 'Alo AI');
      if (cleanDesc !== undefined) model.description = cleanDesc;
      if (cleanBaseUrl !== undefined) model.base_url = cleanBaseUrl;
      if (cleanApiModel1 !== undefined) model.api_model_1 = cleanApiModel1;
      if (effPremium !== undefined) model.premium = effPremium;
      if (effEfficient !== undefined) model.efficient = effEfficient;
      if (cleanIsActive !== undefined) model.is_active = cleanIsActive;
      if (cleanContext !== undefined) model.context_window = cleanContext;
      if (cleanOrder !== undefined) model.order = cleanOrder;
      if (cleanProvider !== undefined) model.provider = cleanProvider;
      if (cleanType !== undefined) model.type = cleanType;

      if (cleanFbUrl1 !== undefined) model.fallback_url_1 = cleanFbUrl1;
      if (cleanFbModel1 !== undefined) {
        model.fallback_model_1 = cleanFbModel1;
        model.api_model_2 = cleanFbModel1;
      }
      if (hasFbKey1) model.fallback_key_1 = fallback_key_1.trim();
      else if (shouldClearFbKey1) model.fallback_key_1 = '';

      if (cleanFbUrl2 !== undefined) model.fallback_url_2 = cleanFbUrl2;
      if (cleanFbModel2 !== undefined) {
        model.fallback_model_2 = cleanFbModel2;
        model.api_model_3 = cleanFbModel2;
      }
      if (hasFbKey2) model.fallback_key_2 = fallback_key_2.trim();
      else if (shouldClearFbKey2) model.fallback_key_2 = '';

      if (hasValidKey) {
        model.api_key = api_key.trim();
      } else if (shouldClearKey) {
        model.api_key = '';
      } else if (!model.api_key) {
        const dbKey = await getApiKeyFromSupabase(modelId);
        if (dbKey) model.api_key = dbKey;
      }
    }

    await savePersistedModels(models);
    invalidateModelsCache();
    invalidateModelKeyCache(modelId);
    invalidateCachedModels();
    await saveBackup();

    return res.json({ success: true, message: 'মডেল ও ৩টি API কনফিগারেশন সফলভাবে আপডেট হয়েছে', model });
  } catch (error) {
    return sendServerError(res, error, 'Internal server error', '[Admin Error]:');
  }
};

const addModel = async (req, res) => {
  try {
    const {
      model_id, name,
      base_url, api_key, api_model_1,
      fallback_url_1, fallback_key_1, fallback_model_1, api_model_2,
      fallback_url_2, fallback_key_2, fallback_model_2, api_model_3,
      premium, efficient, provider, type
    } = req.body;
    if (!model_id || !name || typeof model_id !== 'string' || typeof name !== 'string') {
      return res.status(400).json({ success: false, error: 'মডেল আইডি এবং নাম আবশ্যক' });
    }

    const cleanModelId = model_id.trim().slice(0, 100);
    const cleanName = name.trim().slice(0, 100);
    if (!cleanModelId || !cleanName) {
      return res.status(400).json({ success: false, error: 'মডেল আইডি এবং নাম সঠিক হতে হবে' });
    }

    const cleanBaseUrl = normalizeBaseUrl(base_url);
    const cleanApiModel1 = typeof api_model_1 === 'string' && api_model_1.trim() ? api_model_1.trim() : cleanModelId;

    const cleanFbUrl1 = typeof fallback_url_1 === 'string' && fallback_url_1.trim() ? normalizeBaseUrl(fallback_url_1) : '';
    const cleanFbModel1 = typeof (api_model_2 || fallback_model_1) === 'string' ? String(api_model_2 || fallback_model_1).trim() : '';
    const cleanFbKey1 = typeof fallback_key_1 === 'string' ? fallback_key_1.trim() : '';

    const cleanFbUrl2 = typeof fallback_url_2 === 'string' && fallback_url_2.trim() ? normalizeBaseUrl(fallback_url_2) : '';
    const cleanFbModel2 = typeof (api_model_3 || fallback_model_2) === 'string' ? String(api_model_3 || fallback_model_2).trim() : '';
    const cleanFbKey2 = typeof fallback_key_2 === 'string' ? fallback_key_2.trim() : '';

    // 1. Save api_key in Supabase api_keys table
    if (api_key) {
      await upsertApiKeyToSupabase(cleanModelId, api_key.trim());
    }

    const { getPersistedModels, savePersistedModels, invalidateModelsCache, invalidateModelKeyCache, removeDeletedModelId } = require('../../utils/getModelConfig');
    if (typeof removeDeletedModelId === 'function') {
      await removeDeletedModelId(cleanModelId);
    }
    let models = await getPersistedModels();
    models = [...models];

    const existing = models.find(m => (m.id === cleanModelId || m.model_id === cleanModelId));
    if (existing) {
      return res.status(400).json({ success: false, error: 'এই মডেল আইডি ইতিমধ্যে বিদ্যমান' });
    }

    const maxOrder = models.reduce((max, m) => Math.max(max, m.order || 0), 0);
    const newOrder = maxOrder + 1;

    // 2. If Mongo connected, create in Mongo WITH api_key
    if (getIsMongoConnected()) {
      const existingMongo = await AiModel.findOne({ model_id: cleanModelId });
      if (!existingMongo) {
        await AiModel.create({
          model_id: cleanModelId,
          name: cleanName,
          base_url: cleanBaseUrl,
          api_key: api_key ? api_key.trim() : '',
          api_model_1: cleanApiModel1,
          fallback_url_1: cleanFbUrl1,
          fallback_key_1: cleanFbKey1,
          fallback_model_1: cleanFbModel1,
          api_model_2: cleanFbModel1,
          fallback_url_2: cleanFbUrl2,
          fallback_key_2: cleanFbKey2,
          fallback_model_2: cleanFbModel2,
          api_model_3: cleanFbModel2,
          premium: Boolean(premium),
          efficient: Boolean(efficient),
          provider: provider || 'Alora',
          type: type || 'custom',
          order: newOrder
        });
      }
    }

    // 3. ALWAYS add to Supabase __models_metadata__ and local memoryStore
    const newModel = {
      id: cleanModelId,
      model_id: cleanModelId,
      name: cleanName,
      base_url: cleanBaseUrl,
      api_key: api_key ? api_key.trim() : '',
      api_model_1: cleanApiModel1,
      fallback_url_1: cleanFbUrl1,
      fallback_key_1: cleanFbKey1,
      fallback_model_1: cleanFbModel1,
      api_model_2: cleanFbModel1,
      fallback_url_2: cleanFbUrl2,
      fallback_key_2: cleanFbKey2,
      fallback_model_2: cleanFbModel2,
      api_model_3: cleanFbModel2,
      premium: Boolean(premium),
      efficient: Boolean(efficient),
      provider: provider || 'Alora',
      type: type || 'custom',
      order: newOrder
    };
    models.push(newModel);
    await savePersistedModels(models);
    invalidateModelsCache();
    invalidateModelKeyCache(cleanModelId);
    invalidateCachedModels();
    await saveBackup();

    return res.status(201).json({ success: true, message: 'নতুন মডেল সফলভাবে যোগ করা হয়েছে', model: newModel });
  } catch (error) {
    return sendServerError(res, error, 'Internal server error', '[Admin Error]:');
  }
};

const deleteModel = async (req, res) => {
  try {
    let rawTarget = req.params.modelId || (req.body && req.body.modelId) || req.query.modelId;
    if (!rawTarget || typeof rawTarget !== 'string' || !rawTarget.trim()) {
      return res.status(400).json({ success: false, error: 'সঠিক মডেল আইডি প্রদান করুন' });
    }

    let decoded = rawTarget;
    try { decoded = decodeURIComponent(rawTarget); } catch {}

    const cleanModelId = String(rawTarget || '').trim();
    const cleanDecoded = String(decoded || '').trim();

    // No hardcoded restrictions: Admin has full authority to permanently delete any model.

    // 1. If Mongo connected, purge from MongoDB
    if (getIsMongoConnected()) {
      const mongoose = require('mongoose');
      const queryList = [
        { model_id: cleanModelId },
        { model_id: cleanDecoded },
        { id: cleanModelId },
        { id: cleanDecoded },
        { name: cleanModelId },
        { name: cleanDecoded }
      ];
      if (mongoose.Types.ObjectId.isValid(cleanModelId)) {
        queryList.push({ _id: cleanModelId });
      }
      if (mongoose.Types.ObjectId.isValid(cleanDecoded)) {
        queryList.push({ _id: cleanDecoded });
      }
      await AiModel.deleteMany({ $or: queryList }).catch(() => {});
      const remainingMongo = await AiModel.find().sort({ order: 1, createdAt: 1 });
      for (let i = 0; i < remainingMongo.length; i++) {
        if (remainingMongo[i].order !== i + 1) {
          remainingMongo[i].order = i + 1;
          await remainingMongo[i].save().catch(() => {});
        }
      }
      try {
        await Plan.updateMany(
          { allowed_models: { $in: [cleanModelId, cleanDecoded] } },
          { $pull: { allowed_models: { $in: [cleanModelId, cleanDecoded] } } }
        );
      } catch (e) {}
    }

    // 2. Delete individual model api_key rows from Supabase api_keys table
    if (supabase) {
      const keysToDelete = [cleanModelId, cleanDecoded, `key_${cleanModelId}`, `key_${cleanDecoded}`];
      for (const k of keysToDelete) {
        if (k) {
          try {
            await supabase.from('api_keys').delete().eq('model_id', k);
          } catch (e) {}
        }
      }
    }

    // 3. Matcher function to filter out model cleanly across all variations
    const isTargetModel = (m) => {
      if (!m) return false;
      const mId = String(m.id || m.model_id || '').trim().toLowerCase();
      const mName = String(m.name || '').trim().toLowerCase();
      const t1 = cleanModelId.toLowerCase();
      const t2 = cleanDecoded.toLowerCase();
      const mongoId = m._id ? String(m._id) : '';
      return mId === t1 || mId === t2 || mName === t1 || mName === t2 || mongoId === cleanModelId || mongoId === cleanDecoded;
    };

    // 4. ALWAYS remove from Supabase __models_metadata__
    const { 
      getPersistedModels, 
      savePersistedModels, 
      invalidateModelsCache, 
      invalidateModelKeyCache,
      getPersistedPlans,
      savePersistedPlans,
      addDeletedModelId
    } = require('../../utils/getModelConfig');

    await addDeletedModelId(cleanModelId);
    await addDeletedModelId(cleanDecoded);

    let models = await getPersistedModels();
    models = Array.isArray(models) ? models.filter(m => !isTargetModel(m)) : [];
    
    // Re-normalize orders
    models.forEach((m, idx) => { m.order = idx + 1; });
    await savePersistedModels(models);
    invalidateModelsCache();

    // 5. ALWAYS remove from memoryStore
    if (memoryStore.models) {
      memoryStore.models = memoryStore.models.filter(m => !isTargetModel(m));
    }
    invalidateModelKeyCache(cleanModelId);
    invalidateModelKeyCache(cleanDecoded);
    invalidateCachedModels();
    await saveBackup(); // Immediately sync memory backup to disk (critical for serverless)
    debouncedSave();

    // 6. Clean up allowed_models in Plans if this model was explicitly listed
    try {
      let plans = await getPersistedPlans();
      let plansModified = false;
      if (Array.isArray(plans)) {
        const t1 = cleanModelId.toLowerCase();
        const t2 = cleanDecoded.toLowerCase();
        plans.forEach(p => {
          if (Array.isArray(p.allowed_models)) {
            const beforeLen = p.allowed_models.length;
            p.allowed_models = p.allowed_models.filter(m => {
              const low = String(m || '').trim().toLowerCase();
              return low !== t1 && low !== t2;
            });
            if (p.allowed_models.length !== beforeLen) plansModified = true;
          }
        });
        if (plansModified) {
          await savePersistedPlans(plans);
        }
      }
    } catch (e) {}

    // 8. Deep auto-purge orphaned caches & references across database
    const { autoPurgeOrphanedDatabaseCaches } = require('../../utils/getModelConfig');
    await autoPurgeOrphanedDatabaseCaches().catch(() => {});

    return res.json({ 
      success: true, 
      message: `মডেল '${cleanDecoded}' ডাটাবেস ও সিস্টেম থেকে চিরতরে মুছে ফেলা হয়েছে (Permanent Delete)।`,
      remaining_count: models.length
    });
  } catch (error) {
    return sendServerError(res, error, 'Internal server error', '[Admin Error]:');
  }
};

const reorderModels = async (req, res) => {
  try {
    let { modelId, direction, modelIds } = req.body;
    if (modelId) {
      try { modelId = decodeURIComponent(modelId); } catch {}
    }
    if (modelIds && Array.isArray(modelIds)) {
      modelIds = modelIds.map(id => {
        try { return decodeURIComponent(id); } catch { return id; }
      });
    }

    const { getPersistedModels, savePersistedModels, invalidateModelsCache, invalidateModelKeyCache, getApiKeyFromSupabase } = require('../../utils/getModelConfig');

    let models = await getPersistedModels();
    models = [...models];

    // CRITICAL: Ensure each model has its api_key populated from Supabase before any reordering or saving
    for (let m of models) {
      const mId = m.id || m.model_id;
      m.id = mId;
      m.model_id = mId;
      if (!m.api_key) {
        const k = await getApiKeyFromSupabase(mId);
        if (k) m.api_key = k;
      }
    }

    if (modelIds && Array.isArray(modelIds) && modelIds.length > 0) {
      const uniqueModelIds = [...new Set(modelIds)];
      const reordered = [];
      for (let i = 0; i < uniqueModelIds.length; i++) {
        const id = uniqueModelIds[i];
        const m = models.find(x => (x.id === id || x.model_id === id));
        if (m) {
          m.order = i + 1;
          reordered.push(m);
        }
      }
      for (const m of models) {
        const mId = m.id || m.model_id;
        if (!reordered.find(x => (x.id === mId || x.model_id === mId))) {
          m.order = reordered.length + 1;
          reordered.push(m);
        }
      }

      if (getIsMongoConnected()) {
        for (const m of reordered) {
          await AiModel.updateOne({ $or: [{ model_id: m.id }, { id: m.id }] }, { $set: { order: m.order } });
        }
      }

      await savePersistedModels(reordered);
      invalidateModelsCache();
      invalidateModelKeyCache();
      invalidateCachedModels();
      debouncedSave();
      await saveBackup();

      return res.json({ success: true, message: 'মডেলের ক্রম সফলভাবে সাজানো হয়েছে', models: reordered });
    }

    if (modelId && direction) {
      if (!['up', 'down'].includes(direction)) {
        return res.status(400).json({ success: false, error: 'দিক অবশ্যই up অথবা down হতে হবে' });
      }
      models.sort((a, b) => (a.order || 0) - (b.order || 0));
      const idx = models.findIndex(m => (m.id === modelId || m.model_id === modelId));
      if (idx === -1) return res.status(404).json({ success: false, error: 'মডেল পাওয়া যায়নি' });

      const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
      if (targetIdx >= 0 && targetIdx < models.length) {
        const [movedModel] = models.splice(idx, 1);
        models.splice(targetIdx, 0, movedModel);

        for (let i = 0; i < models.length; i++) {
          models[i].order = i + 1;
          if (getIsMongoConnected()) {
            await AiModel.updateOne({ $or: [{ model_id: models[i].id }, { id: models[i].id }] }, { $set: { order: i + 1 } });
          }
        }

        await savePersistedModels(models);
        invalidateModelsCache();
        invalidateModelKeyCache();
        invalidateCachedModels();
        await saveBackup();
        return res.json({ success: true, message: 'মডেলের অবস্থান পরিবর্তন হয়েছে', models });
      }
      return res.json({ success: true, models });
    }

    return res.status(400).json({ success: false, error: 'সঠিক তথ্য দিন' });
  } catch (error) {
    return sendServerError(res, error, 'Internal server error', '[Admin Error]:');
  }
};

const getSettings = async (req, res) => {
  try {
    const { getSystemSettings } = require('../../utils/getModelConfig');
    const settings = await getSystemSettings();
    return res.json({ success: true, settings });
  } catch (error) {
    return sendServerError(res, error, 'Internal server error', '[Admin Error]:');
  }
};

const updateSettings = async (req, res) => {
  try {
    const { saveSystemSettings } = require('../../utils/getModelConfig');
    const toSave = typeof req.body === 'object' && req.body !== null ? req.body : {};
    const saved = await saveSystemSettings(toSave);
    debouncedSave();
    return res.json({ success: true, settings: saved, message: 'সিস্টেম সেটিংস সফলভাবে আপডেট হয়েছে' });
  } catch (error) {
    return sendServerError(res, error, 'Internal server error', '[Admin Error]:');
  }
};

const testWebSearchSetting = async (req, res) => {
  try {
    const { query, provider, api_key, custom_url, max_results } = req.body || {};
    const cleanQuery = String(query || 'AI news').trim();
    const { executeSearch } = require('./searchController');
    const forcedSettings = {
      web_search_provider: provider,
      web_search_api_key: api_key,
      web_search_custom_url: custom_url,
      web_search_max_results: max_results
    };
    const result = await executeSearch(cleanQuery, forcedSettings);
    return res.json({ success: true, ...result });
  } catch (error) {
    return res.status(500).json({ success: false, error: redactSecrets(error.message) });
  }
};

const testImageGenSetting = async (req, res) => {
  try {
    const { prompt, model, api_url, api_key, size } = req.body || {};
    const cleanPrompt = String(prompt || 'a cute glowing baby robot in cybernetic world, photorealistic, 8k').trim();
    const { executeImageGeneration } = require('./chatController');
    const forcedSettings = {
      image_model: model,
      image_api_url: api_url,
      image_api_key: api_key,
      image_size: size
    };
    const result = await executeImageGeneration(cleanPrompt, forcedSettings);
    return res.json({ success: true, ...result });
  } catch (error) {
    return res.status(500).json({ success: false, error: redactSecrets(error.message) });
  }
};


const SUPPORTED_PROVIDERS = ['openai', 'gemini', 'anthropic', 'deepseek', 'groq', 'openrouter'];

const getApiKeys = async (req, res) => {
  try {
    const { getApiKeyFromSupabase } = require('../../utils/getModelConfig');
    const result = [];
    for (const p of SUPPORTED_PROVIDERS) {
      const envKeyName = `${p.toUpperCase()}_API_KEY`;
      const envKey = process.env[envKeyName] || '';
      let dbKey = '';
      try {
        dbKey = (await getApiKeyFromSupabase(`__${p}_key__`)) || '';
      } catch (e) {}

      const effectiveKey = dbKey || envKey || '';
      const masked = effectiveKey 
        ? (effectiveKey.length > 8 ? `${effectiveKey.slice(0, 4)}...${effectiveKey.slice(-4)}` : '••••••••')
        : '';

      result.push({
        provider: p,
        configured: Boolean(effectiveKey),
        source: dbKey ? 'database' : (envKey ? 'env' : 'none'),
        masked_key: masked
      });
    }
    return res.json({ success: true, keys: result });
  } catch (error) {
    return sendServerError(res, error, 'Internal server error', '[Admin Error]:');
  }
};

const saveApiKey = async (req, res) => {
  try {
    const { provider, api_key } = req.body;
    if (!provider || typeof provider !== 'string') {
      return res.status(400).json({ success: false, error: 'সঠিক প্রোভাইডারের নাম প্রদান করুন' });
    }
    const cleanProvider = provider.toLowerCase().trim();
    if (!SUPPORTED_PROVIDERS.includes(cleanProvider)) {
      return res.status(400).json({ success: false, error: `অসমর্থিত প্রোভাইডার। সমর্থিত: ${SUPPORTED_PROVIDERS.join(', ')}` });
    }
    const cleanKey = typeof api_key === 'string' ? api_key.trim() : '';
    await upsertApiKeyToSupabase(`__${cleanProvider}_key__`, cleanKey);
    process.env[`${cleanProvider.toUpperCase()}_API_KEY`] = cleanKey;

    return res.json({ 
      success: true, 
      message: `${cleanProvider.toUpperCase()} API Key সফলভাবে সংরক্ষণ করা হয়েছে`,
      provider: cleanProvider,
      configured: Boolean(cleanKey)
    });
  } catch (error) {
    return sendServerError(res, error, 'Internal server error', '[Admin Error]:');
  }
};

const deleteApiKey = async (req, res) => {
  try {
    let { provider } = req.params;
    if (!provider) provider = req.body?.provider;
    const cleanProvider = String(provider || '').toLowerCase().trim();
    if (!SUPPORTED_PROVIDERS.includes(cleanProvider)) {
      return res.status(400).json({ success: false, error: 'সঠিক প্রোভাইডারের নাম প্রদান করুন' });
    }
    if (supabase) {
      await supabase.from('api_keys').delete().eq('model_id', `__${cleanProvider}_key__`).catch(() => {});
    }
    const { invalidateModelKeyCache } = require('../../utils/getModelConfig');
    if (typeof invalidateModelKeyCache === 'function') {
      invalidateModelKeyCache(`__${cleanProvider}_key__`);
    }
    delete process.env[`${cleanProvider.toUpperCase()}_API_KEY`];

    return res.json({ success: true, message: `${cleanProvider.toUpperCase()} API Key মুছে ফেলা হয়েছে` });
  } catch (error) {
    return sendServerError(res, error, 'Internal server error', '[Admin Error]:');
  }
};

const getSystemLogs = async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    let logs = [];
    if (getIsMongoConnected()) {
      logs = await UsageLog.find()
        .sort({ timestamp: -1, createdAt: -1 })
        .limit(limit)
        .lean();
    } else {
      logs = (memoryStore.usageLogs || []).slice(-limit).reverse();
    }

    return res.json({ 
      success: true, 
      count: logs.length, 
      logs: logs.map(l => ({
        id: l._id || l.id,
        user_id: l.user_id,
        model_id: l.model_id,
        tokens: l.tokens || 0,
        type: l.model_id === 'image-generation' ? 'image' : 'chat',
        timestamp: l.timestamp || l.createdAt || new Date()
      }))
    });
  } catch (error) {
    return sendServerError(res, error, 'Internal server error', '[Admin Error]:');
  }
};

module.exports = { 
  getModels, 
  updateModel, 
  addModel,
  deleteModel,
  reorderModels,
  getAdminStats,
  getUsers,
  deleteUser,
    updateUserPlan,
  updateUserRole,
  toggleBlockUser,
  getPlans,
  updatePlanLimits,
  generateRedeemCodes,
  getRedeemCodes,
  deleteRedeemCode,
  createCustomRedeemCode,
  getApiKeys,
  saveApiKey,
  deleteApiKey,
  getSystemLogs,
  getSettings,
  updateSettings,
  testWebSearchSetting,
  testImageGenSetting
};

