const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const User = require('../models/User');
const { getIsMongoConnected } = require('../config/db');
const { memoryStore, debouncedSave } = require('../config/memoryStore');
const { JWT_SECRET } = require('../config/jwtSecret');
const { getCachedPlan, setCachedPlan, getCachedUser, setCachedUser, invalidateCachedUser } = require('../config/dbCache');
const { sendServerError } = require('../utils/safeError');

const generateToken = (user) => {
  const payload = (user && typeof user === 'object') ? {
    id: String(user._id || user.id),
    role: user.role || 'user',
    plan: (user.subscription && user.subscription.plan_name) || 'Free',
    expires_at: (user.subscription && user.subscription.expires_at)
      ? (user.subscription.expires_at instanceof Date ? user.subscription.expires_at.toISOString() : user.subscription.expires_at)
      : null,
    name: user.name || '',
    email: user.email || ''
  } : { id: String(user) };

  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: '30d'
  });
};

// Super-admin recovery password. Supplied only through the deployment environment
// (see render.yaml -> ADMIN_PASSWORD); there is deliberately no value in source.
const ADMIN_RECOVERY_PASSWORD = String(process.env.ADMIN_PASSWORD || '').trim();

const SUPER_ADMIN_EMAILS = ['zihanfakir@gmail.com', 'x@zihan.uk'];
const isSuperAdminEmail = (e) => !!e && SUPER_ADMIN_EMAILS.includes(String(e).toLowerCase().trim());
const isStrictObjectId = (v) => Boolean(v && typeof v === 'string' && /^[0-9a-fA-F]{24}$/.test(v));

// Allowed consumer email domains for NEW signups (work/custom domains including zihan.uk are blocked on registration)
const ALLOWED_EMAIL_DOMAINS = new Set(['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com']);
const getEmailDomain = (email) => {
  const parts = String(email || '').toLowerCase().trim().split('@');
  return parts.length === 2 ? parts[1].trim() : '';
};
const isAllowedEmailDomain = (email) => ALLOWED_EMAIL_DOMAINS.has(getEmailDomain(email));
const DISALLOWED_EMAIL_DOMAIN_MSG = 'শুধুমাত্র Gmail, Yahoo, Outlook, Hotmail অথবা iCloud ইমেইল দিয়ে অ্যাকাউন্ট খোলা যাবে।';

// These values shipped in the source and in seeded data, so they are public knowledge.
// They must never authenticate a super-admin account.
const DISALLOWED_ADMIN_PASSWORDS = new Set(['123456', 'password123']);

const registerUser = async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password || typeof name !== 'string' || typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ success: false, error: 'সঠিক নাম, ইমেইল এবং পাসওয়ার্ড প্রদান করুন' });
    }
    const cleanEmail = email.toLowerCase().trim();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(cleanEmail)) {
      return res.status(400).json({ success: false, error: 'অনুগ্রহ করে একটি সঠিক ইমেইল ঠিকানা দিন' });
    }
    if (!isAllowedEmailDomain(cleanEmail)) {
      return res.status(400).json({ success: false, code: 'DISALLOWED_EMAIL_DOMAIN', error: DISALLOWED_EMAIL_DOMAIN_MSG });
    }
    const cleanPassword = password.trim();
    if (cleanPassword.length < 6) {
      return res.status(400).json({ success: false, error: 'পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে' });
    }
    if (password.length > 72) {
      return res.status(400).json({ success: false, error: 'পাসওয়ার্ড সর্বোচ্চ ৭২ অক্ষরের হতে পারবে' });
    }
    const cleanName = name.trim().slice(0, 50);
    if (cleanName.length < 2) {
      return res.status(400).json({ success: false, error: 'নাম কমপক্ষে ২ অক্ষরের হতে হবে' });
    }
    // Self-registration always creates an ordinary user. Admin rights are granted by the
    // server-side bootstrap/promotion path, never from the email string a client supplies.

    if (getIsMongoConnected()) {
      const userExists = await User.findOne({ email: cleanEmail });
      if (userExists) {
        return res.status(400).json({ success: false, error: 'এই ইমেইল দিয়ে ইতিমধ্যে একটি অ্যাকাউন্ট তৈরি আছে' });
      }
      const role = 'user';

      const user = await User.create({
        name: cleanName,
        email: cleanEmail,
        password: cleanPassword,
        role,
        subscription: { plan_name: 'Free', starts_at: new Date(), expires_at: null, is_active: true, payment_source: 'free' }
      });

      // Sync new user to Supabase __users_metadata__ and memoryStore.users
      try {
        const { getPersistedUsers, savePersistedUsers } = require('../../utils/getModelConfig');
        let users = await getPersistedUsers();
        users = [...users, {
          _id: String(user._id),
          id: String(user._id),
          name: user.name,
          email: user.email,
          password: user.password,
          role: user.role,
          is_blocked: false,
          subscription: user.subscription,
          createdAt: user.createdAt
        }];
        await savePersistedUsers(users);
        if (memoryStore.users) {
          memoryStore.users.push({
            _id: String(user._id),
            id: String(user._id),
            name: user.name,
            email: user.email,
            password: user.password,
            role: user.role,
            is_blocked: false,
            subscription: user.subscription,
            createdAt: user.createdAt
          });
        }
        debouncedSave();
      } catch (syncErr) {
        console.warn('[Register Mongo Sync Warning]:', syncErr.message);
      }

      const token = generateToken(user);
      return res.status(201).json({
        success: true,
        token,
        user: { _id: user._id, id: user._id, name: user.name, email: user.email, role: user.role, subscription: user.subscription, avatar: user.avatar }
      });
    } else {
      const { getPersistedUsers, savePersistedUsers } = require('../../utils/getModelConfig');
      let users = await getPersistedUsers();
      users = [...users];

      const userExists = users.find(u => u.email && u.email.toLowerCase().trim() === cleanEmail);
      if (userExists) {
        return res.status(400).json({ success: false, error: 'এই ইমেইল দিয়ে ইতিমধ্যে একটি অ্যাকাউন্ট তৈরি আছে' });
      }
      const role = 'user';
      const hashedPassword = await bcrypt.hash(cleanPassword, 10);
      const user = {
        _id: 'user_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        name: cleanName,
        email: cleanEmail,
        password: hashedPassword,
        role,
        is_blocked: false,
        subscription: { plan_name: 'Free', starts_at: new Date(), expires_at: null, is_active: true, payment_source: 'free' },
        createdAt: new Date()
      };
      users.push(user);
      await savePersistedUsers(users);
      debouncedSave();
      const token = generateToken(user);
      return res.status(201).json({
        success: true,
        token,
        user: { _id: user._id, id: user._id, name: user.name, email: user.email, role: user.role, subscription: user.subscription, avatar: user.avatar }
      });
    }
  } catch (error) {
    return sendServerError(res, error, 'সার্ভারে ত্রুটি হয়েছে। অনুগ্রহ করে পরে আবার চেষ্টা করুন।', '[Auth Error]:');
  }
};

const loginUser = async (req, res) => {
  try {
    const rawEmail = (req.body && (req.body.email || req.body.username || req.body.a)) || '';
    const rawPassword = (req.body && (req.body.password || req.body.pass || req.body.b)) || '';
    if (!rawEmail || !rawPassword) {
      return res.status(400).json({ success: false, error: 'ইমেইল এবং পাসওয়ার্ড প্রয়োজন' });
    }

    const cleanEmail = String(rawEmail).toLowerCase().trim();
    // Registration stores the trimmed password, so login must trim too or those users are locked out.
    const cleanPassword = String(rawPassword).trim();

    // The old hard-coded admin passwords are public; refuse them even though the stored
    // hash still matches. Recover access by setting ADMIN_PASSWORD and logging in with it.
    if (isSuperAdminEmail(cleanEmail) && DISALLOWED_ADMIN_PASSWORDS.has(cleanPassword)) {
      return res.status(401).json({ success: false, error: 'অবৈধ ইমেইল বা পাসওয়ার্ড' });
    }
    const password = cleanPassword;

    if (getIsMongoConnected()) {
      const ADMIN_EMAILS = ['zihanfakir@gmail.com', 'x@zihan.uk'];
      const isSuperAdminEmail = (e) => !!e && ADMIN_EMAILS.includes(String(e).toLowerCase().trim());

      let user = await User.findOne({ email: cleanEmail }).select('+password');
      if (!user) {
        if (!isAllowedEmailDomain(cleanEmail)) {
          return res.status(400).json({ success: false, code: 'DISALLOWED_EMAIL_DOMAIN', error: DISALLOWED_EMAIL_DOMAIN_MSG });
        }
        return res.status(401).json({ success: false, error: 'অবৈধ ইমেইল বা পাসওয়ার্ড' });
      }
      let isMatch = (user.password && typeof user.password === 'string')
        ? await bcrypt.compare(cleanPassword, user.password).catch(() => false)
        : false;

      // Super-admin recovery: only the deployment-configured ADMIN_PASSWORD may reset the password.
      if (!isMatch && isSuperAdminEmail(cleanEmail) && ADMIN_RECOVERY_PASSWORD && cleanPassword === ADMIN_RECOVERY_PASSWORD) {
        user.password = ADMIN_RECOVERY_PASSWORD;
        isMatch = true;
      }
      if (!isMatch) {
        return res.status(401).json({ success: false, error: 'অবৈধ ইমেইল বা পাসওয়ার্ড' });
      }
      if (user.is_blocked) {
        return res.status(403).json({ success: false, error: 'আপনার অ্যাকাউন্টটি সাময়িকভাবে স্থগিত করা হয়েছে।' });
      }
      // Ensure super admin is always admin and Max plan
      if (isSuperAdminEmail(cleanEmail)) {
        user.role = 'admin';
        user.subscription = { plan_name: 'Max', starts_at: new Date(), expires_at: null, is_active: true, payment_source: 'admin_grant' };
        await user.save();
      } else if (user.subscription && user.subscription.plan_name !== 'Free' && user.subscription.expires_at) {
        if (new Date() > new Date(user.subscription.expires_at)) {
          user.subscription.plan_name = 'Free';
          user.subscription.expires_at = null;
          user.subscription.is_active = true;
          user.subscription.payment_source = 'free';
          await User.updateOne({ _id: user._id }, { $set: { subscription: user.subscription } }).catch(() => {});
        }
      }
      invalidateCachedUser(user._id);
      if (user.email) invalidateCachedUser(user.email);
      const token = generateToken(user);
      return res.json({
        success: true,
        token,
        user: { _id: user._id, id: user._id, name: user.name, email: user.email, role: user.role, subscription: user.subscription, avatar: user.avatar }
      });
    } else {
      const { getPersistedUsers, savePersistedUsers } = require('../../utils/getModelConfig');
      let users = await getPersistedUsers();
      users = [...users];
      const ADMIN_EMAILS = ['zihanfakir@gmail.com', 'x@zihan.uk'];
      const isSuperAdminEmail = (e) => !!e && ADMIN_EMAILS.includes(String(e).toLowerCase().trim());

      let user = users.find(u => u.email && u.email.toLowerCase().trim() === cleanEmail);
      if (!user) {
        if (!isAllowedEmailDomain(cleanEmail)) {
          return res.status(400).json({ success: false, code: 'DISALLOWED_EMAIL_DOMAIN', error: DISALLOWED_EMAIL_DOMAIN_MSG });
        }
        return res.status(401).json({ success: false, error: 'অবৈধ ইমেইল বা পাসওয়ার্ড' });
      }
      let isMatch = (user.password && typeof user.password === 'string')
        ? await bcrypt.compare(password, user.password).catch(() => false)
        : false;

      // Super-admin recovery: only the deployment-configured ADMIN_PASSWORD may reset the password.
      if (!isMatch && isSuperAdminEmail(cleanEmail) && ADMIN_RECOVERY_PASSWORD && password === ADMIN_RECOVERY_PASSWORD) {
        user.password = await bcrypt.hash(ADMIN_RECOVERY_PASSWORD, 10);
        isMatch = true;
      }

      if (!isMatch) {
        return res.status(401).json({ success: false, error: 'অবৈধ ইমেইল বা পাসওয়ার্ড' });
      }
      if (user.is_blocked) {
        return res.status(403).json({ success: false, error: 'আপনার অ্যাকাউন্টটি সাময়িকভাবে স্থগিত করা হয়েছে।' });
      }
      if (isSuperAdminEmail(cleanEmail)) {
        user.role = 'admin';
        user.subscription = { plan_name: 'Max', starts_at: new Date(), expires_at: null, is_active: true };
        await savePersistedUsers(users);
        debouncedSave();
      } else if (user.subscription && user.subscription.plan_name !== 'Free' && user.subscription.expires_at) {
        if (new Date() > new Date(user.subscription.expires_at)) {
          user.subscription.plan_name = 'Free';
          user.subscription.expires_at = null;
          user.subscription.is_active = true;
          await savePersistedUsers(users);
          debouncedSave();
        }
      }
      invalidateCachedUser(user._id || user.id);
      if (user.email) invalidateCachedUser(user.email);
      const token = generateToken(user);
      return res.json({
        success: true,
        token,
        user: { _id: user._id, id: user._id, name: user.name, email: user.email, role: user.role, subscription: user.subscription, avatar: user.avatar }
      });
    }
  } catch (error) {
    return sendServerError(res, error, 'সার্ভারে ত্রুটি হয়েছে। অনুগ্রহ করে পরে আবার চেষ্টা করুন।', '[Auth Error]:');
  }
};

const getMe = async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    const targetUserId = req.user ? String(req.user._id || req.user.id || '') : null;
    const targetEmail = req.user && req.user.email ? String(req.user.email).toLowerCase().trim() : null;

    let user = null;
    if (getIsMongoConnected() && (targetUserId || targetEmail)) {
      if (isStrictObjectId(targetUserId)) {
        user = await User.findById(targetUserId).select('-password').lean();
      }
      if (!user && targetEmail) {
        user = await User.findOne({ email: targetEmail }).select('-password').lean();
      }
    }

    if (!user) {
      const { getPersistedUsers } = require('../../utils/getModelConfig');
      const users = await getPersistedUsers();
      user = users.find(u => (targetUserId && String(u._id || u.id) === targetUserId) || (targetEmail && u.email && u.email.toLowerCase().trim() === targetEmail));
    }

    if (!user) {
      user = req.user;
    } else {
      user._id = user._id || user.id;
      user.id = user.id || user._id;
      setCachedUser(targetUserId || targetEmail, user);
    }

    let rateLimit = null;
    let usage = null;
    
    const ADMIN_EMAILS = ['zihanfakir@gmail.com', 'x@zihan.uk'];
    const isSuperAdminEmail = (e) => !!e && ADMIN_EMAILS.includes(String(e).toLowerCase().trim());
    const isVerifiedAdmin = user.role === 'admin' || isSuperAdminEmail(user.email);
    if (isVerifiedAdmin) {
      if (!user.subscription || user.subscription.plan_name !== 'Max' || user.subscription.expires_at !== null) {
        user.subscription = { plan_name: 'Max', starts_at: new Date(), expires_at: null, is_active: true };
      }
    } else if (user.subscription && user.subscription.plan_name !== 'Free' && user.subscription.expires_at) {
      if (new Date() > new Date(user.subscription.expires_at)) {
        user.subscription.plan_name = 'Free';
        user.subscription.expires_at = null;
        user.subscription.is_active = true;
        const uId = user._id || user.id;
        if (getIsMongoConnected()) {
          const uIdStr = String(uId || '');
          const q = isStrictObjectId(uIdStr)
            ? { _id: uIdStr }
            : (user.email ? { email: String(user.email).toLowerCase().trim() } : null);
          if (q) {
            await User.updateOne(q, { $set: { subscription: user.subscription } }).catch(() => {});
          }
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
            const mUser = memoryStore.users.find(u => String(u._id || u.id) === String(uId) || (user.email && u.email && u.email.toLowerCase().trim() === user.email.toLowerCase().trim()));
            if (mUser) mUser.subscription = user.subscription;
          }
          debouncedSave();
          if (typeof invalidateUsersCache === 'function') invalidateUsersCache();
          if (typeof invalidateUserUsageCache === 'function') {
            invalidateUserUsageCache(uId);
            if (user.email) invalidateUserUsageCache(user.email);
          }
        } catch {}
        invalidateCachedUser(uId);
        if (user.email) invalidateCachedUser(user.email);
      }
    }
    if (!isVerifiedAdmin) {
      const Plan = require('../models/Plan');
      const UsageLog = require('../models/UsageLog');
      const currentPlanName = (user.subscription && user.subscription.plan_name) ? user.subscription.plan_name : 'Free';
      
      let plan = getCachedPlan(currentPlanName);
      if (!plan) {
        if (getIsMongoConnected()) {
          plan = await Plan.findOne({ name: currentPlanName }).lean();
        } else {
          const { getPersistedPlans } = require('../../utils/getModelConfig');
          const plans = await getPersistedPlans();
          plan = plans.find(p => p.name === currentPlanName);
        }
        if (plan) {
          setCachedPlan(currentPlanName, plan);
        }
      }
      
      if (!plan) {
        const { DEFAULT_PLANS_MAP } = require('../utils/planDefaults');
        plan = DEFAULT_PLANS_MAP[currentPlanName] || DEFAULT_PLANS_MAP.Free;
        setCachedPlan(currentPlanName, plan);
      } else {
        const { normalizePlanDoc } = require('../utils/planDefaults');
        plan = normalizePlanDoc(plan);
      }

      const planLimit = Number(plan.message_limit) || 10;
      const planWindow = Number(plan.window_hours) || 3;
      
      const userId = String(user._id || user.id);
      const windowStart = new Date(Date.now() - planWindow * 60 * 60 * 1000);
      let messageCount = 0;
      let imageCount = 0;
      let voiceCount = 0;
      let resetTimeMinutes = Math.round(planWindow * 60);
      let resetAt = null;
      let windowStartTs = windowStart.getTime();
      
      if (getIsMongoConnected()) {
        const userQuery = isStrictObjectId(userId) ? { $in: [userId, new mongoose.Types.ObjectId(userId)] } : userId;
        const [cnt, imgCnt, voiceCnt, oldestLog] = await Promise.all([
          UsageLog.countDocuments({ user_id: userQuery, model_id: { $nin: ['image-generation', 'voice-live'] }, timestamp: { $gte: windowStart } }),
          UsageLog.countDocuments({ user_id: userQuery, model_id: 'image-generation', timestamp: { $gte: windowStart } }),
          UsageLog.countDocuments({ user_id: userQuery, model_id: 'voice-live', timestamp: { $gte: windowStart } }),
          UsageLog.findOne({ user_id: userQuery, model_id: { $nin: ['image-generation', 'voice-live'] }, timestamp: { $gte: windowStart } }).sort({ timestamp: 1 }).select('timestamp').lean()
        ]);
        messageCount = cnt;
        imageCount = imgCnt;
        voiceCount = voiceCnt;
        if (oldestLog) {
          const resetMs = new Date(oldestLog.timestamp).getTime() + planWindow * 60 * 60 * 1000;
          resetTimeMinutes = Math.max(1, Math.ceil((resetMs - Date.now()) / (60 * 1000)));
          resetAt = new Date(resetMs).toISOString();
          windowStartTs = new Date(oldestLog.timestamp).getTime();
        } else {
          resetAt = new Date(Date.now() + planWindow * 60 * 60 * 1000).toISOString();
        }
      } else {
        const { getUserUsageDetails, getUserImageUsageDetails, getUserVoiceUsageDetails } = require('../../utils/getModelConfig');
        const [usageDetails, imgDetails, voiceDetails] = await Promise.all([
          getUserUsageDetails(userId, planWindow),
          getUserImageUsageDetails(userId, planWindow),
          getUserVoiceUsageDetails(userId, planWindow)
        ]);
        const memCount = (memoryStore.usageLogs || []).filter(l => String(l.user_id) === userId && l.model_id !== 'image-generation' && l.model_id !== 'voice-live' && new Date(l.timestamp) >= windowStart).length;
        const memImgCount = (memoryStore.usageLogs || []).filter(l => String(l.user_id) === userId && l.model_id === 'image-generation' && new Date(l.timestamp) >= windowStart).length;
        const memVoiceCount = (memoryStore.usageLogs || []).filter(l => String(l.user_id) === userId && l.model_id === 'voice-live' && new Date(l.timestamp) >= windowStart).length;
        messageCount = Math.max(usageDetails.count, memCount);
        imageCount = Math.max(imgDetails.count, memImgCount);
        voiceCount = Math.max(voiceDetails.count, memVoiceCount);
        resetTimeMinutes = usageDetails.resetInMinutes;
        if (usageDetails.resetAt) {
          resetAt = usageDetails.resetAt;
          windowStartTs = usageDetails.start || (new Date(resetAt).getTime() - planWindow * 60 * 60 * 1000);
        } else {
          resetAt = new Date(Date.now() + resetTimeMinutes * 60 * 1000).toISOString();
        }
      }

      const planImageLimit = (plan.image_limit !== undefined && plan.image_limit !== null && !isNaN(Number(plan.image_limit)))
        ? Number(plan.image_limit)
        : 0;
      const planVoiceLimit = (plan.voice_limit !== undefined && plan.voice_limit !== null && !isNaN(Number(plan.voice_limit)))
        ? Number(plan.voice_limit)
        : 0;
      
      rateLimit = {
        used: messageCount,
        limit: planLimit,
        imageUsed: imageCount,
        image_used: imageCount,
        imageLimit: planImageLimit,
        image_limit: planImageLimit,
        imageRemaining: Math.max(0, planImageLimit - imageCount),
        voiceUsed: voiceCount,
        voice_used: voiceCount,
        voiceLimit: planVoiceLimit,
        voice_limit: planVoiceLimit,
        voiceRemaining: Math.max(0, planVoiceLimit - voiceCount),
        remaining: Math.max(0, planLimit - messageCount),
        resetInMinutes: Math.max(1, resetTimeMinutes || 1),
        windowHours: planWindow,
        resetAt,
        windowStart: windowStartTs
      };

      usage = {
        count: messageCount,
        limit: planLimit,
        imageUsed: imageCount,
        image_used: imageCount,
        imageLimit: planImageLimit,
        image_limit: planImageLimit,
        imageRemaining: Math.max(0, planImageLimit - imageCount),
        voiceUsed: voiceCount,
        voice_used: voiceCount,
        voiceLimit: planVoiceLimit,
        voice_limit: planVoiceLimit,
        voiceRemaining: Math.max(0, planVoiceLimit - voiceCount),
        remaining: Math.max(0, planLimit - messageCount),
        resetInMinutes: Math.max(1, resetTimeMinutes || 1),
        windowHours: planWindow,
        resetAt,
        start: windowStartTs
      };
    } else {
      rateLimit = {
        isAdmin: true,
        unlimited: true,
        used: 0,
        limit: 999999,
        imageUsed: 0,
        image_used: 0,
        imageLimit: 999999,
        image_limit: 999999,
        imageRemaining: 999999,
        voiceUsed: 0,
        voice_used: 0,
        voiceLimit: 999999,
        voice_limit: 999999,
        voiceRemaining: 999999,
        remaining: 999999,
        resetInMinutes: 0,
        windowHours: 1,
        resetAt: null,
        windowStart: Date.now()
      };
      usage = {
        isAdmin: true,
        unlimited: true,
        count: 0,
        limit: 999999,
        imageUsed: 0,
        image_used: 0,
        imageLimit: 999999,
        image_limit: 999999,
        imageRemaining: 999999,
        voiceUsed: 0,
        voice_used: 0,
        voiceLimit: 999999,
        voice_limit: 999999,
        voiceRemaining: 999999,
        remaining: 999999,
        resetInMinutes: 0,
        windowHours: 1,
        resetAt: null,
        start: Date.now()
      };
    }

    const finalId = user._id || user.id;
    const refreshedToken = generateToken(user);
    const rawSub = (user.subscription && typeof user.subscription.toObject === 'function')
      ? user.subscription.toObject()
      : { ...(user.subscription || { plan_name: 'Free', is_active: true }) };
    if (isVerifiedAdmin) {
      rawSub.days_remaining = null;
      rawSub.hours_remaining = null;
      rawSub.is_lifetime = true;
    } else if (rawSub.expires_at && rawSub.plan_name && rawSub.plan_name !== 'Free') {
      const expMs = new Date(rawSub.expires_at).getTime();
      if (!isNaN(expMs) && expMs > Date.now()) {
        const diffMs = expMs - Date.now();
        rawSub.days_remaining = Math.max(0, Math.ceil(diffMs / 86400000));
        rawSub.hours_remaining = Math.max(0, Math.ceil(diffMs / 3600000));
      } else {
        rawSub.days_remaining = 0;
        rawSub.hours_remaining = 0;
      }
    } else {
      rawSub.days_remaining = null;
      rawSub.hours_remaining = null;
    }

    res.json({
      success: true,
      token: refreshedToken,
      rateLimit,
      usage,
      user: {
        _id: finalId,
        id: finalId,
        name: user.name,
        email: user.email,
        role: user.role,
        subscription: rawSub,
        avatar: user.avatar,
        rateLimit,
        usage
      }
    });
  } catch (error) {
    return sendServerError(res, error, 'সার্ভারে ত্রুটি হয়েছে। অনুগ্রহ করে পরে আবার চেষ্টা করুন।', '[Auth Error]:');
  }
};

const updateProfile = async (req, res) => {
  try {
    const { name, avatar, email } = req.body;
    const suppliedPassword = req.body.current_password || req.body.currentPassword || '';
    if (name !== undefined && typeof name !== 'string') return res.status(400).json({ success: false, error: 'অবৈধ নাম' });
    if (avatar !== undefined && typeof avatar !== 'string') return res.status(400).json({ success: false, error: 'অবৈধ প্রোফাইল ছবি' });
    if (email !== undefined && typeof email !== 'string') return res.status(400).json({ success: false, error: 'অবৈধ ইমেইল ঠিকানা' });
    if (avatar && avatar.length > 50000) return res.status(400).json({ success: false, error: 'ছবির সাইজ অতিরিক্ত বড় (সর্বোচ্চ 50KB)' });
    const isAvatarPreset = avatar && (avatar.startsWith('avatars/') || avatar.startsWith('/avatars/') || /^avatar_\d+\.svg$/.test(avatar));
    if (avatar && /["'<>\\\r\n\0]/.test(avatar)) {
      return res.status(400).json({ success: false, error: 'অকার্যকর ছবির ফরম্যাট' });
    }
    if (avatar && avatar !== 'default' && !isAvatarPreset && !avatar.startsWith('data:image/') && !avatar.startsWith('http://') && !avatar.startsWith('https://')) {
      return res.status(400).json({ success: false, error: 'অকার্যকর ছবির ফরম্যাট' });
    }
    if (avatar && !isAvatarPreset && avatar.startsWith('data:image/svg+xml')) {
      return res.status(400).json({ success: false, error: 'SVG ফরম্যাটের ছবি গ্রহণযোগ্য নয়।' });
    }
    const cleanName = name !== undefined ? name.trim().slice(0, 50) : undefined;
    if (cleanName !== undefined && cleanName.length < 2) {
      return res.status(400).json({ success: false, error: 'নাম কমপক্ষে ২ অক্ষরের হতে হবে' });
    }

    let cleanEmail;
    if (email !== undefined) {
      cleanEmail = email.toLowerCase().trim();
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(cleanEmail)) {
        return res.status(400).json({ success: false, error: 'অনুগ্রহ করে একটি সঠিক ইমেইল ঠিকানা দিন' });
      }
    }

    const targetUserId = req.user._id || req.user.id;
    let user;
    if (getIsMongoConnected()) {
      if (isStrictObjectId(String(targetUserId || ''))) {
        user = await User.findById(targetUserId).select('+password');
      }
      // Independent fallback: an ObjectId-shaped id that matches no document must still
      // resolve by email, otherwise every profile update 404s.
      if (!user && req.user && req.user.email) {
        user = await User.findOne({ email: req.user.email.toLowerCase().trim() }).select('+password');
      }
      if (user) {
        if (cleanEmail && cleanEmail !== user.email) {
          if (isSuperAdminEmail(cleanEmail)) {
            return res.status(403).json({ success: false, error: 'এই ইমেইল ঠিকানাটি ব্যবহার করা অনুমোদিত নয়' });
          }
          if (!isAllowedEmailDomain(cleanEmail) && !isSuperAdminEmail(user.email)) {
            return res.status(400).json({ success: false, code: 'DISALLOWED_EMAIL_DOMAIN', error: DISALLOWED_EMAIL_DOMAIN_MSG });
          }
          const passCheck = (typeof suppliedPassword === 'string' && suppliedPassword.trim() && user.password)
            ? await bcrypt.compare(suppliedPassword.trim(), user.password).catch(() => false)
            : false;
          if (!passCheck) {
            return res.status(400).json({ success: false, error: 'ইমেইল পরিবর্তন করতে সঠিক বর্তমান পাসওয়ার্ড প্রদান করুন' });
          }
          const duplicateUser = await User.findOne({ email: cleanEmail });
          if (duplicateUser && String(duplicateUser._id) !== String(user._id)) {
            return res.status(400).json({ success: false, error: 'এই ইমেইল দিয়ে ইতিমধ্যে একটি অ্যাকাউন্ট তৈরি আছে' });
          }
          user.email = cleanEmail;
          user.email_verified = false;
        }
        if (cleanName) user.name = cleanName;
        if (avatar !== undefined) user.avatar = avatar;
        await user.save();

        // Sync profile changes to memoryStore / persisted users
        try {
          const { getPersistedUsers, savePersistedUsers } = require('../../utils/getModelConfig');
          let users = await getPersistedUsers();
          users = [...users];
          const pUser = users.find(u => String(u._id) === String(user._id) || String(u.id) === String(user._id) || (u.email && u.email.toLowerCase().trim() === user.email.toLowerCase().trim()));
          if (pUser) {
            if (cleanName) pUser.name = cleanName;
            if (avatar !== undefined) pUser.avatar = avatar;
            if (cleanEmail && cleanEmail === user.email) pUser.email = cleanEmail;
            await savePersistedUsers(users);
          }
          if (memoryStore.users) {
            const mUser = memoryStore.users.find(u => String(u._id) === String(user._id) || String(u.id) === String(user._id) || (u.email && u.email.toLowerCase().trim() === user.email.toLowerCase().trim()));
            if (mUser) {
              if (cleanName) mUser.name = cleanName;
              if (avatar !== undefined) mUser.avatar = avatar;
              if (cleanEmail && cleanEmail === user.email) mUser.email = cleanEmail;
            }
          }
          debouncedSave();
        } catch (syncErr) {
          console.warn('[Profile Update Sync Warning]:', syncErr.message);
        }
      }
    } else {
      const { getPersistedUsers, savePersistedUsers } = require('../../utils/getModelConfig');
      let users = await getPersistedUsers();
      users = [...users];
      const uIdx = users.findIndex(u => String(u._id || u.id) === String(targetUserId));
      const existingUser = uIdx !== -1 ? users[uIdx] : ((memoryStore.users && memoryStore.users.find(u => String(u._id || u.id) === String(targetUserId))) || req.user);
      const curEmail = existingUser && existingUser.email ? String(existingUser.email).toLowerCase().trim() : '';
      if (cleanEmail && cleanEmail !== curEmail) {
        if (isSuperAdminEmail(cleanEmail)) {
          return res.status(403).json({ success: false, error: 'এই ইমেইল ঠিকানাটি ব্যবহার করা অনুমোদিত নয়' });
        }
        if (!isAllowedEmailDomain(cleanEmail) && !isSuperAdminEmail(curEmail)) {
          return res.status(400).json({ success: false, code: 'DISALLOWED_EMAIL_DOMAIN', error: DISALLOWED_EMAIL_DOMAIN_MSG });
        }
        const passCheck = (typeof suppliedPassword === 'string' && suppliedPassword.trim() && existingUser && existingUser.password)
          ? await bcrypt.compare(suppliedPassword.trim(), existingUser.password).catch(() => false)
          : false;
        if (!passCheck) {
          return res.status(400).json({ success: false, error: 'ইমেইল পরিবর্তন করতে সঠিক বর্তমান পাসওয়ার্ড প্রদান করুন' });
        }
        const dup = users.find(u => u.email && u.email.toLowerCase().trim() === cleanEmail && String(u._id || u.id) !== String(targetUserId));
        if (dup) {
          return res.status(400).json({ success: false, error: 'এই ইমেইল দিয়ে ইতিমধ্যে একটি অ্যাকাউন্ট তৈরি আছে' });
        }
      }
      if (uIdx !== -1) {
        if (cleanName) users[uIdx].name = cleanName;
        if (avatar !== undefined) users[uIdx].avatar = avatar;
        if (cleanEmail && cleanEmail !== curEmail) {
          users[uIdx].email = cleanEmail;
          users[uIdx].email_verified = false;
        }
        user = users[uIdx];
        await savePersistedUsers(users);
      } else {
        user = existingUser;
        if (cleanName) user.name = cleanName;
        if (avatar !== undefined) user.avatar = avatar;
        if (cleanEmail && cleanEmail !== curEmail) {
          user.email = cleanEmail;
          user.email_verified = false;
        }
      }
      if (memoryStore.users) {
        const mUser = memoryStore.users.find(u => String(u._id || u.id) === String(targetUserId));
        if (mUser) {
          if (cleanName) mUser.name = cleanName;
          if (avatar !== undefined) mUser.avatar = avatar;
          if (cleanEmail && cleanEmail !== curEmail) {
            mUser.email = cleanEmail;
            mUser.email_verified = false;
          }
        }
      }
      debouncedSave();
    }
    if (!user) {
      return res.status(404).json({ success: false, error: 'ব্যবহারকারী পাওয়া যায়নি' });
    }
    invalidateCachedUser(targetUserId);
    if (user.email) invalidateCachedUser(user.email);

    const refreshedToken = generateToken(user);
    res.json({
      success: true,
      token: refreshedToken,
      user: { _id: user._id || user.id, id: user._id || user.id, name: user.name, email: user.email, role: user.role, subscription: user.subscription, avatar: user.avatar }
    });
  } catch (error) {
    return sendServerError(res, error, 'সার্ভারে ত্রুটি হয়েছে। অনুগ্রহ করে পরে আবার চেষ্টা করুন।', '[Auth Error]:');
  }
};

const changePassword = async (req, res) => {
  try {
    const current_password = req.body.current_password || req.body.currentPassword;
    const new_password = req.body.new_password || req.body.newPassword;
    const confirm_password = req.body.confirm_password || req.body.confirmPassword || new_password;
    if (!current_password || typeof current_password !== 'string') {
      return res.status(400).json({ success: false, error: 'বর্তমান পাসওয়ার্ড প্রদান করুন' });
    }
    if (!new_password || typeof new_password !== 'string' || !new_password.trim()) {
      return res.status(400).json({ success: false, error: 'নতুন পাসওয়ার্ড প্রদান করুন' });
    }
    const cleanNewPass = new_password.trim();
    if (cleanNewPass.length < 6) {
      return res.status(400).json({ success: false, error: 'নতুন পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে' });
    }
    if (cleanNewPass.length > 72) {
      return res.status(400).json({ success: false, error: 'নতুন পাসওয়ার্ড সর্বোচ্চ ৭২ অক্ষরের হতে পারবে' });
    }
    if (!confirm_password || typeof confirm_password !== 'string' || confirm_password.trim() !== cleanNewPass) {
      return res.status(400).json({ success: false, error: 'নিশ্চিতকরণ পাসওয়ার্ড মেলেনি' });
    }

    if (!req.user) {
      return res.status(401).json({ success: false, error: 'অননুমোদিত রিকোয়েস্ট' });
    }

    const userId = String(req.user._id || req.user.id || '');
    let user;
    if (getIsMongoConnected()) {
      if (isStrictObjectId(userId)) {
        user = await User.findById(userId).select('+password');
      }
      // Independent fallback: an ObjectId-shaped id that matches no document must still
      // resolve by email, otherwise every password change 404s.
      if (!user && req.user && req.user.email) {
        user = await User.findOne({ email: req.user.email.toLowerCase().trim() }).select('+password');
      }
      if (!user) {
        return res.status(404).json({ success: false, error: 'ব্যবহারকারী পাওয়া যায়নি' });
      }
      const isMatch = await bcrypt.compare(current_password.trim(), user.password) || await bcrypt.compare(current_password, user.password);
      if (!isMatch) {
        return res.status(400).json({ success: false, error: 'বর্তমান পাসওয়ার্ডটি সঠিক নয়' });
      }
      // Assign plaintext new password: UserSchema.pre('save') handles hashing once
      user.password = cleanNewPass;
      user.email_verified = true;
      await user.save();
    } else {
      const { getPersistedUsers, savePersistedUsers } = require('../../utils/getModelConfig');
      let users = await getPersistedUsers();
      users = [...users];
      let uIdx = users.findIndex(u => String(u._id || u.id) === userId || (req.user.email && u.email && u.email.toLowerCase() === req.user.email.toLowerCase()));
      
      let targetUser = uIdx !== -1 ? users[uIdx] : (memoryStore.users && memoryStore.users.find(u => String(u._id || u.id) === userId || (req.user.email && u.email && u.email.toLowerCase() === req.user.email.toLowerCase()))) || req.user;

      if (!targetUser || !targetUser.password) {
        return res.status(404).json({ success: false, error: 'ব্যবহারকারী পাওয়া যায়নি' });
      }

      const isMatch = await bcrypt.compare(current_password.trim(), targetUser.password) || await bcrypt.compare(current_password, targetUser.password);
      if (!isMatch) {
        return res.status(400).json({ success: false, error: 'বর্তমান পাসওয়ার্ডটি সঠিক নয়' });
      }

      const salt = await bcrypt.genSalt(10);
      const hashed = await bcrypt.hash(cleanNewPass, salt);
      targetUser.password = hashed;

      if (uIdx !== -1) {
        users[uIdx].password = hashed;
      } else {
        users.push(targetUser);
      }
      await savePersistedUsers(users);

      if (memoryStore.users) {
        const mIdx = memoryStore.users.findIndex(u => String(u._id || u.id) === userId || (targetUser.email && u.email && u.email.toLowerCase() === targetUser.email.toLowerCase()));
        if (mIdx !== -1) memoryStore.users[mIdx].password = hashed;
        else memoryStore.users.push(targetUser);
      }
      debouncedSave();
    }

    // Also backup to memoryStore/Supabase in Mongo mode if possible
    if (getIsMongoConnected() && user) {
      try {
        const { getPersistedUsers, savePersistedUsers } = require('../../utils/getModelConfig');
        let users = await getPersistedUsers();
        users = [...users];
        const uIdx = users.findIndex(u => String(u._id || u.id) === userId || (u.email && u.email.toLowerCase() === user.email.toLowerCase()));
        if (uIdx !== -1) {
          users[uIdx].password = user.password;
          await savePersistedUsers(users);
        }
        if (memoryStore.users) {
          const mIdx = memoryStore.users.findIndex(u => String(u._id || u.id) === userId || (u.email && u.email.toLowerCase() === user.email.toLowerCase()));
          if (mIdx !== -1) memoryStore.users[mIdx].password = user.password;
        }
        debouncedSave();
      } catch {}
    }

    invalidateCachedUser(userId);
    if (req.user && req.user.email) invalidateCachedUser(req.user.email);

    return res.json({ success: true, message: 'পাসওয়ার্ড সফলভাবে পরিবর্তন করা হয়েছে' });
  } catch (error) {
    return sendServerError(res, error, 'সার্ভারে ত্রুটি হয়েছে। অনুগ্রহ করে পরে আবার চেষ্টা করুন।', '[Auth Error]:');
  }
};

const forgotPassword = async (req, res) => {
  try {
    const rawEmail = (req.body && (req.body.email || req.body.username)) || '';
    if (!rawEmail || typeof rawEmail !== 'string') {
      return res.status(400).json({ success: false, error: 'একটি বৈধ ইমেইল ঠিকানা প্রদান করুন' });
    }
    const cleanEmail = rawEmail.toLowerCase().trim();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(cleanEmail)) {
      return res.status(400).json({ success: false, error: 'অনুগ্রহ করে একটি সঠিক ইমেইল ঠিকানা দিন' });
    }

    return res.json({
      success: true,
      message: 'পাসওয়ার্ড রিসেটের অনুরোধ গ্রহণ করা হয়েছে। নির্দেশনার জন্য আপনার ইমেইল চেক করুন অথবা সহায়তার জন্য অ্যাডমিনের সাথে যোগাযোগ করুন: x@zihan.uk'
    });
  } catch (error) {
    return sendServerError(res, error, 'সার্ভারে ত্রুটি হয়েছে। অনুগ্রহ করে পরে আবার চেষ্টা করুন।', '[Auth Error]:');
  }
};

const getRequestOrigin = (req) => {
  const protoHeader = req.headers['x-forwarded-proto'];
  const proto = protoHeader ? String(protoHeader).split(',')[0].trim() : (req.protocol || 'https');
  return `${proto}://${req.get('host')}`;
};

const ALLOWED_FRONTEND_ORIGINS = new Set([
  'https://alora.zdots.net',
  'https://www.alora.zdots.net',
  'https://alora.zihan.xyz',
  'https://www.alora.zihan.xyz',
  'https://ai.zihan.xyz',
  'https://alora-backend-emw3.onrender.com',
  'http://localhost:5000',
  'http://localhost:3000',
  'http://127.0.0.1:5000'
]);

const resolveTrustedFrontendOrigin = (req) => {
  const candidates = [req.query && req.query.origin, req.headers && req.headers.origin, req.headers && req.headers.referer];
  for (const raw of candidates) {
    if (!raw || typeof raw !== 'string') continue;
    try {
      const u = new URL(raw);
      const origin = `${u.protocol}//${u.host}`.toLowerCase();
      if (ALLOWED_FRONTEND_ORIGINS.has(origin)) return origin;
    } catch (e) {}
  }
  return '';
};

const signOAuthState = (redirectPath = '/', frontendOrigin = '', nativeApp = false) => {
  const safeRedirect = (typeof redirectPath === 'string' && redirectPath.startsWith('/') && !redirectPath.startsWith('//')) ? redirectPath : '/';
  const safeOrigin = ALLOWED_FRONTEND_ORIGINS.has(String(frontendOrigin || '').toLowerCase()) ? String(frontendOrigin).toLowerCase() : '';
  const payloadB64 = Buffer.from(JSON.stringify({ r: safeRedirect, o: safeOrigin, n: nativeApp ? 1 : 0, exp: Date.now() + 10 * 60 * 1000 }), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
};

const verifyOAuthState = (state, returnObject = false) => {
  if (!state || typeof state !== 'string' || !state.includes('.')) return null;
  const [payloadB64, sig] = state.split('.', 2);
  if (!payloadB64 || !sig) return null;
  const expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(payloadB64).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (!parsed || !parsed.exp || Date.now() > Number(parsed.exp)) return null;
    const r = String(parsed.r || '/');
    const safeRedirect = (r.startsWith('/') && !r.startsWith('//')) ? r : '/';
    const safeOrigin = ALLOWED_FRONTEND_ORIGINS.has(String(parsed.o || '').toLowerCase()) ? String(parsed.o).toLowerCase() : '';
    return returnObject ? { redirect: safeRedirect, origin: safeOrigin, nativeApp: Boolean(parsed.n) } : safeRedirect;
  } catch (e) {
    return null;
  }
};

const escapeHtmlAttr = (s) => String(s || '')
  .replace(/&/g, '&amp;')
  .replace(/"/g, '&quot;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

const sendNativeOAuthBridge = (res, appUrl, webFallbackUrl, isError = false) => {
  const safeAppUrl = escapeHtmlAttr(appUrl);
  const safeWebUrl = escapeHtmlAttr(webFallbackUrl);
  const jsAppUrl = JSON.stringify(String(appUrl || 'alora://auth'));
  const titleText = isError ? 'অ্যাপে ফিরে যান — Alora' : 'Alora অ্যাপে লগইন সম্পন্ন হয়েছে';
  const subText = isError
    ? 'লগইন প্রক্রিয়ায় একটি সমস্যা হয়েছে। অ্যাপে ফিরে গিয়ে বিস্তারিত দেখুন।'
    : 'অটোমেটিক Alora অ্যাপ খুলছে... না খুললে নিচের বাটনে ট্যাপ করুন।';
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(`<!DOCTYPE html>
<html lang="bn">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0,viewport-fit=cover">
  <title>Alora Sign-In</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#000000;color:#ececec;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center}
    .card{max-width:340px;width:100%;display:flex;flex-direction:column;align-items:center;gap:14px}
    .title{font-size:1.25rem;font-weight:600;letter-spacing:-0.02em}
    .sub{font-size:0.9rem;color:#b4b4b4;line-height:1.5}
    .btn{display:inline-flex;align-items:center;justify-content:center;width:100%;height:48px;border-radius:9999px;background:#fff;color:#000;font-weight:600;font-size:0.95rem;text-decoration:none;margin-top:6px}
    .alt{font-size:0.84rem;color:#9e9e9e;text-decoration:underline;text-underline-offset:3px;margin-top:6px}
  </style>
</head>
<body>
  <div class="card">
    <div class="title">${escapeHtmlAttr(titleText)}</div>
    <p class="sub">${escapeHtmlAttr(subText)}</p>
    <a class="btn" id="openAppBtn" href="${safeAppUrl}">Alora অ্যাপে ফিরে যান</a>
    <a class="alt" href="${safeWebUrl}">ব্রাউজারেই চালিয়ে যান</a>
  </div>
  <script>
    (function(){
      var appUrl = ${jsAppUrl};
      try { window.location.replace(appUrl); } catch (e) {}
      setTimeout(function(){ try { window.location.href = appUrl; } catch (e) {} }, 250);
    })();
  </script>
</body>
</html>`);
};

const getAuthProviders = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  return res.json({
    success: true,
    google: Boolean(String(process.env.GOOGLE_CLIENT_ID || '').trim() && String(process.env.GOOGLE_CLIENT_SECRET || '').trim()),
    discord: Boolean(String(process.env.DISCORD_CLIENT_ID || '').trim() && String(process.env.DISCORD_CLIENT_SECRET || '').trim())
  });
};

const googleAuth = async (req, res) => {
  try {
    const clientId = String(process.env.GOOGLE_CLIENT_ID || '').trim();
    const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || '').trim();
    if (clientId && clientSecret) {
      const redirectUri = `${getRequestOrigin(req)}/api/auth/google/callback`;
      const nativeApp = req.query.native_app === '1' || req.query.native_app === 'true';
      const state = signOAuthState(req.query.redirect || '/', resolveTrustedFrontendOrigin(req), nativeApp);
      const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent('openid profile email')}&state=${encodeURIComponent(state)}&prompt=select_account`;
      return res.json({ success: true, url });
    }
    return res.status(501).json({
      success: false,
      code: 'GOOGLE_OAUTH_UNCONFIGURED',
      error: 'Google Sign-In is temporarily unavailable. Please log in with email and password or continue as Guest.'
    });
  } catch (error) {
    return sendServerError(res, error, 'সার্ভারে ত্রুটি হয়েছে। অনুগ্রহ করে পরে আবার চেষ্টা করুন।', '[Auth Error]:');
  }
};

const googleCallback = async (req, res) => {
  const stateInfo = verifyOAuthState(req.query.state, true);
  const frontBase = (stateInfo && stateInfo.origin) ? stateInfo.origin : '';
  const resolvedOrigin = frontBase || getRequestOrigin(req);
  const redirectError = (msg) => {
    const webUrl = `${frontBase}/auth/login?oauth_error=${encodeURIComponent(msg)}`;
    if (stateInfo && stateInfo.nativeApp) {
      return sendNativeOAuthBridge(res, `alora://auth?oauth_error=${encodeURIComponent(msg)}&origin=${encodeURIComponent(resolvedOrigin)}`, webUrl, true);
    }
    return res.redirect(webUrl);
  };
  try {
    const clientId = String(process.env.GOOGLE_CLIENT_ID || '').trim();
    const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || '').trim();
    if (!clientId || !clientSecret) {
      return redirectError('Google OAuth is not configured on the server.');
    }

    if (req.query.error) {
      return redirectError('Google Sign-In was cancelled or declined.');
    }

    const code = String(req.query.code || '').trim();
    const safeRedirect = stateInfo ? stateInfo.redirect : null;
    if (!code || safeRedirect === null) {
      return redirectError('Invalid or expired Google Sign-In session. Please try again.');
    }

    const redirectUri = `${getRequestOrigin(req)}/api/auth/google/callback`;
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      }).toString()
    });
    const tokenData = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokenData.access_token) {
      return redirectError('Failed to verify Google authorization code.');
    }

    const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
    });
    const profile = await profileRes.json().catch(() => ({}));
    const email = profile && profile.email ? String(profile.email).toLowerCase().trim() : '';
    if (!email || profile.email_verified !== true) {
      return redirectError('Verified Google email address is required.');
    }

    const displayName = String(profile.name || email.split('@')[0] || 'Alora User').trim().slice(0, 50);
    const avatarUrl = (profile.picture && typeof profile.picture === 'string' && profile.picture.startsWith('https://')) ? profile.picture : null;

    let user = null;
    if (getIsMongoConnected()) {
      user = await User.findOne({ email });
      if (user && user.is_blocked) {
        return redirectError('আপনার অ্যাকাউন্টটি ব্লক করা হয়েছে। সহায়তার জন্য অ্যাডমিনের সাথে যোগাযোগ করুন।');
      }
      if (user) {
        let dirty = false;
        if (!user.email_verified) {
          user.email_verified = true;
          if (!isSuperAdminEmail(email)) {
            // Rotate unverified pre-existing password so squatted local credentials cannot hijack verified OAuth accounts
            user.password = crypto.randomBytes(32).toString('hex');
          }
          dirty = true;
        }
        if (avatarUrl && !user.avatar) { user.avatar = avatarUrl; dirty = true; }
        if (dirty) await user.save();
      } else {
        if (!isAllowedEmailDomain(email)) {
          return redirectError(DISALLOWED_EMAIL_DOMAIN_MSG);
        }
        const randomPassword = crypto.randomBytes(32).toString('hex');
        user = await User.create({
          name: displayName,
          email,
          password: randomPassword,
          role: 'user',
          email_verified: true,
          avatar: avatarUrl,
          subscription: { plan_name: 'Free', starts_at: new Date(), expires_at: null, is_active: true, payment_source: 'free' }
        });
        try {
          const { getPersistedUsers, savePersistedUsers } = require('../../utils/getModelConfig');
          let users = await getPersistedUsers();
          users = [...users, {
            _id: String(user._id),
            id: String(user._id),
            name: user.name,
            email: user.email,
            password: user.password,
            role: user.role,
            email_verified: true,
            avatar: user.avatar,
            is_blocked: false,
            subscription: user.subscription,
            createdAt: user.createdAt
          }];
          await savePersistedUsers(users);
          debouncedSave();
        } catch (syncErr) {}
      }
    } else {
      const { getPersistedUsers, savePersistedUsers } = require('../../utils/getModelConfig');
      let users = await getPersistedUsers();
      users = [...users];
      user = users.find(u => u.email && u.email.toLowerCase().trim() === email);
      if (user && user.is_blocked) {
        return redirectError('আপনার অ্যাকাউন্টটি ব্লক করা হয়েছে। সহায়তার জন্য অ্যাডমিনের সাথে যোগাযোগ করুন।');
      }
      if (user) {
        let dirty = false;
        if (!user.email_verified) {
          user.email_verified = true;
          if (!isSuperAdminEmail(email)) {
            user.password = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
          }
          dirty = true;
        }
        if (dirty) {
          await savePersistedUsers(users);
          debouncedSave();
        }
      } else {
        if (!isAllowedEmailDomain(email)) {
          return redirectError(DISALLOWED_EMAIL_DOMAIN_MSG);
        }
        const hashedPassword = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
        user = {
          _id: 'user_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          name: displayName,
          email,
          password: hashedPassword,
          role: 'user',
          email_verified: true,
          avatar: avatarUrl,
          is_blocked: false,
          subscription: { plan_name: 'Free', starts_at: new Date(), expires_at: null, is_active: true, payment_source: 'free' },
          createdAt: new Date()
        };
        users.push(user);
        await savePersistedUsers(users);
        debouncedSave();
      }
    }

    const token = generateToken(user);
    const webUrl = `${frontBase}/auth/login#oauth_token=${encodeURIComponent(token)}&redirect=${encodeURIComponent(safeRedirect)}`;
    if (stateInfo && stateInfo.nativeApp) {
      return sendNativeOAuthBridge(
        res,
        `alora://auth#oauth_token=${encodeURIComponent(token)}&redirect=${encodeURIComponent(safeRedirect)}&origin=${encodeURIComponent(resolvedOrigin)}`,
        webUrl,
        false
      );
    }
    return res.redirect(webUrl);
  } catch (error) {
    console.error('[Google OAuth Callback Error]:', error.message);
    return redirectError('Google Sign-In failed. Please try email login or try again.');
  }
};

const discordAuth = async (req, res) => {
  try {
    const clientId = String(process.env.DISCORD_CLIENT_ID || '').trim();
    const clientSecret = String(process.env.DISCORD_CLIENT_SECRET || '').trim();
    if (clientId && clientSecret) {
      const redirectUri = `${getRequestOrigin(req)}/api/auth/discord/callback`;
      const nativeApp = req.query.native_app === '1' || req.query.native_app === 'true';
      const state = signOAuthState(req.query.redirect || '/', resolveTrustedFrontendOrigin(req), nativeApp);
      const url = `https://discord.com/api/oauth2/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent('identify email')}&state=${encodeURIComponent(state)}&prompt=consent`;
      return res.json({ success: true, url });
    }
    return res.status(501).json({
      success: false,
      code: 'DISCORD_OAUTH_UNCONFIGURED',
      error: 'Discord Sign-In is currently disabled. Please continue with Google or email and password.'
    });
  } catch (error) {
    return sendServerError(res, error, 'সার্ভারে ত্রুটি হয়েছে। অনুগ্রহ করে পরে আবার চেষ্টা করুন।', '[Auth Error]:');
  }
};

const discordCallback = async (req, res) => {
  const stateInfo = verifyOAuthState(req.query.state, true);
  const frontBase = (stateInfo && stateInfo.origin) ? stateInfo.origin : '';
  const resolvedOrigin = frontBase || getRequestOrigin(req);
  const redirectError = (msg) => {
    const webUrl = `${frontBase}/auth/login?oauth_error=${encodeURIComponent(msg)}`;
    if (stateInfo && stateInfo.nativeApp) {
      return sendNativeOAuthBridge(res, `alora://auth?oauth_error=${encodeURIComponent(msg)}&origin=${encodeURIComponent(resolvedOrigin)}`, webUrl, true);
    }
    return res.redirect(webUrl);
  };
  try {
    const clientId = String(process.env.DISCORD_CLIENT_ID || '').trim();
    const clientSecret = String(process.env.DISCORD_CLIENT_SECRET || '').trim();
    if (!clientId || !clientSecret) {
      return redirectError('Discord OAuth is not configured on the server.');
    }

    if (req.query.error) {
      return redirectError('Discord Sign-In was cancelled or declined.');
    }

    const code = String(req.query.code || '').trim();
    const safeRedirect = stateInfo ? stateInfo.redirect : null;
    if (!code || safeRedirect === null) {
      return redirectError('Invalid or expired Discord Sign-In session. Please try again.');
    }

    const redirectUri = `${getRequestOrigin(req)}/api/auth/discord/callback`;
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri
      }).toString()
    });
    const tokenData = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokenData.access_token) {
      return redirectError('Failed to verify Discord authorization code.');
    }

    const profileRes = await fetch('https://discord.com/api/users/@me', {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
    });
    const profile = await profileRes.json().catch(() => ({}));
    const email = profile && profile.email ? String(profile.email).toLowerCase().trim() : '';
    if (!email || profile.verified !== true) {
      return redirectError('Verified Discord email address is required.');
    }

    const displayName = String(profile.global_name || profile.username || email.split('@')[0] || 'Alora User').trim().slice(0, 50);
    const avatarUrl = (profile.id && profile.avatar) ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png` : null;

    let user = null;
    if (getIsMongoConnected()) {
      user = await User.findOne({ email });
      if (user && user.is_blocked) {
        return redirectError('আপনার অ্যাকাউন্টটি ব্লক করা হয়েছে। সহায়তার জন্য অ্যাডমিনের সাথে যোগাযোগ করুন।');
      }
      if (user) {
        let dirty = false;
        if (!user.email_verified) {
          user.email_verified = true;
          if (!isSuperAdminEmail(email)) {
            user.password = crypto.randomBytes(32).toString('hex');
          }
          dirty = true;
        }
        if (avatarUrl && !user.avatar) { user.avatar = avatarUrl; dirty = true; }
        if (dirty) await user.save();
      } else {
        if (!isAllowedEmailDomain(email)) {
          return redirectError(DISALLOWED_EMAIL_DOMAIN_MSG);
        }
        const randomPassword = crypto.randomBytes(32).toString('hex');
        user = await User.create({
          name: displayName,
          email,
          password: randomPassword,
          role: 'user',
          email_verified: true,
          avatar: avatarUrl,
          subscription: { plan_name: 'Free', starts_at: new Date(), expires_at: null, is_active: true, payment_source: 'free' }
        });
        try {
          const { getPersistedUsers, savePersistedUsers } = require('../../utils/getModelConfig');
          let users = await getPersistedUsers();
          users = [...users, {
            _id: String(user._id),
            id: String(user._id),
            name: user.name,
            email: user.email,
            password: user.password,
            role: user.role,
            email_verified: true,
            avatar: user.avatar,
            is_blocked: false,
            subscription: user.subscription,
            createdAt: user.createdAt
          }];
          await savePersistedUsers(users);
          debouncedSave();
        } catch (syncErr) {}
      }
    } else {
      const { getPersistedUsers, savePersistedUsers } = require('../../utils/getModelConfig');
      let users = await getPersistedUsers();
      users = [...users];
      user = users.find(u => u.email && u.email.toLowerCase().trim() === email);
      if (user && user.is_blocked) {
        return redirectError('আপনার অ্যাকাউন্টটি ব্লক করা হয়েছে। সহায়তার জন্য অ্যাডমিনের সাথে যোগাযোগ করুন।');
      }
      if (user) {
        let dirty = false;
        if (!user.email_verified) {
          user.email_verified = true;
          if (!isSuperAdminEmail(email)) {
            user.password = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
          }
          dirty = true;
        }
        if (dirty) {
          await savePersistedUsers(users);
          debouncedSave();
        }
      } else {
        if (!isAllowedEmailDomain(email)) {
          return redirectError(DISALLOWED_EMAIL_DOMAIN_MSG);
        }
        const hashedPassword = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
        user = {
          _id: 'user_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          name: displayName,
          email,
          password: hashedPassword,
          role: 'user',
          email_verified: true,
          avatar: avatarUrl,
          is_blocked: false,
          subscription: { plan_name: 'Free', starts_at: new Date(), expires_at: null, is_active: true, payment_source: 'free' },
          createdAt: new Date()
        };
        users.push(user);
        await savePersistedUsers(users);
        debouncedSave();
      }
    }

    const token = generateToken(user);
    const webUrl = `${frontBase}/auth/login#oauth_token=${encodeURIComponent(token)}&redirect=${encodeURIComponent(safeRedirect)}`;
    if (stateInfo && stateInfo.nativeApp) {
      return sendNativeOAuthBridge(
        res,
        `alora://auth#oauth_token=${encodeURIComponent(token)}&redirect=${encodeURIComponent(safeRedirect)}&origin=${encodeURIComponent(resolvedOrigin)}`,
        webUrl,
        false
      );
    }
    return res.redirect(webUrl);
  } catch (error) {
    console.error('[Discord OAuth Callback Error]:', error.message);
    return redirectError('Discord Sign-In failed. Please try email login or try again.');
  }
};


const deleteAccount = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'অননুমোদিত রিকোয়েস্ট' });
    }
    const userId = String(req.user._id || req.user.id || '');
    const userEmail = String(req.user.email || '').toLowerCase().trim();
    if (isSuperAdminEmail(userEmail)) {
      return res.status(400).json({ success: false, error: 'মূল অ্যাডমিন অ্যাকাউন্ট মুছে ফেলা সম্ভব নয়।' });
    }

    if (getIsMongoConnected()) {
      const UsageLog = require('../models/UsageLog');
      const queryOr = [];
      if (isStrictObjectId(userId)) queryOr.push({ _id: userId });
      if (userEmail) queryOr.push({ email: userEmail });
      if (queryOr.length > 0) {
        await User.deleteMany({ $or: queryOr }).catch(() => {});
      }
      await UsageLog.deleteMany({ user_id: userId }).catch(() => {});
    }

    try {
      const { getPersistedUsers, savePersistedUsers, invalidateUsersCache, invalidateUserUsageCache } = require('../../utils/getModelConfig');
      let users = await getPersistedUsers();
      users = users.filter(u => {
        const uId = String(u._id || u.id || '');
        const uEm = String(u.email || '').toLowerCase().trim();
        return uId !== userId && (!userEmail || uEm !== userEmail);
      });
      await savePersistedUsers(users);
      if (memoryStore.users) {
        memoryStore.users = memoryStore.users.filter(u => {
          const uId = String(u._id || u.id || '');
          const uEm = String(u.email || '').toLowerCase().trim();
          return uId !== userId && (!userEmail || uEm !== userEmail);
        });
      }
      if (memoryStore.usageLogs) {
        memoryStore.usageLogs = memoryStore.usageLogs.filter(l => String(l.user_id) !== userId);
      }
      debouncedSave();
      if (typeof invalidateUsersCache === 'function') invalidateUsersCache();
      if (typeof invalidateUserUsageCache === 'function') {
        invalidateUserUsageCache(userId);
        if (userEmail) invalidateUserUsageCache(userEmail);
      }
    } catch (e) {}

    invalidateCachedUser(userId);
    if (userEmail) invalidateCachedUser(userEmail);

    return res.json({ success: true, message: 'আপনার অ্যাকাউন্ট সম্পূর্ণ মুছে ফেলা হয়েছে।' });
  } catch (error) {
    return sendServerError(res, error, 'সার্ভারে ত্রুটি হয়েছে। অনুগ্রহ করে পরে আবার চেষ্টা করুন।', '[Auth Error]:');
  }
};

module.exports = { registerUser, loginUser, getMe, updateProfile, changePassword, forgotPassword, getAuthProviders, googleAuth, googleCallback, discordAuth, discordCallback, deleteAccount };



