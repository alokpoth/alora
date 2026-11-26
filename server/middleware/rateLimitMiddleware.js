const mongoose = require('mongoose');
const User = require('../models/User');
const Plan = require('../models/Plan');
const UsageLog = require('../models/UsageLog');
const AiModel = require('../models/AiModel');
const { getIsMongoConnected } = require('../config/db');
const { memoryStore, debouncedSave } = require('../config/memoryStore');
const { getModelConfig, getUserUsageDetails, getUserImageUsageDetails } = require('../../utils/getModelConfig');
const { getCachedPlan, setCachedPlan, getCachedModel, setCachedModel, invalidateCachedUser } = require('../config/dbCache');
const { PLAN_HIERARCHY, DEFAULT_PLANS_MAP, normalizePlanDoc } = require('../utils/planDefaults');

const guestMessageTracker = new Map();
const guestImageTracker = new Map();
const isStrictObjectId = (v) => Boolean(v && typeof v === 'string' && /^[0-9a-fA-F]{24}$/.test(v));
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

    // Resolve IP safely via Express trust proxy (never trust client-spoofed CF-Connecting-IP / X-Real-IP headers)
    const headers = req?.headers || {};
    const vercelIp = process.env.VERCEL ? headers['x-vercel-forwarded-for'] : '';
    const resolvedIp = req?.ip || (vercelIp ? String(vercelIp).split(',')[0].trim() : '') || req?.socket?.remoteAddress || '127.0.0.1';
    const cleanIp = String(resolvedIp || '127.0.0.1').replace(/^::ffff:/, '').replace(/[^a-zA-Z0-9]/g, '_');
    const guestId = `guest_${cleanIp}`;

    // 0. Guest User (Not logged in) — Uses dynamic Admin 'Guest' plan configuration
    if (!user) {
      let guestPlan = null;
      if (getIsMongoConnected()) {
        try { guestPlan = await Plan.findOne({ name: 'Guest' }).lean(); } catch {}
      }
      if (!guestPlan) {
        const { getPersistedPlans } = require('../../utils/getModelConfig');
        const plans = await getPersistedPlans();
        guestPlan = plans.find(p => p.name === 'Guest');
      }
      guestPlan = normalizePlanDoc(guestPlan || DEFAULT_PLANS_MAP.Guest);
      const gMsgLimit = Number(guestPlan.message_limit);
      const gImgLimit = Number(guestPlan.image_limit);
      const gWinHours = Number(guestPlan.window_hours) || 3;
      const gWinMs = gWinHours * 60 * 60 * 1000;
      const isHostedProd = process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER) || Boolean(process.env.VERCEL);
      const socketAddr = String(req?.socket?.remoteAddress || '').replace(/^::ffff:/, '');
      const isLoopbackSocket = socketAddr === '127.0.0.1' || socketAddr === '::1';
      const isLocalTest = !isHostedProd && isLoopbackSocket && (cleanIp === '127_0_0_1' || cleanIp === 'localhost' || cleanIp === '_1');

      if (isImageRoute) {
        if (gImgLimit <= 0) {
          return res.status(401).json({
            success: false,
            error: 'ছবি তৈরি করতে অনুগ্রহ করে প্রথমে লগইন বা সাইন-আপ করুন।'
          });
        }
        if (!isLocalTest) {
          const nowImg = Date.now();
          const imgData = guestImageTracker.get(cleanIp) || { count: 0, resetAt: nowImg + gWinMs };
          if (nowImg > imgData.resetAt) { imgData.count = 0; imgData.resetAt = nowImg + gWinMs; }
          if (imgData.count >= gImgLimit) {
            return res.status(401).json({
              success: false,
              code: 'GUEST_LIMIT_REACHED',
              error: `গেস্ট ছবি তৈরির সীমা (${gImgLimit}টি) শেষ হয়েছে। আরও ছবি তৈরি করতে লগইন করুন।`
            });
          }
          imgData.count += 1;
          guestImageTracker.set(cleanIp, imgData);
        }
        req.guestId = guestId;
        req.currentPlan = guestPlan;
        return next();
      }

      // Enforce model tier on Guest requests (Free models allowed; Plus/Pro/Max models require account & plan)
      const guestReqModelId = (req.body && typeof req.body === 'object' && req.body.model) ? String(req.body.model).trim() : '';
      if (guestReqModelId) {
        let gModel = getCachedModel(guestReqModelId);
        if (!gModel) {
          if (getIsMongoConnected()) {
            try { gModel = await AiModel.findOne({ $or: [{ model_id: guestReqModelId }, { id: guestReqModelId }] }).lean(); } catch {}
          }
          if (!gModel) gModel = await getModelConfig(guestReqModelId);
          if (gModel) setCachedModel(guestReqModelId, gModel);
        }
        if (gModel && (gModel.efficient || gModel.premium)) {
          const reqTier = gModel.efficient ? 'Max' : 'Plus / Pro';
          return res.status(403).json({
            success: false,
            code: 'PLAN_UPGRADE_REQUIRED',
            error: `'${gModel.name || guestReqModelId}' মডেলটি ব্যবহারের জন্য লগইন এবং ${reqTier} প্ল্যান প্রয়োজন।`
          });
        }
      }

      if (gMsgLimit <= 0) {
        return res.status(401).json({
          success: false,
          code: 'GUEST_LIMIT_REACHED',
          error: 'চ্যাট শুরু করতে অনুগ্রহ করে লগইন বা সাইন-আপ করুন।'
        });
      }

      // Never rate-limit localhost testing when guest messaging is enabled
      if (isLocalTest) {
        req.guestId = guestId;
        req.currentPlan = { ...guestPlan, message_limit: 99999 };
        return next();
      }

      const now = Date.now();
      const guestData = guestMessageTracker.get(cleanIp) || { count: 0, resetAt: now + gWinMs };
      if (now > guestData.resetAt) {
        guestData.count = 0;
        guestData.resetAt = now + gWinMs;
      }
      if (guestData.count >= gMsgLimit) {
        return res.status(401).json({
          success: false,
          code: 'GUEST_LIMIT_REACHED',
          error: `আপনার ${gMsgLimit}টি ফ্রি বার্তা শেষ হয়েছে। চ্যাট চালিয়ে যেতে অনুগ্রহ করে লগইন বা সাইন-আপ করুন।`
        });
      }
      guestData.count += 1;
      guestMessageTracker.set(cleanIp, guestData);
      req.guestId = guestId;
      req.currentPlan = guestPlan;
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
            const q = isStrictObjectId(String(uId || '')) ? { _id: String(uId) } : (user.email ? { email: String(user.email).toLowerCase().trim() } : null);
            if (q) {
              await User.updateOne(q, { $set: { subscription: user.subscription } }).catch(() => {});
            }
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
      plan = { ...(DEFAULT_PLANS_MAP[currentPlanName] || DEFAULT_PLANS_MAP.Free) };
      setCachedPlan(currentPlanName, plan);
    } else {
      plan = normalizePlanDoc(plan);
    }
    plan.message_limit = Number(plan.message_limit) || 10;
    plan.window_hours = Number(plan.window_hours) || 3;
    plan.image_limit = (plan.image_limit !== undefined && plan.image_limit !== null && !isNaN(Number(plan.image_limit)) && Number(plan.image_limit) >= 0) ? Number(plan.image_limit) : 5;

    const userId = String(user._id || user.id);
    const windowStart = new Date(Date.now() - plan.window_hours * 60 * 60 * 1000);

    // 3. Image Generation Limit Check
    if (isImageRoute) {
      let imageCount = 0;
      let resetTimeMinutes = Math.round(plan.window_hours * 60);

      let queriedMongo = false;
      if (getIsMongoConnected()) {
        try {
          const userQuery = isStrictObjectId(userId) ? { $in: [userId, new mongoose.Types.ObjectId(userId)] } : userId;
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

    const isMaxModel = Boolean(aiModel && aiModel.efficient);
    const isProModel = Boolean(aiModel && aiModel.premium) && !isMaxModel;
    const isFreeModel = !isMaxModel && !isProModel;

    const explicitlyAllowedByName = Array.isArray(plan.allowed_models) && (
      plan.allowed_models.includes(model_id) ||
      (aiModel && (plan.allowed_models.includes(aiModel.id) || plan.allowed_models.includes(aiModel.model_id)))
    );
    const hasWildcard = !Array.isArray(plan.allowed_models) || plan.allowed_models.length === 0 || plan.allowed_models.includes('*');
    const userTier = PLAN_HIERARCHY[currentPlanName] || 1;

    if (!isVerifiedAdmin) {
      // Check explicit custom allowed_models whitelist first if not wildcard
      if (!hasWildcard) {
        if (!explicitlyAllowedByName) {
          return res.status(403).json({
            success: false,
            code: 'PLAN_UPGRADE_REQUIRED',
            error: `আপনার বর্তমান ${plan.displayName || currentPlanName}-এ '${aiModel?.name || model_id}' মডেল ব্যবহারের অনুমতি নেই।`
          });
        }
      } else {
        // Default tier model rules when allowed_models is ['*']:
        // Max unlocks all models (including frontier/efficient).
        // Plus & Pro unlock premium reasoning models (not efficient/frontier).
        // Free & Go unlock standard models unless explicitly whitelisted.
        if (isMaxModel && userTier < PLAN_HIERARCHY.Max) {
          return res.status(403).json({
            success: false,
            code: 'PLAN_UPGRADE_REQUIRED',
            error: `'${aiModel?.name || model_id}' মডেলটি ব্যবহারের জন্য Max প্ল্যান প্রয়োজন। আপনার বর্তমান প্ল্যান: ${plan.displayName || currentPlanName}।`
          });
        }
        if (isProModel && userTier < PLAN_HIERARCHY.Plus) {
          return res.status(403).json({
            success: false,
            code: 'PLAN_UPGRADE_REQUIRED',
            error: `'${aiModel?.name || model_id}' মডেলটি ব্যবহারের জন্য Plus বা Pro প্ল্যান প্রয়োজন। আপনার বর্তমান প্ল্যান: ${plan.displayName || currentPlanName}।`
          });
        }
      }
    }

    // 5. Dynamic Window Message Rate Limit Check
    let messageCount = 0;
    let resetTimeMinutes = Math.round(plan.window_hours * 60);

    let queriedMongoMessage = false;
    if (getIsMongoConnected()) {
      try {
        const userQuery = isStrictObjectId(userId) ? { $in: [userId, new mongoose.Types.ObjectId(userId)] } : userId;
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
