const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const User = require('../models/User');
const { getIsMongoConnected } = require('../config/db');
const { memoryStore, debouncedSave } = require('../config/memoryStore');
const { JWT_SECRET } = require('../config/jwtSecret');
const { getCachedPlan, setCachedPlan, getCachedUser, setCachedUser, invalidateCachedUser } = require('../config/dbCache');

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
        subscription: { plan_name: 'Free', starts_at: new Date(), expires_at: null, is_active: true }
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
        subscription: { plan_name: 'Free', starts_at: new Date(), expires_at: null, is_active: true },
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
    res.status(500).json({ success: false, error: error.message });
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
        user.subscription = { plan_name: 'Max', starts_at: new Date(), expires_at: null, is_active: true };
        await user.save();
      } else if (user.subscription && user.subscription.plan_name !== 'Free' && user.subscription.expires_at) {
        if (new Date() > new Date(user.subscription.expires_at)) {
          user.subscription.plan_name = 'Free';
          user.subscription.expires_at = null;
          user.subscription.is_active = true;
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
    res.status(500).json({ success: false, error: error.message });
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
      if (targetUserId && mongoose.Types.ObjectId.isValid(targetUserId)) {
        user = await User.findById(targetUserId).select('-password').lean();
      }
      if (!user && targetUserId) {
        user = await User.findOne({ $or: [{ _id: targetUserId }, { id: targetUserId }] }).select('-password').lean();
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
          const q = mongoose.Types.ObjectId.isValid(uId) ? { _id: uId } : { $or: [{ _id: uId }, { id: uId }, ...(user.email ? [{ email: user.email }] : [])] };
          await User.updateOne(q, { $set: { subscription: user.subscription } }).catch(() => {});
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
        const defaultLimits = { 'Free': { limit: 10, window: 3 }, 'Pro': { limit: 30, window: 3 }, 'Max': { limit: 50, window: 1 } };
        const def = defaultLimits[currentPlanName] || defaultLimits['Free'];
        plan = { message_limit: def.limit, window_hours: def.window, name: currentPlanName };
        setCachedPlan(currentPlanName, plan);
      }

      const planLimit = Number(plan.message_limit) || 10;
      const planWindow = Number(plan.window_hours) || 3;
      
      const userId = String(user._id || user.id);
      const windowStart = new Date(Date.now() - planWindow * 60 * 60 * 1000);
      let messageCount = 0;
      let imageCount = 0;
      let resetTimeMinutes = Math.round(planWindow * 60);
      let resetAt = null;
      let windowStartTs = windowStart.getTime();
      
      if (getIsMongoConnected()) {
        const userQuery = mongoose.Types.ObjectId.isValid(userId) ? { $in: [userId, new mongoose.Types.ObjectId(userId)] } : userId;
        const [cnt, imgCnt, oldestLog] = await Promise.all([
          UsageLog.countDocuments({ user_id: userQuery, model_id: { $ne: 'image-generation' }, timestamp: { $gte: windowStart } }),
          UsageLog.countDocuments({ user_id: userQuery, model_id: 'image-generation', timestamp: { $gte: windowStart } }),
          UsageLog.findOne({ user_id: userQuery, model_id: { $ne: 'image-generation' }, timestamp: { $gte: windowStart } }).sort({ timestamp: 1 }).select('timestamp').lean()
        ]);
        messageCount = cnt;
        imageCount = imgCnt;
        if (oldestLog) {
          const resetMs = new Date(oldestLog.timestamp).getTime() + planWindow * 60 * 60 * 1000;
          resetTimeMinutes = Math.max(1, Math.ceil((resetMs - Date.now()) / (60 * 1000)));
          resetAt = new Date(resetMs).toISOString();
          windowStartTs = new Date(oldestLog.timestamp).getTime();
        } else {
          resetAt = new Date(Date.now() + planWindow * 60 * 60 * 1000).toISOString();
        }
      } else {
        const { getUserUsageDetails, getUserImageUsageDetails } = require('../../utils/getModelConfig');
        const [usageDetails, imgDetails] = await Promise.all([
          getUserUsageDetails(userId, planWindow),
          getUserImageUsageDetails(userId, planWindow)
        ]);
        const memCount = (memoryStore.usageLogs || []).filter(l => String(l.user_id) === userId && l.model_id !== 'image-generation' && new Date(l.timestamp) >= windowStart).length;
        const memImgCount = (memoryStore.usageLogs || []).filter(l => String(l.user_id) === userId && l.model_id === 'image-generation' && new Date(l.timestamp) >= windowStart).length;
        messageCount = Math.max(usageDetails.count, memCount);
        imageCount = Math.max(imgDetails.count, memImgCount);
        resetTimeMinutes = usageDetails.resetInMinutes;
        if (usageDetails.resetAt) {
          resetAt = usageDetails.resetAt;
          windowStartTs = usageDetails.start || (new Date(resetAt).getTime() - planWindow * 60 * 60 * 1000);
        } else {
          resetAt = new Date(Date.now() + resetTimeMinutes * 60 * 1000).toISOString();
        }
      }

      const planImageLimit = (plan.image_limit !== undefined && !isNaN(Number(plan.image_limit)))
        ? Number(plan.image_limit)
        : (currentPlanName === 'Free' ? 5 : (currentPlanName === 'Pro' ? 25 : 100));
      
      rateLimit = {
        used: messageCount,
        limit: planLimit,
        imageUsed: imageCount,
        image_used: imageCount,
        imageLimit: planImageLimit,
        image_limit: planImageLimit,
        imageRemaining: Math.max(0, planImageLimit - imageCount),
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
        remaining: 999999,
        resetInMinutes: 0,
        windowHours: 1,
        resetAt: null,
        start: Date.now()
      };
    }

    const finalId = user._id || user.id;
    const refreshedToken = generateToken(user);
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
        subscription: user.subscription,
        avatar: user.avatar,
        rateLimit,
        usage
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const updateProfile = async (req, res) => {
  try {
    const { name, avatar, email } = req.body;
    if (name !== undefined && typeof name !== 'string') return res.status(400).json({ success: false, error: 'অবৈধ নাম' });
    if (avatar !== undefined && typeof avatar !== 'string') return res.status(400).json({ success: false, error: 'অবৈধ প্রোফাইল ছবি' });
    if (email !== undefined && typeof email !== 'string') return res.status(400).json({ success: false, error: 'অবৈধ ইমেইল ঠিকানা' });
    if (avatar && avatar.length > 50000) return res.status(400).json({ success: false, error: 'ছবির সাইজ অতিরিক্ত বড় (সর্বোচ্চ 50KB)' });
    const isAvatarPreset = avatar && (avatar.startsWith('avatars/') || avatar.startsWith('/avatars/') || /^avatar_\d+\.svg$/.test(avatar));
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
      if (mongoose.Types.ObjectId.isValid(targetUserId)) {
        user = await User.findById(targetUserId);
      }
      // Independent fallback: an ObjectId-shaped id that matches no document must still
      // resolve by email, otherwise every profile update 404s.
      if (!user && req.user && req.user.email) {
        user = await User.findOne({ email: req.user.email.toLowerCase().trim() });
      }
      if (user) {
        if (cleanEmail && cleanEmail !== user.email) {
          const duplicateUser = await User.findOne({ email: cleanEmail });
          if (duplicateUser && String(duplicateUser._id) !== String(user._id)) {
            return res.status(400).json({ success: false, error: 'এই ইমেইল দিয়ে ইতিমধ্যে একটি অ্যাকাউন্ট তৈরি আছে' });
          }
          user.email = cleanEmail;
        }
        if (cleanName) user.name = cleanName;
        if (avatar !== undefined) user.avatar = avatar;
        await user.save();

        // Sync profile changes to Supabase and memoryStore
        try {
          const { getPersistedUsers, savePersistedUsers } = require('../../utils/getModelConfig');
          let users = await getPersistedUsers();
          users = [...users];
          const pUser = users.find(u => String(u._id) === String(user._id) || String(u.id) === String(user._id) || (u.email && u.email.toLowerCase().trim() === user.email.toLowerCase().trim()));
          if (pUser) {
            if (cleanName) pUser.name = cleanName;
            if (avatar !== undefined) pUser.avatar = avatar;
            if (cleanEmail) pUser.email = cleanEmail;
            await savePersistedUsers(users);
          }
          if (memoryStore.users) {
            const mUser = memoryStore.users.find(u => String(u._id) === String(user._id) || String(u.id) === String(user._id) || (u.email && u.email.toLowerCase().trim() === user.email.toLowerCase().trim()));
            if (mUser) {
              if (cleanName) mUser.name = cleanName;
              if (avatar !== undefined) mUser.avatar = avatar;
              if (cleanEmail) mUser.email = cleanEmail;
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
      if (cleanEmail) {
        const dup = users.find(u => u.email && u.email.toLowerCase().trim() === cleanEmail && String(u._id || u.id) !== String(targetUserId));
        if (dup) {
          return res.status(400).json({ success: false, error: 'এই ইমেইল দিয়ে ইতিমধ্যে একটি অ্যাকাউন্ট তৈরি আছে' });
        }
      }
      if (uIdx !== -1) {
        if (cleanName) users[uIdx].name = cleanName;
        if (avatar !== undefined) users[uIdx].avatar = avatar;
        if (cleanEmail) users[uIdx].email = cleanEmail;
        user = users[uIdx];
        await savePersistedUsers(users);
      } else {
        user = (memoryStore.users && memoryStore.users.find(u => String(u._id || u.id) === String(targetUserId))) || req.user;
        if (cleanName) user.name = cleanName;
        if (avatar !== undefined) user.avatar = avatar;
        if (cleanEmail) user.email = cleanEmail;
      }
      if (memoryStore.users) {
        const mUser = memoryStore.users.find(u => String(u._id || u.id) === String(targetUserId));
        if (mUser) {
          if (cleanName) mUser.name = cleanName;
          if (avatar !== undefined) mUser.avatar = avatar;
          if (cleanEmail) mUser.email = cleanEmail;
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
    res.status(500).json({ success: false, error: error.message });
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
      if (mongoose.Types.ObjectId.isValid(userId)) {
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
    res.status(500).json({ success: false, error: error.message });
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
    res.status(500).json({ success: false, error: error.message });
  }
};

const googleAuth = async (req, res) => {
  try {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (clientId) {
      const redirectUri = `${req.protocol}://${req.get('host')}/api/auth/google/callback`;
      const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=openid%20profile%20email`;
      return res.json({ success: true, url });
    }
    return res.status(501).json({
      success: false,
      error: 'Google OAuth configuration is currently pending on the server. Please log in with your email and password or continue as Guest.'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
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
      if (mongoose.Types.ObjectId.isValid(userId)) queryOr.push({ _id: userId });
      if (userId) queryOr.push({ id: userId });
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
    return res.status(500).json({ success: false, error: error.message });
  }
};

module.exports = { registerUser, loginUser, getMe, updateProfile, changePassword, forgotPassword, googleAuth, deleteAccount };



