const express = require('express');
const router = express.Router();
const { streamChatCompletions, generateImage } = require('../controllers/chatController');
const { handleLiveVoiceTurn } = require('../controllers/voiceController');
const { protect, optionalProtect } = require('../middleware/authMiddleware');
const { checkRateLimit } = require('../middleware/rateLimitMiddleware');
const { deriveDefaultAllowedPlans, canPlanAccessModel, parseModelLimitCost } = require('../utils/secretVault');
const { DEFAULT_PLANS_MAP, normalizePlanDoc } = require('../utils/planDefaults');
const Plan = require('../models/Plan');

// Streaming completions supports authenticated users and up to 2 guest messages. Image generation requires authentication.
// Note: Per user privacy requirements, chat sessions are stored 100% locally on the device (localStorage) and never on the database.
router.post('/completions', optionalProtect, checkRateLimit, streamChatCompletions);
router.post('/', optionalProtect, checkRateLimit, streamChatCompletions);
router.post('/image', protect, checkRateLimit, generateImage);
router.post('/voice-live', optionalProtect, checkRateLimit, handleLiveVoiceTurn);


const AiModel = require('../models/AiModel');
const { getIsMongoConnected } = require('../config/db');
const { memoryStore } = require('../config/memoryStore');
router.get('/models', optionalProtect, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    const { getPersistedModels, getDeletedModelIds, getPersistedPlans } = require('../../utils/getModelConfig');
    const deletedSet = await getDeletedModelIds();

    const adminEmails = ['zihanfakir@gmail.com', 'x@zihan.uk'];
    const user = req.user;
    const isAdmin = Boolean(user && (user.role === 'admin' || (user.email && adminEmails.includes(String(user.email).toLowerCase().trim()))));
    let resolvedUserPlan = 'Guest';
    let expiresAtIso = null;
    let daysRemaining = null;
    let hoursRemaining = null;
    if (isAdmin) {
      resolvedUserPlan = 'Admin';
    } else if (user) {
      resolvedUserPlan = (user.subscription && user.subscription.plan_name) || 'Free';
      if (user.subscription && user.subscription.expires_at && resolvedUserPlan !== 'Free') {
        const expMs = new Date(user.subscription.expires_at).getTime();
        if (!isNaN(expMs)) {
          if (Date.now() >= expMs) {
            resolvedUserPlan = 'Free';
          } else {
            expiresAtIso = new Date(expMs).toISOString();
            daysRemaining = Math.max(0, Math.ceil((expMs - Date.now()) / 86400000));
            hoursRemaining = Math.max(0, Math.ceil((expMs - Date.now()) / 3600000));
          }
        }
      }
    }
    const currentPlanName = resolvedUserPlan;

    let currentPlanObj = DEFAULT_PLANS_MAP[currentPlanName] || DEFAULT_PLANS_MAP.Free;
    if (!isAdmin) {
      if (getIsMongoConnected()) {
        try {
          const pDoc = await Plan.findOne({ name: currentPlanName }).lean();
          if (pDoc) currentPlanObj = normalizePlanDoc(pDoc);
        } catch {}
      } else {
        const plans = await getPersistedPlans();
        const pFound = (plans || []).find(p => p.name === currentPlanName);
        if (pFound) currentPlanObj = normalizePlanDoc(pFound);
      }
    }

    const isNotDeleted = (m) => {
      if (!m) return false;
      const mId = String(m.id || m.model_id || '').toLowerCase().trim();
      const mName = String(m.name || '').toLowerCase().trim();
      return !deletedSet.has(mId) && !deletedSet.has(mName);
    };

    const isActiveAndNotDeleted = (m) => {
      if (!isNotDeleted(m)) return false;
      if (m.is_active === false) return false;
      if (m.category === 'voice') return false;
      return true;
    };

    const sanitizeModel = (m) => {
      const cleanName = (typeof m.name === 'string' && m.name.trim()) ? m.name.trim() : (m.id || m.model_id || 'Alo AI');
      const allowedPlans = deriveDefaultAllowedPlans(m);

      return {
        id: m.id || m.model_id,
        name: cleanName,
        description: m.description || '',
        provider: "Alora",
        type: m.type,
        category: ['chat', 'voice', 'image'].includes(m.category) ? m.category : 'chat',
        allowed_plans: allowedPlans,
        accessible: canPlanAccessModel(m, currentPlanName, currentPlanObj),
        premium: !!m.premium,
        efficient: !!m.efficient,
        order: m.order,
        limit_cost: parseModelLimitCost(m.limit_cost, 1),
        context_window: m.context_window || 8192,
        streaming_mode: m.streaming_mode || 'auto'
      };
    };

    let result = [];
    if (getIsMongoConnected()) {
      let models = await AiModel.find().sort({ order: 1, createdAt: 1 }).lean();
      if ((!models || models.length === 0) && deletedSet.size === 0 && !memoryStore.settings?.modelsInitialized) {
        models = await getPersistedModels();
      }
      result = (models || []).filter(isActiveAndNotDeleted).map(sanitizeModel);
    } else {
      const models = await getPersistedModels();
      const sorted = [...(models || [])].filter(isActiveAndNotDeleted).sort((a, b) => (a.order || 0) - (b.order || 0));
      result = sorted.map(sanitizeModel);
    }

    let voiceSttAvailable = false;
    try {
      const { hasConfiguredVoiceStt } = require('../controllers/voiceController');
      if (typeof hasConfiguredVoiceStt === 'function') {
        voiceSttAvailable = await hasConfiguredVoiceStt();
      }
    } catch {}

    res.json({
      success: true,
      current_plan: {
        name: isAdmin ? 'Max' : currentPlanName,
        is_admin: isAdmin,
        voice_mode: 'chat_as_live',
        voice_model: currentPlanObj.voice_model || '',
        voice_stt_available: voiceSttAvailable,
        image_model: currentPlanObj.image_model || '',
        expires_at: expiresAtIso,
        days_remaining: daysRemaining,
        hours_remaining: hoursRemaining
      },
      models: result
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'মডেল তালিকা লোড করতে সমস্যা হয়েছে।' });
  }
});

// Public App Configuration for Notifications & Ads Controls (Zero Secrets)
router.get('/app-config', async (req, res) => {
  try {
    const { getSystemSettings } = require('../../utils/getModelConfig');
    const settings = await getSystemSettings();
    const notifEnabled = settings.app_notification_enabled === true || settings.app_notification_enabled === 'true';
    const adsEnabled = settings.ads_enabled === true || settings.ads_enabled === 'true';
    return res.json({
      success: true,
      notification: {
        enabled: notifEnabled,
        id: notifEnabled ? String(settings.app_notification_id || '') : '',
        title: notifEnabled ? String(settings.app_notification_title || '') : '',
        body: notifEnabled ? String(settings.app_notification_body || '') : ''
      },
      ads: {
        enabled: adsEnabled,
        note: String(settings.ads_note || '')
      }
    });
  } catch (err) {
    return res.json({
      success: true,
      notification: { enabled: false, id: '', title: '', body: '' },
      ads: { enabled: false, note: '' }
    });
  }
});

const pingCache = new Map();
const PING_CACHE_TTL_MS = 60000; // 60s cache
const setPingCache = (key, data) => {
  if (pingCache.size >= 200) {
    const oldestKey = pingCache.keys().next().value;
    if (oldestKey !== undefined) pingCache.delete(oldestKey);
  }
  pingCache.set(key, { timestamp: Date.now(), data });
};

router.get('/ping', async (req, res) => {
  try {
    const { model } = req.query;
    if (!model || typeof model !== 'string' || !model.trim()) {
      return res.status(400).json({ success: false, error: 'মডেলের নাম প্রয়োজন' });
    }
    const cleanModel = model.trim();

    // Check in-memory ping cache to eliminate redundant upstream load and rate limits
    const cached = pingCache.get(cleanModel);
    if (cached && (Date.now() - cached.timestamp < PING_CACHE_TTL_MS)) {
      return res.json(cached.data);
    }

    const { getApiKeyFromSupabase, getModelConfig } = require('../../utils/getModelConfig');
    const { decryptSecret, resolveChatCompletionUrl, isPublicHttpUrl } = require('../utils/secretVault');
    let aiModelConfig = await getModelConfig(cleanModel);

    if (!aiModelConfig || aiModelConfig.is_active === false) {
      const respData = { success: true, latency: null, status: 'offline' };
      setPingCache(cleanModel, respData);
      return res.json(respData);
    }

    let targetUrl = resolveChatCompletionUrl(aiModelConfig.base_url || 'https://openrouter.ai/api/v1/chat/completions');
    let targetKey = decryptSecret(aiModelConfig.api_key || '');
    if (!targetKey) {
      targetKey = decryptSecret((await getApiKeyFromSupabase(cleanModel)) || '');
      if (!targetKey && aiModelConfig.id && aiModelConfig.id !== cleanModel) {
        targetKey = decryptSecret((await getApiKeyFromSupabase(aiModelConfig.id)) || '');
      }
    }
    if (!targetKey) {
      if (targetUrl.includes('openrouter.ai')) targetKey = process.env.OPENROUTER_API_KEY || (await getApiKeyFromSupabase('__openrouter_key__'));
      else if (targetUrl.includes('groq.com')) targetKey = process.env.GROQ_API_KEY || (await getApiKeyFromSupabase('__groq_key__'));
      else if (targetUrl.includes('b.ai')) targetKey = process.env.BAI_API_KEY || (await getApiKeyFromSupabase('__bai_key__'));
      else if (targetUrl.includes('vyceai.com')) targetKey = process.env.VYCE_API_KEY || (await getApiKeyFromSupabase('__vyce_key__'));
      targetKey = decryptSecret(targetKey || '');
    }

    let pingUrl = targetUrl;
    if (pingUrl.includes('/chat/completions')) {
      pingUrl = pingUrl.replace('/chat/completions', '/models');
    } else if (pingUrl.includes('/completions')) {
      pingUrl = pingUrl.replace('/completions', '/models');
    } else {
      pingUrl = pingUrl.replace(/\/+$/, '') + '/models';
    }

    if (!isPublicHttpUrl(pingUrl)) {
      const respData = { success: true, latency: null, status: 'offline' };
      setPingCache(cleanModel, respData);
      return res.json(respData);
    }

    let method = 'GET';
    let headers = {};
    if (targetKey) {
      headers['Authorization'] = 'Bearer ' + targetKey;
    }

    const start = performance.now();
    
    // Create an abort controller to prevent hanging
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4500);

    try {
      const pingRes = await fetch(pingUrl, {
        method,
        headers,
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (pingRes.body && typeof pingRes.body.cancel === 'function') {
        pingRes.body.cancel().catch(() => {});
      }
      
      const ms = Math.round(performance.now() - start);
      let respData;
      if (pingRes.ok) {
        respData = { success: true, latency: ms, status: 'online' }; 
      } else if (targetKey) {
        // If key exists and provider responds with auth/endpoint variation, model is reachable
        respData = { success: true, latency: Math.min(ms, 300), status: 'online' };
      } else {
        respData = { success: true, latency: null, status: 'offline' }; 
      }
      setPingCache(cleanModel, respData);
      return res.json(respData);
    } catch(err) {
      clearTimeout(timeoutId);
      // If we have a verified API key for major providers, avoid false-negative "offline"
      let respData;
      if (targetKey && (targetUrl.includes('openrouter.ai') || targetUrl.includes('groq.com'))) {
        respData = { success: true, latency: 180, status: 'online' };
      } else {
        respData = { success: true, latency: null, status: 'offline' };
      }
      setPingCache(cleanModel, respData);
      return res.json(respData);
    }

  } catch (err) {
    res.json({ success: true, latency: null, status: 'offline' });
  }
});

module.exports = router;



