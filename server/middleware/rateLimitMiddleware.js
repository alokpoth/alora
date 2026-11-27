const mongoose = require('mongoose');
const User = require('../models/User');
const Plan = require('../models/Plan');
const UsageLog = require('../models/UsageLog');
const AiModel = require('../models/AiModel');
const { getIsMongoConnected } = require('../config/db');
const { memoryStore, debouncedSave } = require('../config/memoryStore');
const {
  getModelConfig,
  getUserUsageDetails,
  getModelLimitCost,
  sumUsageLogCosts,
  getUserImageUsageDetails,
  getUserVoiceUsageDetails,
  incrementUserUsage,
  incrementUserImageUsage,
  incrementUserVoiceUsage,
  withUserQuotaLock
} = require('../../utils/getModelConfig');
const { getCachedPlan, setCachedPlan, getCachedModel, setCachedModel, invalidateCachedUser } = require('../config/dbCache');
const { PLAN_HIERARCHY, DEFAULT_PLANS_MAP, normalizePlanDoc } = require('../utils/planDefaults');
const { canPlanAccessModel, parseModelLimitCost } = require('../utils/secretVault');

const guestMessageTracker = new Map();
const guestImageTracker = new Map();
const guestVoiceTracker = new Map();
const isStrictObjectId = (v) => Boolean(v && typeof v === 'string' && /^[0-9a-fA-F]{24}$/.test(v));

guestMessageTracker.delete('127_0_0_1');
guestMessageTracker.delete('localhost');
guestMessageTracker.delete('_1');
guestVoiceTracker.delete('127_0_0_1');
guestVoiceTracker.delete('localhost');
guestVoiceTracker.delete('_1');

async function lookupModelCached(modelId) {
  if (!modelId) return null;
  let m = getCachedModel(modelId);
  if (!m) {
    if (getIsMongoConnected()) {
      try {
        m = await AiModel.findOne({ $or: [{ model_id: modelId }, { id: modelId }] }).lean();
      } catch {}
    }
    if (!m) m = await getModelConfig(modelId);
    if (m) setCachedModel(modelId, m);
  }
  return m;
}

const checkRateLimit = async (req, res, next) => {
  try {
    const user = req.user;
    const reqPath = req.path || '';
    const origUrl = req.originalUrl || '';
    const isImageRoute = reqPath.startsWith('/image') || origUrl.includes('/chat/image') || origUrl.includes('/image');
    const isVoiceRoute = reqPath.startsWith('/voice') || origUrl.includes('/chat/voice') || origUrl.includes('/voice-live');
    const isSearchRoute = origUrl.startsWith('/api/search') || origUrl.startsWith('/search');

    // Admin users are never rate-limited
    const adminEmails = ['zihanfakir@gmail.com', 'x@zihan.uk'];
    const isVerifiedAdmin = (user && user.role === 'admin') || (user && user.email && adminEmails.includes(user.email.toLowerCase().trim()));
    if (isVerifiedAdmin) {
      req.currentPlan = {
        name: 'Admin',
        displayName: 'অ্যাডমিন',
        message_limit: 999999,
        image_limit: 999999,
        voice_limit: 999999,
        window_hours: 1,
        allowed_models: ['*']
      };
      return next();
    }

    // Resolve IP safely via Express trust proxy
    const headers = req?.headers || {};
    const vercelIp = process.env.VERCEL ? headers['x-vercel-forwarded-for'] : '';
    const resolvedIp = req?.ip || (vercelIp ? String(vercelIp).split(',')[0].trim() : '') || req?.socket?.remoteAddress || '127.0.0.1';
    const cleanIp = String(resolvedIp || '127.0.0.1').replace(/^::ffff:/, '').replace(/[^a-zA-Z0-9]/g, '_');
    const guestId = `guest_${cleanIp}`;

    // 0. Guest User (Not logged in) — Uses dynamic Admin 'Guest' plan configuration
    if (!user) {
      return await withUserQuotaLock(guestId, async () => {
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
        const gVoiceLimit = Number(guestPlan.voice_limit ?? 0);
        const gWinHours = Number(guestPlan.window_hours) || 24;
        const gWinMs = gWinHours * 60 * 60 * 1000;
        const isHostedProd = process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER) || Boolean(process.env.VERCEL);
        const socketAddr = String(req?.socket?.remoteAddress || '').replace(/^::ffff:/, '');
        const isLoopbackSocket = socketAddr === '127.0.0.1' || socketAddr === '::1';
        const isLocalTest = !isHostedProd && isLoopbackSocket && (cleanIp === '127_0_0_1' || cleanIp === 'localhost' || cleanIp === '_1');

        // Global cutoff: if guest message limit is 0 or already reached, ALL features (chat, voice, image, search) stop
        const now = Date.now();
        const guestData = guestMessageTracker.get(cleanIp) || { count: 0, resetAt: now + gWinMs };
        if (now > guestData.resetAt) {
          guestData.count = 0;
          guestData.resetAt = now + gWinMs;
        }
        if (gMsgLimit <= 0) {
          return res.status(401).json({
            success: false,
            code: 'GUEST_LIMIT_REACHED',
            error: 'চ্যাট শুরু করতে অনুগ্রহ করে লগইন বা সাইন-আপ করুন।'
          });
        }
        const guestReqModelId = (!isImageRoute && !isVoiceRoute && !isSearchRoute && req.body && typeof req.body === 'object' && req.body.model)
          ? String(req.body.model).trim()
          : '';
        const gModel = guestReqModelId ? await lookupModelCached(guestReqModelId) : null;
        const gCost = gModel ? getModelLimitCost(gModel) : 1;

        if (!isLocalTest && (isImageRoute || isVoiceRoute || isSearchRoute || gCost > 0) && guestData.count >= gMsgLimit) {
          return res.status(401).json({
            success: false,
            code: 'GUEST_LIMIT_REACHED',
            error: `আপনার ${gMsgLimit}টি ফ্রি বার্তা শেষ হয়েছে। চালিয়ে যেতে অনুগ্রহ করে লগইন বা সাইন-আপ করুন।`
          });
        }

        if (isImageRoute) {
          if (gImgLimit <= 0) {
            return res.status(401).json({
              success: false,
              code: 'PLAN_UPGRADE_REQUIRED',
              error: 'ছবি তৈরি করতে অনুগ্রহ করে প্রথমে লগইন বা সাইন-আপ করুন।'
            });
          }
          if (!isLocalTest) {
            const imgData = guestImageTracker.get(cleanIp) || { count: 0, resetAt: now + gWinMs };
            if (now > imgData.resetAt) { imgData.count = 0; imgData.resetAt = now + gWinMs; }
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

        if (isVoiceRoute) {
          if (gVoiceLimit <= 0) {
            return res.status(401).json({
              success: false,
              code: 'VOICE_LIMIT_REACHED',
              error: 'লাইভ ভয়েস মোড ব্যবহার করতে অনুগ্রহ করে প্রথমে লগইন বা সাইন-আপ করুন।'
            });
          }
          if (!isLocalTest) {
            const voiceData = guestVoiceTracker.get(cleanIp) || { count: 0, resetAt: now + gWinMs };
            if (now > voiceData.resetAt) { voiceData.count = 0; voiceData.resetAt = now + gWinMs; }
            if (voiceData.count >= gVoiceLimit) {
              return res.status(429).json({
                success: false,
                code: 'VOICE_LIMIT_REACHED',
                error: `গেস্ট ভয়েস সীমা (${gVoiceLimit}টি) শেষ হয়েছে। আরও কথা বলতে লগইন বা আপগ্রেড করুন।`
              });
            }
            voiceData.count += 1;
            guestVoiceTracker.set(cleanIp, voiceData);
          }
          req.guestId = guestId;
          req.currentPlan = guestPlan;
          return next();
        }

        if (isSearchRoute) {
          req.guestId = guestId;
          req.currentPlan = guestPlan;
          return next();
        }

        // Enforce model tier & allowed_plans on Guest chat requests
        if (gModel && !canPlanAccessModel(gModel, 'Guest', guestPlan)) {
          const reqTier = gModel.efficient ? 'Max' : 'Plus / Pro';
          return res.status(403).json({
            success: false,
            code: 'PLAN_UPGRADE_REQUIRED',
            error: `'${gModel.name || guestReqModelId}' মডেলটি ব্যবহারের জন্য লগইন এবং ${reqTier} প্ল্যান প্রয়োজন।`
          });
        }

        if (isLocalTest) {
          req.guestId = guestId;
          req.modelLimitCost = gCost;
          req.currentPlan = { ...guestPlan, message_limit: 99999, voice_limit: 99999 };
          return next();
        }

        if (gCost > 0 && (guestData.count + gCost) > gMsgLimit) {
          const gRem = Math.max(0, Math.round((gMsgLimit - guestData.count) * 100) / 100);
          return res.status(401).json({
            success: false,
            code: 'MODEL_LIMIT_INSUFFICIENT',
            requiredCost: gCost,
            remaining: gRem,
            error: `'${gModel?.name || guestReqModelId || 'এই'}' মডেলের প্রতি বার্তায় ${gCost}টি লিমিট লাগে; আপনার গেস্ট সীমায় ${gRem}টি অবশিষ্ট আছে। কম খরচের মডেল বেছে নিন বা লগইন করুন।`
          });
        }

        guestData.count = Math.round((guestData.count + gCost) * 100) / 100;
        guestMessageTracker.set(cleanIp, guestData);
        req.guestId = guestId;
        req.modelLimitCost = gCost;
        req.currentPlan = guestPlan;
        return next();
      });
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

    // 2. Fetch Current Plan Configuration
    const currentPlanName = (user.subscription && user.subscription.plan_name) ? user.subscription.plan_name : 'Free';
    let plan = getCachedPlan(currentPlanName);
    if (!plan) {
      if (getIsMongoConnected()) {
        try {
          plan = await Plan.findOne({ name: currentPlanName }).lean();
        } catch (pErr) {
          plan = null;
        }
      }
      if (!plan) {
        const { getPersistedPlans } = require('../../utils/getModelConfig');
        const plans = await getPersistedPlans();
        plan = plans.find(p => p.name === currentPlanName);
      }
      if (plan) setCachedPlan(currentPlanName, plan);
    }

    plan = normalizePlanDoc(plan || DEFAULT_PLANS_MAP[currentPlanName] || DEFAULT_PLANS_MAP.Free);
    setCachedPlan(currentPlanName, plan);

    const userId = String(user._id || user.id);
    const windowStart = new Date(Date.now() - plan.window_hours * 60 * 60 * 1000);

    return await withUserQuotaLock(userId, async () => {
      // 3. Global Message Quota Check FIRST: when message_limit is reached, ALL features stop cleanly!
      let messageCount = 0;
      let msgResetMinutes = Math.round(plan.window_hours * 60);
      const cachedMsgDetails = await getUserUsageDetails(userId, plan.window_hours);
      messageCount = cachedMsgDetails.count;
      msgResetMinutes = cachedMsgDetails.resetInMinutes;

      if (getIsMongoConnected()) {
        try {
          const userQuery = isStrictObjectId(userId) ? { $in: [userId, new mongoose.Types.ObjectId(userId)] } : userId;
          const aggRes = await UsageLog.aggregate([
            {
              $match: {
                user_id: userQuery,
                model_id: { $nin: ['image-generation', 'voice-live'] },
                timestamp: { $gte: windowStart }
              }
            },
            { $group: { _id: null, totalCost: { $sum: { $ifNull: ['$cost', 1] } } } }
          ]);
          const dbMsgCount = (aggRes && aggRes[0]) ? Math.round((Number(aggRes[0].totalCost) || 0) * 100) / 100 : 0;
          if (dbMsgCount > messageCount) messageCount = dbMsgCount;
          if (messageCount >= plan.message_limit) {
            const oldestLog = await UsageLog.findOne({
              user_id: userQuery,
              model_id: { $nin: ['image-generation', 'voice-live'] },
              timestamp: { $gte: windowStart }
            }).sort({ timestamp: 1 }).select('timestamp').lean();
            if (oldestLog) {
              msgResetMinutes = Math.max(1, Math.ceil((new Date(oldestLog.timestamp).getTime() + plan.window_hours * 60 * 60 * 1000 - Date.now()) / (60 * 1000)));
            }
          }
        } catch {}
      }

      const preChatModelId = (!isImageRoute && !isVoiceRoute && !isSearchRoute && req.body && typeof req.body === 'object' && req.body.model)
        ? String(req.body.model).trim()
        : (!isImageRoute && !isVoiceRoute && !isSearchRoute ? 'openrouter/free' : '');
      const preChatAiModel = preChatModelId ? await lookupModelCached(preChatModelId) : null;
      const preChatCost = preChatAiModel ? getModelLimitCost(preChatAiModel) : 1;

      if (messageCount >= plan.message_limit && (isImageRoute || isVoiceRoute || isSearchRoute || !(plan.message_limit > 0 && preChatCost === 0))) {
        res.setHeader('Retry-After', Math.max(1, Math.ceil(msgResetMinutes * 60)));
        return res.status(429).json({
          success: false,
          code: 'MESSAGE_LIMIT_REACHED',
          error: `বার্তা সীমা শেষ! ${plan.displayName}-এ প্রতি ${plan.window_hours} ঘণ্টায় সর্বোচ্চ ${plan.message_limit}টি বার্তা পাঠানো যায়। আবার ${msgResetMinutes} মিনিট পর চেষ্টা করুন বা প্ল্যান আপগ্রেড করুন।`
        });
      }

      if (isSearchRoute) {
        req.currentPlan = plan;
        return next();
      }

      // 4. Image Generation Limit & Model Check
      if (isImageRoute) {
        if (plan.image_limit <= 0) {
          return res.status(403).json({
            success: false,
            code: 'PLAN_UPGRADE_REQUIRED',
            error: `আপনার বর্তমান ${plan.displayName || plan.name} প্ল্যানে ইমেজ জেনারেশন চালু নেই। ছবি তৈরি করতে উচ্চতর প্ল্যানে আপগ্রেড করুন।`
          });
        }

        const reqImgModelId = (req.body && typeof req.body.model === 'string' && req.body.model.trim()) ? req.body.model.trim() : '';
        if (reqImgModelId) {
          const imgModelCfg = await lookupModelCached(reqImgModelId);
          if (imgModelCfg && Array.isArray(imgModelCfg.allowed_plans) && imgModelCfg.allowed_plans.length > 0 && !canPlanAccessModel(imgModelCfg, currentPlanName, plan)) {
            return res.status(403).json({
              success: false,
              code: 'PLAN_UPGRADE_REQUIRED',
              error: `আপনার বর্তমান ${plan.displayName || currentPlanName}-এ '${imgModelCfg.name || reqImgModelId}' ইমেজ মডেল ব্যবহারের অনুমতি নেই।`
            });
          }
        }

        const imgDetails = await getUserImageUsageDetails(userId, plan.window_hours);
        let imageCount = imgDetails.count;
        let resetTimeMinutes = imgDetails.resetInMinutes;

        if (getIsMongoConnected()) {
          try {
            const userQuery = isStrictObjectId(userId) ? { $in: [userId, new mongoose.Types.ObjectId(userId)] } : userId;
            const dbImgCount = await UsageLog.countDocuments({
              user_id: userQuery,
              model_id: 'image-generation',
              timestamp: { $gte: windowStart }
            });
            if (dbImgCount > imageCount) imageCount = dbImgCount;
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
          } catch {}
        }

        if (imageCount >= plan.image_limit) {
          res.setHeader('Retry-After', Math.max(1, Math.ceil(resetTimeMinutes * 60)));
          return res.status(429).json({
            success: false,
            code: 'IMAGE_LIMIT_REACHED',
            error: `ছবি তৈরির সীমা শেষ! ${plan.displayName || plan.name}-এ প্রতি ${plan.window_hours} ঘণ্টায় সর্বোচ্চ ${plan.image_limit}টি ছবি তৈরি করা যায়। আবার ${resetTimeMinutes} মিনিট পর চেষ্টা করুন বা প্ল্যান আপগ্রেড করুন।`
          });
        }

        await incrementUserImageUsage(userId, plan.window_hours);
        req._quotaCacheReserved = 'image';
        req.currentPlan = plan;
        return next();
      }

      // 5. Dedicated Live Voice Limit & Voice Model Check
      if (isVoiceRoute) {
        if (plan.voice_limit <= 0) {
          return res.status(403).json({
            success: false,
            code: 'PLAN_UPGRADE_REQUIRED',
            error: `আপনার বর্তমান ${plan.displayName || plan.name} প্ল্যানে লাইভ ভয়েস চালু নেই। লাইভ ভয়েস ব্যবহার করতে প্ল্যান আপগ্রেড করুন।`
          });
        }

        const reqVoiceModelId = (req.body && typeof (req.body.voice_model || req.body.chat_model || req.body.model) === 'string')
          ? String(req.body.voice_model || req.body.chat_model || req.body.model).trim()
          : '';
        if (reqVoiceModelId) {
          const vModelCfg = await lookupModelCached(reqVoiceModelId);
          if (vModelCfg && !canPlanAccessModel(vModelCfg, currentPlanName, plan)) {
            return res.status(403).json({
              success: false,
              code: 'PLAN_UPGRADE_REQUIRED',
              error: `আপনার বর্তমান ${plan.displayName || currentPlanName}-এ '${vModelCfg.name || reqVoiceModelId}' ভয়েস মডেল ব্যবহারের অনুমতি নেই।`
            });
          }
        }

        const voiceDetails = await getUserVoiceUsageDetails(userId, plan.window_hours);
        let voiceCount = voiceDetails.count;
        let resetTimeMinutes = voiceDetails.resetInMinutes;

        if (getIsMongoConnected()) {
          try {
            const userQuery = isStrictObjectId(userId) ? { $in: [userId, new mongoose.Types.ObjectId(userId)] } : userId;
            const dbVoiceCount = await UsageLog.countDocuments({
              user_id: userQuery,
              model_id: 'voice-live',
              timestamp: { $gte: windowStart }
            });
            if (dbVoiceCount > voiceCount) voiceCount = dbVoiceCount;
            if (voiceCount >= plan.voice_limit) {
              const oldestLog = await UsageLog.findOne({
                user_id: userQuery,
                model_id: 'voice-live',
                timestamp: { $gte: windowStart }
              }).sort({ timestamp: 1 }).select('timestamp').lean();
              if (oldestLog) {
                resetTimeMinutes = Math.max(1, Math.ceil((new Date(oldestLog.timestamp).getTime() + plan.window_hours * 60 * 60 * 1000 - Date.now()) / (60 * 1000)));
              }
            }
          } catch {}
        }

        if (voiceCount >= plan.voice_limit) {
          res.setHeader('Retry-After', Math.max(1, Math.ceil(resetTimeMinutes * 60)));
          return res.status(429).json({
            success: false,
            code: 'VOICE_LIMIT_REACHED',
            error: `ভয়েস কথোপকথনের সীমা শেষ! ${plan.displayName || plan.name}-এ প্রতি ${plan.window_hours} ঘণ্টায় সর্বোচ্চ ${plan.voice_limit}টি লাইভ ভয়েস টার্ন ব্যবহার করা যায়। আবার ${resetTimeMinutes} মিনিট পর চেষ্টা করুন বা প্ল্যান আপগ্রেড করুন।`
          });
        }

        await incrementUserVoiceUsage(userId, plan.window_hours);
        req._quotaCacheReserved = 'voice';
        req.currentPlan = plan;
        return next();
      }

      // 6. Model Access Permission Check (for text chat)
      const model_id = preChatModelId || ((req.body && typeof req.body === 'object' && req.body.model) ? String(req.body.model).trim() : 'openrouter/free');
      const aiModel = preChatAiModel || await lookupModelCached(model_id);

      if (aiModel && !canPlanAccessModel(aiModel, currentPlanName, plan)) {
        const isMaxModel = Boolean(aiModel.efficient);
        const isProModel = Boolean(aiModel.premium) && !isMaxModel;
        let errText = `আপনার বর্তমান ${plan.displayName || currentPlanName}-এ '${aiModel.name || model_id}' মডেল ব্যবহারের অনুমতি নেই।`;
        if (!Array.isArray(aiModel.allowed_plans) || aiModel.allowed_plans.length === 0) {
          if (isMaxModel && (PLAN_HIERARCHY[currentPlanName] || 1) < PLAN_HIERARCHY.Max) {
            errText = `'${aiModel.name || model_id}' মডেলটি ব্যবহারের জন্য Max প্ল্যান প্রয়োজন। আপনার বর্তমান প্ল্যান: ${plan.displayName || currentPlanName}।`;
          } else if (isProModel && (PLAN_HIERARCHY[currentPlanName] || 1) < PLAN_HIERARCHY.Plus) {
            errText = `'${aiModel.name || model_id}' মডেলটি ব্যবহারের জন্য Plus বা Pro প্ল্যান প্রয়োজন। আপনার বর্তমান প্ল্যান: ${plan.displayName || currentPlanName}।`;
          }
        }
        return res.status(403).json({
          success: false,
          code: 'PLAN_UPGRADE_REQUIRED',
          error: errText
        });
      }

      // If no AiModel doc exists but plan has explicit non-wildcard allowed_models, still honor plan.allowed_models
      if (!aiModel && Array.isArray(plan.allowed_models) && plan.allowed_models.length > 0 && !plan.allowed_models.includes('*')) {
        if (!plan.allowed_models.includes(model_id)) {
          return res.status(403).json({
            success: false,
            code: 'PLAN_UPGRADE_REQUIRED',
            error: `আপনার বর্তমান ${plan.displayName || currentPlanName}-এ '${model_id}' মডেল ব্যবহারের অনুমতি নেই।`
          });
        }
      }

      const modelCost = getModelLimitCost(aiModel);
      if (modelCost > 0 && (messageCount + modelCost) > plan.message_limit) {
        const remainingCredits = Math.max(0, Math.round((plan.message_limit - messageCount) * 100) / 100);
        res.setHeader('Retry-After', Math.max(1, Math.ceil(msgResetMinutes * 60)));
        if (messageCount >= plan.message_limit) {
          return res.status(429).json({
            success: false,
            code: 'MESSAGE_LIMIT_REACHED',
            error: `বার্তা সীমা শেষ! ${plan.displayName}-এ প্রতি ${plan.window_hours} ঘণ্টায় সর্বোচ্চ ${plan.message_limit}টি বার্তা পাঠানো যায়। আবার ${msgResetMinutes} মিনিট পর চেষ্টা করুন বা প্ল্যান আপগ্রেড করুন।`
          });
        }
        return res.status(429).json({
          success: false,
          code: 'MODEL_LIMIT_INSUFFICIENT',
          requiredCost: modelCost,
          remaining: remainingCredits,
          error: `'${aiModel?.name || model_id}' মডেলের প্রতি বার্তায় ${modelCost}টি লিমিট লাগে, আপনার ${remainingCredits}টি অবশিষ্ট আছে। কম খরচের মডেল বেছে নিন অথবা প্ল্যান আপগ্রেড করুন।`
        });
      }

      await incrementUserUsage(userId, plan.window_hours, modelCost);
      req._quotaCacheReserved = 'message';
      req.modelLimitCost = modelCost;
      req.currentPlan = plan;
      return next();
    });
  } catch (error) {
    console.error('[RateLimit Middleware Error]:', error);
    res.status(500).json({ success: false, error: 'সার্ভার রেট লিমিট ভেরিফিকেশন ব্যর্থ হয়েছে।' });
  }
};

module.exports = { checkRateLimit, lookupModelCached };
