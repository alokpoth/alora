const mongoose = require('mongoose');
const User = require('../models/User');
const Plan = require('../models/Plan');
const UsageLog = require('../models/UsageLog');
const AiModel = require('../models/AiModel');
const { getIsMongoConnected } = require('../config/db');
const { memoryStore, debouncedSave } = require('../config/memoryStore');
const { getModelConfig, getUserUsageDetails, getUserImageUsageDetails } = require('../../utils/getModelConfig');
const { getCachedPlan, setCachedPlan, getCachedModel, setCachedModel, invalidateCachedUser } = require('../config/dbCache');

const guestMessageTracker = new Map();
// Clear any test counts for localhost
guestMessageTracker.delete('127_0_0_1');
guestMessageTracker.delete('localhost');
guestMessageTracker.delete('_1');

const checkRateLimit = async (req, res, next) => {
  try {
    const user = req.user;
    const reqPath = req.path || '';
    const origUrl = req.originalUrl || '';
    const isImageRoute = reqPath.startsWith('/image') || origUrl.includes('/chat/image') || origUrl.includes('/image');

    // Admin users are never rate-limited
    const adminEmails = ['zihanfakir@gmail.com', 'x@zihan.uk'];
    const isVerifiedAdmin = (user && user.role === 'admin') || (user && user.email && adminEmails.includes(user.email.toLowerCase().trim()));
    if (isVerifiedAdmin) {
      req.currentPlan = { name: 'Admin', displayName: 'অ্যাডমিন', message_limit: 999999, image_limit: 999999, window_hours: 1, allowed_models: ['*'] };
      return next();
    }

    // Resolve IP safely for guest tracking
    const headers = req?.headers || {};
    const vercelIp = headers['x-real-ip'] || headers['x-vercel-forwarded-for'] || headers['cf-connecting-ip'];
    const xff = headers['x-forwarded-for'];
    let resolvedIp = req?.socket?.remoteAddress || req?.ip || '127.0.0.1';
    if (vercelIp) {
      resolvedIp = Array.isArray(vercelIp) ? (vercelIp[0] || '').trim() : String(vercelIp).split(',')[0].trim();
    } else if (xff) {
      const parts = Array.isArray(xff) ? xff : String(xff).split(',');
      resolvedIp = (parts[parts.length - 1] || '').trim();
    }
    const cleanIp = String(resolvedIp || '127.0.0.1').replace(/^::ffff:/, '').replace(/[^a-zA-Z0-9]/g, '_');
    const guestId = `guest_${cleanIp}`;

    // 0. Guest User (Not logged in) — Allow up to 2 trial messages per IP
    if (!user) {
      if (isImageRoute) {
        return res.status(401).json({
          success: false,
          error: 'ছবি তৈরি করতে অনুগ্রহ করে প্রথমে লগইন বা সাইন-আপ করুন।'
        });
      }
      const now = Date.now();
      const guestData = guestMessageTracker.get(cleanIp) || { count: 0, resetAt: now + 24 * 60 * 60 * 1000 };
      if (now > guestData.resetAt) {
        guestData.count = 0;
        guestData.resetAt = now + 24 * 60 * 60 * 1000;
      }
      if (guestData.count >= 2) {
        return res.status(401).json({
          success: false,
          code: 'GUEST_LIMIT_REACHED',
          error: 'আপনার ২টি ফ্রি বার্তা শেষ হয়েছে। চ্যাট চালিয়ে যেতে অনুগ্রহ করে লগইন বা সাইন-আপ করুন।'
        });
      }
      guestData.count += 1;
      guestMessageTracker.set(cleanIp, guestData);
      req.guestId = guestId;
      req.currentPlan = { name: 'Free', displayName: 'গেস্ট ট্রায়াল', message_limit: 2, image_limit: 0, window_hours: 24, allowed_models: ['*'] };
      return next();
    }

    // 1. Check & Auto-Downgrade Expired Subscriptions
    if (user.subscription && user.subscription.plan_name !== 'Free' && user.subscription.expires_at) {
      if (new Date() > new Date(user.subscription.expires_at)) {
        user.subscription.plan_name = 'Free';
        user.subscription.expires_at = null;
        user.subscription.is_active = true;
        const uId = user._id || user.id;
        if (getIsMongoConnected()) {
          try {
            const q = mongoose.Types.ObjectId.isValid(uId) ? { _id: uId } : { $or: [{ _id: uId }, { id: uId }, ...(user.email ? [{ email: user.email }] : [])] };
            await User.updateOne(q, { $set: { subscription: user.subscription } }).catch(() => {});
          } catch {}
        }
        // Unconditionally persist downgrade across Supabase and memoryStore
        try {
          const { getPersistedUsers, savePersistedUsers, invalidateUsersCache, invalidateUserUsageCache } = require('../../utils/getModelConfig');
          let users = await getPersistedUsers();
          users = [...users];
          const uIdx = users.findIndex(u => String(u._id || u.id) === String(uId) || (user.email && u.email && u.email.toLowerCase().trim() === user.email.toLowerCase().trim()));
          if (uIdx !== -1) {
            users[uIdx].subscription = user.subscription;
            await savePersistedUsers(users);
          }
          if (memoryStore.users) {
            const mIdx = memoryStore.users.findIndex(u => String(u._id || u.id) === String(uId) || (user.email && u.email && u.email.toLowerCase().trim() === user.email.toLowerCase().trim()));
            if (mIdx !== -1) memoryStore.users[mIdx].subscription = user.subscription;
          }
          debouncedSave();
          if (typeof invalidateUsersCache === 'function') invalidateUsersCache();
          if (typeof invalidateUserUsageCache === 'function') {
            invalidateUserUsageCache(uId);
            if (user.email) invalidateUserUsageCache(user.email);
          }
        } catch (syncErr) {
          console.warn('[RateLimit Auto-Downgrade Sync Warning]:', syncErr.message);
        }
        invalidateCachedUser(uId);
        if (user.email) invalidateCachedUser(user.email);
      }
    }

    // 2. Fetch Current Plan Configuration (Microsecond In-Memory Cache)
    const currentPlanName = (user.subscription && user.subscription.plan_name) ? user.subscription.plan_name : 'Free';
    
    let plan = getCachedPlan(currentPlanName);
    if (!plan) {
      if (getIsMongoConnected()) {
        try {
          plan = await Plan.findOne({ name: currentPlanName }).lean();
        } catch (pErr) {
          console.warn('[RateLimit Plan Mongo Warning]:', pErr.message);
          plan = null;
        }
      }
      if (!plan) {
        const { getPersistedPlans } = require('../../utils/getModelConfig');
        const plans = await getPersistedPlans();
        plan = plans.find(p => p.name === currentPlanName);
      }
      if (plan) {
        setCachedPlan(currentPlanName, plan);
      }
    }

    if (!plan) {
      const defaultLimits = {
        'Free': { limit: 10, imgLimit: 5, window: 3, name: 'ফ্রি প্ল্যান', allowed: ['*'] },
        'Pro': { limit: 30, imgLimit: 25, window: 3, name: 'প্রো প্ল্যান', allowed: ['*'] },
        'Max': { limit: 50, imgLimit: 100, window: 1, name: 'ম্যাক্স প্ল্যান', allowed: ['*'] }
      };
      const def = defaultLimits[currentPlanName] || defaultLimits['Free'];
      plan = {
        name: currentPlanName,
        displayName: def.name,
        message_limit: def.limit,
        image_limit: def.imgLimit,
        window_hours: def.window,
        allowed_models: def.allowed,
        is_active: true
      };
      setCachedPlan(currentPlanName, plan);
    }
    plan.message_limit = Number(plan.message_limit) || 10;
    plan.window_hours = Number(plan.window_hours) || 3;
    const defaultImgLimit = (plan.name === 'Free' ? 5 : (plan.name === 'Pro' ? 25 : 100));
    plan.image_limit = (plan.image_limit !== undefined && !isNaN(Number(plan.image_limit)) && Number(plan.image_limit) > 0) ? Math.max(Number(plan.image_limit), defaultImgLimit) : defaultImgLimit;

    const userId = String(user._id || user.id);
    const windowStart = new Date(Date.now() - plan.window_hours * 60 * 60 * 1000);

    // 3. Image Generation Limit Check
    if (isImageRoute) {
      let imageCount = 0;
      let resetTimeMinutes = Math.round(plan.window_hours * 60);

      let queriedMongo = false;
      if (getIsMongoConnected()) {
        try {
          const userQuery = mongoose.Types.ObjectId.isValid(userId) ? { $in: [userId, new mongoose.Types.ObjectId(userId)] } : userId;
          imageCount = await UsageLog.countDocuments({
            user_id: userQuery,
            model_id: 'image-generation',
            timestamp: { $gte: windowStart }
          });
          if (imageCount >= plan.image_limit) {
            const oldestLog = await UsageLog.findOne({
              user_id: userQuery,
              model_id: 'image-generation',
              timestamp: { $gte: windowStart }
            }).sort({ timestamp: 1 }).select('timestamp').lean();
            if (oldestLog) {
              resetTimeMinutes = Math.max(1, Math.ceil((new Date(oldestLog.timestamp).getTime() + plan.window_hours * 60 * 60 * 1000 - Date.now()) / (60 * 1000)));
            }
          }
          queriedMongo = true;
        } catch (mongoErr) {
          console.warn('[RateLimit Image Mongo Warning, falling back to memory/Supabase]:', mongoErr.message);
          queriedMongo = false;
        }
      }

      if (!queriedMongo) {
        const imgDetails = await getUserImageUsageDetails(userId, plan.window_hours);
        const memLogs = (memoryStore.usageLogs || []).filter(l =>
          String(l.user_id) === userId &&
          l.model_id === 'image-generation' &&
          new Date(l.timestamp) >= windowStart
        );
        imageCount = Math.max(imgDetails.count, memLogs.length);
        resetTimeMinutes = imgDetails.resetInMinutes;
      }

      if (imageCount >= plan.image_limit) {
        res.setHeader('Retry-After', Math.max(1, Math.ceil(resetTimeMinutes * 60)));
        return res.status(429).json({
          success: false,
          error: `ছবি তৈরির সীমা শেষ! ${plan.displayName || plan.name}-এ প্রতি ${plan.window_hours} ঘণ্টায় সর্বোচ্চ ${plan.image_limit}টি ছবি তৈরি করা যায়। আবার ${resetTimeMinutes} মিনিট পর চেষ্টা করুন বা প্ল্যান আপগ্রেড করুন।`
        });
      }

      req.currentPlan = plan;
      return next();
    }

    // 4. Model Access Permission Check (for text chat - Microsecond In-Memory Cache)
    const model_id = (req.body && typeof req.body === 'object' && req.body.model) ? String(req.body.model).trim() : 'gemini-3.6-flash';
    
    let aiModel = getCachedModel(model_id);
    if (!aiModel) {
      if (getIsMongoConnected()) {
        try {
          aiModel = await AiModel.findOne({ $or: [{ model_id }, { id: model_id }] }).lean();
        } catch (mErr) {
          console.warn('[RateLimit Model Mongo Warning]:', mErr.message);
          aiModel = null;
        }
      }
      if (!aiModel) {
        aiModel = await getModelConfig(model_id);
      }
      if (aiModel) {
        setCachedModel(model_id, aiModel);
      }
    }

    const isMaxModel = Boolean(aiModel && aiModel.efficient) || model_id === 'gpt-5.6';
    const isProModel = Boolean(aiModel && aiModel.premium) && !isMaxModel;
    const isFreeModel = !isMaxModel && !isProModel;

    const explicitlyAllowedByName = Array.isArray(plan.allowed_models) && (
      plan.allowed_models.includes(model_id) || 
      (aiModel && (plan.allowed_models.includes(aiModel.id) || plan.allowed_models.includes(aiModel.model_id)))
    );
    const hasWildcard = Array.isArray(plan.allowed_models) && plan.allowed_models.includes('*');

    if (currentPlanName === 'Free') {
      // Free users can ONLY use Free models. Pro and Max models are strictly forbidden.
      if (isMaxModel) {
        return res.status(403).json({
          success: false,
          error: `'${aiModel?.name || model_id}' মডেলটি ব্যবহারের জন্য Max প্ল্যান প্রয়োজন। আপনার বর্তমান প্ল্যান: ${plan.displayName || 'ফ্রি প্ল্যান'}।`
        });
      }
      if (isProModel) {
        return res.status(403).json({
          success: false,
          error: `'${aiModel?.name || model_id}' মডেলটি ব্যবহারের জন্য Pro বা Max প্ল্যান প্রয়োজন। আপনার বর্তমান প্ল্যান: ${plan.displayName || 'ফ্রি প্ল্যান'}।`
        });
      }
      if (!hasWildcard && Array.isArray(plan.allowed_models) && plan.allowed_models.length > 0 && !explicitlyAllowedByName) {
        return res.status(403).json({
          success: false,
          error: `আপনার বর্তমান ${plan.displayName || 'ফ্রি প্ল্যান'}-এ '${aiModel?.name || model_id}' মডেল ব্যবহারের অনুমতি নেই।`
        });
      }
    } else if (currentPlanName === 'Pro') {
      // Pro users can use Free and Pro models, but CANNOT use Max models!
      if (isMaxModel) {
        return res.status(403).json({
          success: false,
          error: `'${aiModel?.name || model_id}' মডেলটি ব্যবহারের জন্য Max প্ল্যান প্রয়োজন। আপনার বর্তমান প্ল্যান: ${plan.displayName || 'প্রো প্ল্যান'}।`
        });
      }
      if (!hasWildcard && Array.isArray(plan.allowed_models) && plan.allowed_models.length > 0 && !explicitlyAllowedByName) {
        return res.status(403).json({
          success: false,
          error: `আপনার বর্তমান ${plan.displayName || 'প্রো প্ল্যান'}-এ '${aiModel?.name || model_id}' মডেল ব্যবহারের অনুমতি নেই।`
        });
      }
    } else if (currentPlanName !== 'Max' && !isVerifiedAdmin) {
      // Custom plan check
      if (!explicitlyAllowedByName && !hasWildcard) {
        return res.status(403).json({
          success: false,
          error: `আপনার ${plan.displayName || currentPlanName} এ '${model_id}' মডেল ব্যবহারের অনুমতি নেই।`
        });
      }
    }

    // 5. Dynamic Window Message Rate Limit Check
    let messageCount = 0;
    let resetTimeMinutes = Math.round(plan.window_hours * 60);

    let queriedMongoMessage = false;
    if (getIsMongoConnected()) {
      try {
        const userQuery = mongoose.Types.ObjectId.isValid(userId) ? { $in: [userId, new mongoose.Types.ObjectId(userId)] } : userId;
        messageCount = await UsageLog.countDocuments({
          user_id: userQuery,
          model_id: { $ne: 'image-generation' },
          timestamp: { $gte: windowStart }
        });
        if (messageCount >= plan.message_limit) {
          const oldestLog = await UsageLog.findOne({
            user_id: userQuery,
            model_id: { $ne: 'image-generation' },
            timestamp: { $gte: windowStart }
          }).sort({ timestamp: 1 }).select('timestamp').lean();
          if (oldestLog) {
            resetTimeMinutes = Math.max(1, Math.ceil((new Date(oldestLog.timestamp).getTime() + plan.window_hours * 60 * 60 * 1000 - Date.now()) / (60 * 1000)));
          }
        }
        queriedMongoMessage = true;
      } catch (mongoErr) {
        console.warn('[RateLimit Message Mongo Warning, falling back to memory/Supabase]:', mongoErr.message);
        queriedMongoMessage = false;
      }
    }

    if (!queriedMongoMessage) {
      const usageDetails = await getUserUsageDetails(userId, plan.window_hours);
      const memCount = (memoryStore.usageLogs || []).filter(l => String(l.user_id) === userId && l.model_id !== 'image-generation' && new Date(l.timestamp) >= windowStart).length;
      messageCount = Math.max(usageDetails.count, memCount);
      resetTimeMinutes = usageDetails.resetInMinutes;
    }

    if (messageCount >= plan.message_limit) {
      res.setHeader('Retry-After', Math.max(1, Math.ceil(resetTimeMinutes * 60)));
      return res.status(429).json({
        success: false,
        error: `বার্তা সীমা শেষ! ${plan.displayName}-এ প্রতি ${plan.window_hours} ঘণ্টায় সর্বোচ্চ ${plan.message_limit}টি বার্তা পাঠানো যায়। আবার ${resetTimeMinutes} মিনিট পর চেষ্টা করুন বা প্ল্যান আপগ্রেড করুন।`
      });
    }

    req.currentPlan = plan;
    next();
  } catch (error) {
    console.error('[RateLimit Middleware Error]:', error);
    res.status(500).json({ success: false, error: 'সার্ভার রেট লিমিট ভেরিফিকেশন ব্যর্থ হয়েছে।' });
  }
};

module.exports = { checkRateLimit };
