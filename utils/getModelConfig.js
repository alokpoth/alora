// utils/getModelConfig.js
// Primary persistence in MongoDB (SystemSetting, AiModel, Plan, RedeemCode, PromoCode, PaymentOrder, User, UsageLog)
// with fast in-memory caching and local memoryStore fallback. Zero Supabase dependency.
const { memoryStore, debouncedSave } = require('../server/config/memoryStore');

// Cache: avoid repeated DB hits per request cycle (1 min TTL)
const keyCache = new Map(); // keyId -> { api_key, ts }
const CACHE_TTL = 60 * 1000;

async function getStoredApiKey(modelId) {
  if (!modelId) return null;
  const now = Date.now();
  const cached = keyCache.get(modelId);
  if (cached && (now - cached.ts) < CACHE_TTL) {
    return cached.api_key;
  }

  const { getIsMongoConnected } = require('../server/config/db');
  if (getIsMongoConnected()) {
    try {
      const SystemSetting = require('../server/models/SystemSetting');
      const doc = await SystemSetting.findOne({ key: `__api_key__:${modelId}` }).lean();
      if (doc && typeof doc.value === 'string' && doc.value.trim()) {
        keyCache.set(modelId, { api_key: doc.value, ts: now });
        return doc.value;
      }
      if (!String(modelId).startsWith('__')) {
        const AiModel = require('../server/models/AiModel');
        const mDoc = await AiModel.findOne({ $or: [{ model_id: modelId }, { id: modelId }] }).select('api_key').lean();
        if (mDoc && mDoc.api_key) {
          keyCache.set(modelId, { api_key: mDoc.api_key, ts: now });
          return mDoc.api_key;
        }
      }
    } catch (e) {
      console.warn('[MongoDB] api_key lookup warning for', modelId, e.message);
    }
  }

  if (memoryStore.apiKeys && typeof memoryStore.apiKeys[modelId] === 'string' && memoryStore.apiKeys[modelId]) {
    const k = memoryStore.apiKeys[modelId];
    keyCache.set(modelId, { api_key: k, ts: now });
    return k;
  }

  return null;
}

async function saveStoredApiKey(modelId, apiKey) {
  if (!modelId) return;
  const cleanKey = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!memoryStore.apiKeys || typeof memoryStore.apiKeys !== 'object') {
    memoryStore.apiKeys = {};
  }
  if (cleanKey) {
    memoryStore.apiKeys[modelId] = cleanKey;
    keyCache.set(modelId, { api_key: cleanKey, ts: Date.now() });
  } else {
    delete memoryStore.apiKeys[modelId];
    keyCache.delete(modelId);
  }
  debouncedSave();

  const { getIsMongoConnected } = require('../server/config/db');
  if (getIsMongoConnected()) {
    try {
      const SystemSetting = require('../server/models/SystemSetting');
      if (cleanKey) {
        await SystemSetting.findOneAndUpdate(
          { key: `__api_key__:${modelId}` },
          { $set: { value: cleanKey } },
          { upsert: true }
        );
      } else {
        await SystemSetting.deleteOne({ key: `__api_key__:${modelId}` });
      }
    } catch (e) {
      console.error('[MongoDB] saveStoredApiKey error:', e.message);
    }
  }
  invalidateModelKeyCache(modelId);
}

async function deleteStoredApiKey(modelId) {
  return saveStoredApiKey(modelId, '');
}

// Backward-compatible alias used by controllers
const getApiKeyFromSupabase = getStoredApiKey;

const MODEL_ALIASES = {
  'gemini-1.5-flash': 'gemini-3.6-flash',
  'gemini-2.5-flash': 'gemini-3.6-flash',
  'gemini-flash': 'gemini-3.6-flash',
  'alo-pro': 'openai/gpt-oss-120b',
  'llama-3.3-70b-versatile': 'openai/gpt-oss-120b',
  'deepseek-r1-distill-llama-70b': 'qwen/qwen3.8-27b',
  'hy3': 'openai/gpt-oss-120b',
  'mimo-v2.5': 'gemini-3.6-flash'
};

function resolveModelAlias(rawId) {
  if (!rawId || typeof rawId !== 'string') return rawId;
  let current = rawId;
  let depth = 0;
  while (MODEL_ALIASES[current] && depth < 3) {
    current = MODEL_ALIASES[current];
    depth++;
  }
  return current;
}

async function getModelConfig(rawId) {
  if (!rawId) return null;
  const { getIsMongoConnected } = require('../server/config/db');

  const deletedSet = await getDeletedModelIds();
  const cleanRaw = String(rawId || '').toLowerCase().trim();
  if (deletedSet.has(cleanRaw)) {
    return null;
  }

  let model = null;

  // 1. Canonical MongoDB check first when connected
  if (getIsMongoConnected()) {
    try {
      const AiModel = require('../server/models/AiModel');
      const mongoDoc = await AiModel.findOne({ $or: [{ model_id: rawId }, { id: rawId }] }).lean();
      if (mongoDoc) {
        model = { ...mongoDoc, id: mongoDoc.id || mongoDoc.model_id, model_id: mongoDoc.model_id || mongoDoc.id };
      }
    } catch (e) {}
  }

  // 2. Direct match in persisted models / memoryStore BEFORE resolving any alias
  const allModels = await getPersistedModels();
  if (!model) {
    model = allModels.find(m => m && (m.id === rawId || m.model_id === rawId));
  }
  if (!model && Array.isArray(memoryStore?.models)) {
    model = memoryStore.models.find(m => m && (m.id === rawId || m.model_id === rawId));
  }

  // 3. Only fall back to legacy alias if no direct match exists
  if (!model) {
    const aliasedId = resolveModelAlias(rawId);
    if (aliasedId && aliasedId !== rawId) {
      const cleanAlias = String(aliasedId).toLowerCase().trim();
      if (!deletedSet.has(cleanAlias)) {
        if (getIsMongoConnected()) {
          try {
            const AiModel = require('../server/models/AiModel');
            const aliasDoc = await AiModel.findOne({ $or: [{ model_id: aliasedId }, { id: aliasedId }] }).lean();
            if (aliasDoc) {
              model = { ...aliasDoc, id: aliasDoc.id || aliasDoc.model_id, model_id: aliasDoc.model_id || aliasDoc.id };
            }
          } catch (e) {}
        }
        if (!model) {
          model = allModels.find(m => m && (m.id === aliasedId || m.model_id === aliasedId));
        }
        if (!model && Array.isArray(memoryStore?.models)) {
          model = memoryStore.models.find(m => m && (m.id === aliasedId || m.model_id === aliasedId));
        }
      }
    }
  }

  const effectiveId = model ? (model.id || model.model_id) : rawId;

  // 4. Load API key from model first, then SystemSetting store if missing
  let apiKey = (model && model.api_key) ? model.api_key : null;
  if (!apiKey) {
    apiKey = await getStoredApiKey(effectiveId);
  }
  if (!apiKey && rawId !== effectiveId) {
    apiKey = await getStoredApiKey(rawId);
  }

  if (model) {
    return { ...model, api_key: apiKey || null };
  }

  if (apiKey) {
    return { id: rawId, model_id: rawId, api_key: apiKey };
  }

  return null;
}

function invalidateModelKeyCache(modelId) {
  modelsCache = null;
  modelsCacheTs = 0;
  if (modelId) {
    keyCache.delete(modelId);
  } else {
    keyCache.clear();
  }
}

let modelsCache = null;
let modelsCacheTs = 0;

function invalidateModelsCache() {
  modelsCache = null;
  modelsCacheTs = 0;
}

let deletedModelIdsCache = null;
let deletedModelIdsTs = 0;

function invalidateDeletedModelsCache() {
  deletedModelIdsCache = null;
  deletedModelIdsTs = 0;
}

async function getDeletedModelIds() {
  const now = Date.now();
  if (deletedModelIdsCache && (now - deletedModelIdsTs) < 10000) {
    return deletedModelIdsCache;
  }
  const set = new Set();
  if (Array.isArray(memoryStore.deletedModelIds)) {
    memoryStore.deletedModelIds.forEach(id => {
      if (id) set.add(String(id).toLowerCase().trim());
    });
  }
  const { getIsMongoConnected } = require('../server/config/db');
  if (getIsMongoConnected()) {
    try {
      const SystemSetting = require('../server/models/SystemSetting');
      const doc = await SystemSetting.findOne({ key: '__deleted_models__' }).lean();
      if (doc && Array.isArray(doc.value)) {
        doc.value.forEach(id => {
          if (id) set.add(String(id).toLowerCase().trim());
        });
      }
    } catch (e) {}
  }
  deletedModelIdsCache = set;
  deletedModelIdsTs = now;
  return set;
}

async function addDeletedModelId(modelId) {
  if (!modelId) return;
  const cleanId = String(modelId).toLowerCase().trim();
  const set = await getDeletedModelIds();
  set.add(cleanId);
  try {
    const decoded = decodeURIComponent(modelId).toLowerCase().trim();
    if (decoded) set.add(decoded);
  } catch (e) {}

  if (!Array.isArray(memoryStore.deletedModelIds)) {
    memoryStore.deletedModelIds = [];
  }
  const list = Array.from(set);
  memoryStore.deletedModelIds = list;
  debouncedSave();

  const { getIsMongoConnected } = require('../server/config/db');
  if (getIsMongoConnected()) {
    try {
      const SystemSetting = require('../server/models/SystemSetting');
      await SystemSetting.findOneAndUpdate(
        { key: '__deleted_models__' },
        { $set: { value: list } },
        { upsert: true }
      );
    } catch (e) {}
  }

  invalidateDeletedModelsCache();
  invalidateModelsCache();
}

async function removeDeletedModelId(modelId) {
  if (!modelId) return;
  const cleanId = String(modelId).toLowerCase().trim();
  const set = await getDeletedModelIds();
  set.delete(cleanId);
  try {
    const decoded = decodeURIComponent(modelId).toLowerCase().trim();
    if (decoded) set.delete(decoded);
  } catch (e) {}

  if (!Array.isArray(memoryStore.deletedModelIds)) {
    memoryStore.deletedModelIds = [];
  }
  const list = Array.from(set);
  memoryStore.deletedModelIds = list;
  debouncedSave();

  const { getIsMongoConnected } = require('../server/config/db');
  if (getIsMongoConnected()) {
    try {
      const SystemSetting = require('../server/models/SystemSetting');
      await SystemSetting.findOneAndUpdate(
        { key: '__deleted_models__' },
        { $set: { value: list } },
        { upsert: true }
      );
    } catch (e) {}
  }

  invalidateDeletedModelsCache();
  invalidateModelsCache();
}

async function getPersistedModels() {
  const now = Date.now();
  if (modelsCache && (now - modelsCacheTs) < 10000) {
    return modelsCache;
  }

  const deletedSet = await getDeletedModelIds();
  const filterDeleted = (list) => {
    if (!Array.isArray(list)) return [];
    return list.filter(m => {
      if (!m) return false;
      const mId = String(m.id || m.model_id || '').toLowerCase().trim();
      const mName = String(m.name || '').toLowerCase().trim();
      return !deletedSet.has(mId) && !deletedSet.has(mName);
    });
  };

  const { getIsMongoConnected } = require('../server/config/db');
  if (getIsMongoConnected()) {
    try {
      const AiModel = require('../server/models/AiModel');
      const mongoModels = await AiModel.find().sort({ order: 1, createdAt: 1 }).lean();
      if (Array.isArray(mongoModels) && (mongoModels.length > 0 || deletedSet.size > 0 || memoryStore.settings?.modelsInitialized)) {
        const normalized = filterDeleted(mongoModels).map(m => ({
          ...m,
          id: m.id || m.model_id,
          model_id: m.model_id || m.id
        }));
        modelsCache = normalized;
        modelsCacheTs = now;
        return normalized;
      }
    } catch (e) {
      console.warn('[MongoDB] getPersistedModels query warning:', e.message);
    }
  }

  const fallback = filterDeleted(memoryStore.models || []);
  modelsCache = fallback;
  modelsCacheTs = now;
  return fallback;
}

async function savePersistedModels(models) {
  modelsCache = models;
  modelsCacheTs = Date.now();

  if (!memoryStore.settings || typeof memoryStore.settings !== 'object') {
    memoryStore.settings = {};
  }
  memoryStore.settings.modelsInitialized = true;
  memoryStore.models = models;
  debouncedSave();
}

// High-Performance In-Memory Cache for User Quotas & Rate Limits (10s TTL)
const userUsageCache = new Map();
const userImgUsageCache = new Map();
const USAGE_CACHE_TTL = 10 * 1000;

function invalidateUserUsageCache(userId) {
  if (!userId) {
    userUsageCache.clear();
    userImgUsageCache.clear();
  } else {
    userUsageCache.delete(String(userId));
    userImgUsageCache.delete(String(userId));
  }
}

async function getUserUsageDetails(userId, windowHours) {
  const windowMs = (windowHours || 3) * 60 * 60 * 1000;
  const now = Date.now();
  const windowStart = now - windowMs;
  let count = 0;
  let start = now;

  const cached = userUsageCache.get(String(userId));
  if (cached && (now - cached.ts) < USAGE_CACHE_TTL && (now - cached.start) < windowMs) {
    count = cached.count || 0;
    start = cached.start;
  } else {
    const { getIsMongoConnected } = require('../server/config/db');
    if (getIsMongoConnected()) {
      try {
        const UsageLog = require('../server/models/UsageLog');
        const logs = await UsageLog.find({
          user_id: String(userId),
          model_id: { $ne: 'image-generation' },
          timestamp: { $gte: new Date(windowStart) }
        }).select('timestamp').lean();
        if (logs && logs.length > 0) {
          count = logs.length;
          start = Math.min(...logs.map(l => new Date(l.timestamp).getTime()));
        }
        userUsageCache.set(String(userId), { count, start, ts: now });
      } catch (e) {}
    }
  }

  const memLogs = (memoryStore.usageLogs || []).filter(l => String(l.user_id) === String(userId) && l.model_id !== 'image-generation' && new Date(l.timestamp).getTime() >= windowStart);
  if (memLogs.length > count) {
    count = memLogs.length;
    start = memLogs.length > 0 ? Math.min(...memLogs.map(l => new Date(l.timestamp).getTime())) : now;
    userUsageCache.set(String(userId), { count, start, ts: now });
  }

  const remainingMs = Math.max(0, (start + windowMs) - now);
  return {
    count,
    resetInMinutes: Math.max(1, Math.ceil(remainingMs / 60000)),
    resetAt: new Date(start + windowMs).toISOString(),
    start
  };
}

async function getUserUsage(userId, windowHours) {
  const details = await getUserUsageDetails(userId, windowHours);
  return details.count;
}

async function getUserImageUsageDetails(userId, windowHours) {
  const windowMs = (windowHours || 3) * 60 * 60 * 1000;
  const now = Date.now();
  const windowStart = now - windowMs;
  let count = 0;
  let start = now;

  const cached = userImgUsageCache.get(String(userId));
  if (cached && (now - cached.ts) < USAGE_CACHE_TTL && (now - cached.start) < windowMs) {
    count = cached.count || 0;
    start = cached.start;
  } else {
    const { getIsMongoConnected } = require('../server/config/db');
    if (getIsMongoConnected()) {
      try {
        const UsageLog = require('../server/models/UsageLog');
        const logs = await UsageLog.find({
          user_id: String(userId),
          model_id: 'image-generation',
          timestamp: { $gte: new Date(windowStart) }
        }).select('timestamp').lean();
        if (logs && logs.length > 0) {
          count = logs.length;
          start = Math.min(...logs.map(l => new Date(l.timestamp).getTime()));
        }
        userImgUsageCache.set(String(userId), { count, start, ts: now });
      } catch (e) {}
    }
  }

  const memLogs = (memoryStore.usageLogs || []).filter(l =>
    String(l.user_id) === String(userId) &&
    (l.model_id === 'image-generation') &&
    new Date(l.timestamp).getTime() >= windowStart
  );
  if (memLogs.length > count) {
    count = memLogs.length;
    start = memLogs.length > 0 ? Math.min(...memLogs.map(l => new Date(l.timestamp).getTime())) : now;
    userImgUsageCache.set(String(userId), { count, start, ts: now });
  }

  const remainingMs = Math.max(0, (start + windowMs) - now);
  return {
    count,
    resetInMinutes: Math.max(1, Math.ceil(remainingMs / 60000)),
    resetAt: new Date(start + windowMs).toISOString(),
    start
  };
}

async function incrementUserImageUsage(userId, windowHours) {
  const windowMs = (windowHours || 3) * 60 * 60 * 1000;
  const now = Date.now();
  const cached = userImgUsageCache.get(String(userId));
  let count = 1;
  let start = now;
  if (cached && (now - cached.start) < windowMs) {
    count = (cached.count || 0) + 1;
    start = cached.start;
  }
  userImgUsageCache.set(String(userId), { count, start, ts: now });
}

async function incrementUserUsage(userId, windowHours) {
  const windowMs = (windowHours || 3) * 60 * 60 * 1000;
  const now = Date.now();
  const cached = userUsageCache.get(String(userId));
  let count = 1;
  let start = now;
  if (cached && (now - cached.start) < windowMs) {
    count = (cached.count || 0) + 1;
    start = cached.start;
  }
  userUsageCache.set(String(userId), { count, start, ts: now });
}

let plansCache = null;
let plansCacheTs = 0;

function invalidatePlansCache() {
  plansCache = null;
  plansCacheTs = 0;
}

async function getPersistedPlans() {
  const now = Date.now();
  if (plansCache && (now - plansCacheTs) < 10000) {
    return plansCache;
  }

  const { ensureAllCanonicalPlans, DEFAULT_PLANS } = require('../server/utils/planDefaults');
  const { getIsMongoConnected } = require('../server/config/db');

  if (getIsMongoConnected()) {
    try {
      const Plan = require('../server/models/Plan');
      const docs = await Plan.find().lean();
      if (Array.isArray(docs) && docs.length > 0) {
        const normalized = ensureAllCanonicalPlans(docs);
        plansCache = normalized;
        plansCacheTs = now;
        memoryStore.plans = normalized;
        return normalized;
      }
    } catch (e) {
      console.warn('[MongoDB] getPersistedPlans warning:', e.message);
    }
  }

  const resPlans = ensureAllCanonicalPlans(
    memoryStore.plans && memoryStore.plans.length > 0 ? memoryStore.plans : DEFAULT_PLANS
  );
  memoryStore.plans = resPlans;
  plansCache = resPlans;
  plansCacheTs = now;
  return resPlans;
}

async function savePersistedPlans(plans) {
  plansCache = plans;
  plansCacheTs = Date.now();
  memoryStore.plans = plans;
  debouncedSave();

  const { getIsMongoConnected } = require('../server/config/db');
  if (getIsMongoConnected() && Array.isArray(plans)) {
    try {
      const Plan = require('../server/models/Plan');
      for (const p of plans) {
        if (!p || !p.name) continue;
        const { _id, __v, ...rest } = p;
        await Plan.findOneAndUpdate({ name: p.name }, { $set: rest }, { upsert: true });
      }
    } catch (e) {
      console.error('[MongoDB] Failed to persist plans:', e.message);
    }
  }
}

let redeemCodesCache = null;
let redeemCodesCacheTs = 0;

function invalidateRedeemCodesCache() {
  redeemCodesCache = null;
  redeemCodesCacheTs = 0;
}

async function getPersistedRedeemCodes() {
  const now = Date.now();
  if (redeemCodesCache && (now - redeemCodesCacheTs) < 5000) {
    return redeemCodesCache;
  }

  const { getIsMongoConnected } = require('../server/config/db');
  if (getIsMongoConnected()) {
    try {
      const RedeemCode = require('../server/models/RedeemCode');
      const docs = await RedeemCode.find().sort({ createdAt: -1 }).lean();
      if (Array.isArray(docs)) {
        memoryStore.redeemCodes = docs;
        redeemCodesCache = docs;
        redeemCodesCacheTs = now;
        return docs;
      }
    } catch (e) {}
  }

  return memoryStore.redeemCodes || [];
}

async function savePersistedRedeemCodes(codes) {
  const codeMap = new Map();
  for (const c of (codes || [])) {
    if (c && c.code) {
      codeMap.set(String(c.code).trim().toUpperCase(), c);
    }
  }
  const cleanCodes = Array.from(codeMap.values());
  memoryStore.redeemCodes = cleanCodes;
  redeemCodesCache = cleanCodes;
  redeemCodesCacheTs = Date.now();
  debouncedSave();
}

let promoCodesCache = null;
let promoCodesCacheTs = 0;

function invalidatePromoCodesCache() {
  promoCodesCache = null;
  promoCodesCacheTs = 0;
}

async function getPersistedPromoCodes() {
  const now = Date.now();
  if (promoCodesCache && (now - promoCodesCacheTs) < 5000) {
    return promoCodesCache;
  }

  const { getIsMongoConnected } = require('../server/config/db');
  if (getIsMongoConnected()) {
    try {
      const PromoCode = require('../server/models/PromoCode');
      const docs = await PromoCode.find().sort({ createdAt: -1 }).lean();
      if (Array.isArray(docs)) {
        memoryStore.promoCodes = docs;
        promoCodesCache = docs;
        promoCodesCacheTs = now;
        return docs;
      }
    } catch (e) {}
  }

  return memoryStore.promoCodes || [];
}

async function savePersistedPromoCodes(promos) {
  const map = new Map();
  for (const p of (promos || [])) {
    if (p && p.code) {
      map.set(String(p.code).trim().toUpperCase(), p);
    }
  }
  const clean = Array.from(map.values());
  memoryStore.promoCodes = clean;
  promoCodesCache = clean;
  promoCodesCacheTs = Date.now();
  debouncedSave();

  const { getIsMongoConnected } = require('../server/config/db');
  if (getIsMongoConnected()) {
    try {
      const PromoCode = require('../server/models/PromoCode');
      for (const p of clean) {
        const { _id, __v, ...rest } = p;
        await PromoCode.findOneAndUpdate({ code: String(p.code).trim().toUpperCase() }, { $set: rest }, { upsert: true });
      }
    } catch (e) {}
  }
}

let paymentOrdersCache = null;
let paymentOrdersCacheTs = 0;

function invalidatePaymentOrdersCache() {
  paymentOrdersCache = null;
  paymentOrdersCacheTs = 0;
}

async function getPersistedPaymentOrders() {
  const now = Date.now();
  if (paymentOrdersCache && (now - paymentOrdersCacheTs) < 3000) {
    return paymentOrdersCache;
  }

  const { getIsMongoConnected } = require('../server/config/db');
  if (getIsMongoConnected()) {
    try {
      const PaymentOrder = require('../server/models/PaymentOrder');
      const docs = await PaymentOrder.find().sort({ createdAt: -1 }).limit(1000).lean();
      if (Array.isArray(docs)) {
        memoryStore.paymentOrders = docs;
        paymentOrdersCache = docs;
        paymentOrdersCacheTs = now;
        return docs;
      }
    } catch (e) {}
  }

  return memoryStore.paymentOrders || [];
}

async function savePersistedPaymentOrders(orders) {
  const map = new Map();
  for (const o of (orders || [])) {
    if (o && o.order_id) map.set(String(o.order_id).trim(), o);
  }
  const clean = Array.from(map.values()).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).slice(0, 1000);
  memoryStore.paymentOrders = clean;
  paymentOrdersCache = clean;
  paymentOrdersCacheTs = Date.now();
  debouncedSave();

  const { getIsMongoConnected } = require('../server/config/db');
  if (getIsMongoConnected()) {
    try {
      const PaymentOrder = require('../server/models/PaymentOrder');
      for (const o of clean.slice(0, 50)) {
        const { _id, __v, ...rest } = o;
        await PaymentOrder.findOneAndUpdate({ order_id: o.order_id }, { $set: rest }, { upsert: true });
      }
    } catch (e) {}
  }
}

let usersCache = null;
let usersCacheTs = 0;

function invalidateUsersCache() {
  usersCache = null;
  usersCacheTs = 0;
}

async function getPersistedUsers() {
  const now = Date.now();
  if (usersCache && (now - usersCacheTs) < 3000) {
    return usersCache;
  }

  const { getIsMongoConnected } = require('../server/config/db');
  if (getIsMongoConnected()) {
    try {
      const User = require('../server/models/User');
      const docs = await User.find().lean();
      if (Array.isArray(docs)) {
        const existingByKey = new Map();
        for (const u of (memoryStore.users || [])) {
          if (!u) continue;
          if (u._id) existingByKey.set(String(u._id), u);
          if (u.email) existingByKey.set(String(u.email).toLowerCase().trim(), u);
        }
        const normalized = docs.map(u => {
          const emailKey = u.email ? String(u.email).toLowerCase().trim() : '';
          const prev = existingByKey.get(String(u._id)) || (emailKey ? existingByKey.get(emailKey) : null);
          return {
            ...u,
            _id: String(u._id),
            id: String(u._id),
            ...(prev && prev.password && !u.password ? { password: prev.password } : {})
          };
        });
        // Preserve any local fallback admin/seed entries not yet in Mongo
        const seenEmails = new Set(normalized.map(u => String(u.email || '').toLowerCase().trim()).filter(Boolean));
        const extraAdmins = (memoryStore.users || []).filter(u =>
          u && String(u._id || '').startsWith('user_admin_') && u.email && !seenEmails.has(String(u.email).toLowerCase().trim())
        );
        const merged = [...normalized, ...extraAdmins];
        memoryStore.users = merged;
        usersCache = merged;
        usersCacheTs = now;
        return merged;
      }
    } catch (e) {}
  }

  return memoryStore.users || [];
}

async function savePersistedUsers(users) {
  const userMap = new Map();
  for (const u of (users || [])) {
    if (u) {
      const key = u.email ? u.email.toLowerCase().trim() : String(u._id || u.id);
      userMap.set(key, u);
    }
  }
  const cleanUsers = Array.from(userMap.values());

  memoryStore.users = cleanUsers;
  usersCache = cleanUsers;
  usersCacheTs = Date.now();
  debouncedSave();
}

let settingsCache = null;
let settingsCacheTs = 0;

async function getSystemSettings() {
  const now = Date.now();
  if (settingsCache && (now - settingsCacheTs) < 10000) {
    return settingsCache;
  }

  const defaultSettings = {
    image_model: 'pollinations/flux',
    image_api_url: 'https://image.pollinations.ai/prompt',
    image_api_key: '',
    image_size: '1024x1024',
    image_enhance: true,
    web_search_provider: 'duckduckgo',
    web_search_api_key: '',
    web_search_custom_url: '',
    web_search_max_results: 4,
    usd_to_bdt_rate: 120,
    usd_to_usdt_rate: 1,
    payment_crypto_enabled: true,
    crypto_bsc_address: '',
    crypto_bsc_url: '',
    crypto_trc20_address: '',
    crypto_trc20_url: '',
    payment_binance_enabled: true,
    binance_pay_id: '',
    payment_bybit_enabled: true,
    bybit_pay_id: '',
    payment_bkash_enabled: true,
    bkash_number: '',
    bkash_account_type: 'Send Money'
  };

  const { getIsMongoConnected } = require('../server/config/db');
  if (getIsMongoConnected()) {
    try {
      const SystemSetting = require('../server/models/SystemSetting');
      const doc = await SystemSetting.findOne({ key: '__system_settings__' }).lean();
      if (doc && doc.value && typeof doc.value === 'object') {
        const merged = { ...defaultSettings, ...doc.value };
        settingsCache = merged;
        settingsCacheTs = now;
        if (!memoryStore.settings) memoryStore.settings = {};
        Object.assign(memoryStore.settings, merged);
        return merged;
      }
    } catch (e) {
      console.warn('[MongoDB] __system_settings__ fetch failed:', e.message);
    }
  }

  const def = { ...defaultSettings, ...(memoryStore.settings || {}) };
  settingsCache = def;
  settingsCacheTs = now;
  return def;
}

async function saveSystemSettings(settings) {
  const updated = { ...(memoryStore.settings || {}), ...settings };
  settingsCache = updated;
  settingsCacheTs = Date.now();
  memoryStore.settings = updated;
  debouncedSave();

  const { getIsMongoConnected } = require('../server/config/db');
  if (getIsMongoConnected()) {
    try {
      const SystemSetting = require('../server/models/SystemSetting');
      await SystemSetting.findOneAndUpdate(
        { key: '__system_settings__' },
        { $set: { value: updated } },
        { upsert: true }
      );
    } catch (e) {
      console.error('[MongoDB] Failed to persist system settings:', e.message);
    }
  }

  return updated;
}

async function autoPurgeOrphanedDatabaseCaches() {
  const { saveBackup } = require('../server/config/memoryStore');

  modelsCache = null;
  modelsCacheTs = 0;
  usersCache = null;
  usersCacheTs = 0;
  redeemCodesCache = null;
  redeemCodesCacheTs = 0;
  promoCodesCache = null;
  promoCodesCacheTs = 0;
  paymentOrdersCache = null;
  paymentOrdersCacheTs = 0;
  plansCache = null;
  plansCacheTs = 0;
  settingsCache = null;
  settingsCacheTs = 0;
  keyCache.clear();

  try {
    const currentModels = await getPersistedModels();
    const validModelIds = new Set(currentModels.map(m => String(m.id || m.model_id || '').toLowerCase().trim()));

    const plans = await getPersistedPlans();
    let plansChanged = false;
    plans.forEach(p => {
      if (Array.isArray(p.allowed_models)) {
        const origLen = p.allowed_models.length;
        p.allowed_models = p.allowed_models.filter(m => {
          if (m === '*') return true;
          return validModelIds.has(String(m || '').toLowerCase().trim());
        });
        if (p.allowed_models.length !== origLen) plansChanged = true;
      }
    });
    if (plansChanged) {
      await savePersistedPlans(plans);
    }
  } catch (e) {
    console.warn('[AutoPurge] Model reference cleanup warning:', e.message);
  }

  try {
    const { getIsMongoConnected } = require('../server/config/db');
    if (getIsMongoConnected()) {
      const SystemSetting = require('../server/models/SystemSetting');
      const currentModels = await getPersistedModels();
      const validModelIds = new Set(currentModels.map(m => String(m.id || m.model_id || '')));
      const keyDocs = await SystemSetting.find({ key: { $regex: /^__api_key__:/ } }).select('key').lean();
      for (const kd of (keyDocs || [])) {
        const rawId = kd.key.replace(/^__api_key__:/, '');
        if (rawId.startsWith('__')) continue;
        if (!validModelIds.has(rawId)) {
          await SystemSetting.deleteOne({ key: kd.key });
        }
      }
    }
  } catch (e) {
    console.warn('[AutoPurge] Orphaned API key cleanup warning:', e.message);
  }

  await saveBackup();
}

module.exports = {
  getModelConfig,
  MODEL_ALIASES,
  resolveModelAlias,
  getStoredApiKey,
  saveStoredApiKey,
  deleteStoredApiKey,
  getApiKeyFromSupabase,
  invalidateModelKeyCache,
  getPersistedModels,
  savePersistedModels,
  invalidateModelsCache,
  getPersistedPlans,
  savePersistedPlans,
  invalidatePlansCache,
  getUserUsage,
  getUserUsageDetails,
  incrementUserUsage,
  getUserImageUsageDetails,
  incrementUserImageUsage,
  invalidateUserUsageCache,
  getPersistedRedeemCodes,
  savePersistedRedeemCodes,
  invalidateRedeemCodesCache,
  getPersistedPromoCodes,
  savePersistedPromoCodes,
  invalidatePromoCodesCache,
  getPersistedPaymentOrders,
  savePersistedPaymentOrders,
  invalidatePaymentOrdersCache,
  getPersistedUsers,
  savePersistedUsers,
  invalidateUsersCache,
  getSystemSettings,
  saveSystemSettings,
  autoPurgeOrphanedDatabaseCaches,
  getDeletedModelIds,
  addDeletedModelId,
  removeDeletedModelId,
  invalidateDeletedModelsCache
};
