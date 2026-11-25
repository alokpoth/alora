const DEFAULT_MEMORY_MODELS = [
  { id: "openrouter/free", model_id: "openrouter/free", name: "Alo Go", provider: "Alora", type: "openrouter", premium: false, efficient: false, order: 1, api_model_1: "openrouter/free" },
  { id: "gemini-3.5-flash-lite", model_id: "gemini-3.5-flash-lite", name: "Alo Flash", provider: "Alora", type: "gemini", premium: false, efficient: false, order: 2, api_model_1: "gemini-3.5-flash-lite" },
  { id: "hy3", model_id: "hy3", name: "Alo HY3", provider: "Alora", type: "bai", premium: false, efficient: false, order: 3, api_model_1: "hy3" },
  { id: "mimo-v2.5", model_id: "mimo-v2.5", name: "Alo Mimo", provider: "Alora", type: "bai", premium: false, efficient: false, order: 4, api_model_1: "mimo-v2.5" },
  { id: "openai/gpt-oss-120b", model_id: "openai/gpt-oss-120b", name: "Alo Pro", provider: "Alora", type: "groq", premium: true, efficient: false, order: 5, api_model_1: "openai/gpt-oss-120b" },
  { id: "nemotron-ultra-550b", model_id: "nemotron-ultra-550b", name: "Alo Ultra", provider: "Alora", type: "vyce", premium: true, efficient: false, order: 6, api_model_1: "nemotron-ultra-550b" },
  { id: "claude-sonnet-4-6", model_id: "claude-sonnet-4-6", name: "Alo Elite", provider: "Alora", type: "vyce", premium: true, efficient: false, order: 7, api_model_1: "claude-sonnet-4-6" },
  { id: "gpt-5.6", model_id: "gpt-5.6", name: "Alo Max", provider: "Alora", type: "vyce", premium: true, efficient: true, order: 8, api_model_1: "gpt-5.6" }
];
const bcrypt = require('bcryptjs');
const { DEFAULT_PLANS } = require('../utils/planDefaults');

// In-Memory Database Fallback Store for when MongoDB is not running locally
const memoryStore = {
  users: [],
  plans: DEFAULT_PLANS.map(p => ({ ...p })),
  redeemCodes: [],
  usageLogs: [],
  deletedModelIds: [],
  models: [...DEFAULT_MEMORY_MODELS],
  settings: {}
};

const fs = require('fs');
const path = require('path');

const BACKUP_DIR = (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) 
  ? require('os').tmpdir() 
  : path.join(__dirname, '../data');
const BACKUP_FILE = path.join(BACKUP_DIR, 'memory_backup.json');

// Ensure backup directory exists
if (!fs.existsSync(BACKUP_DIR)) {
  try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); } catch (e) {}
}

let isSaving = false;
const saveBackup = async () => {
  if (isSaving) {
    debouncedSave();
    return;
  }
  isSaving = true;
  try {
    if (memoryStore.usageLogs && memoryStore.usageLogs.length > 5000) {
      memoryStore.usageLogs = memoryStore.usageLogs.slice(-5000);
    }
    const backupData = {
      users: memoryStore.users || [],
      plans: memoryStore.plans || [],
      redeemCodes: memoryStore.redeemCodes || [],
      usageLogs: memoryStore.usageLogs || [],
      models: memoryStore.models || [],
      deletedModelIds: memoryStore.deletedModelIds || [],
      settings: memoryStore.settings || {}
      // chatSessions purposefully excluded
    };
    const tmpFile = BACKUP_FILE + '.tmp';
    await fs.promises.writeFile(tmpFile, JSON.stringify(backupData, null, 2), 'utf8');
    await fs.promises.rename(tmpFile, BACKUP_FILE);
  } catch (err) {
    if (err.code !== 'EROFS' && err.code !== 'ENOENT') {
      console.error('[MemoryStore Backup Error]:', err.message);
    }
  } finally {
    isSaving = false;
  }
};

let saveTimer = null;
const debouncedSave = () => {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveBackup().catch(() => {});
  }, 1000);
};

// Seed default zihanfakir@gmail.com admin if not present
const seedDefaultAdmin = async () => {
  // Load from backup if exists
  if (fs.existsSync(BACKUP_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
      if (Array.isArray(data.users)) memoryStore.users = data.users;
      if (Array.isArray(data.plans)) memoryStore.plans = data.plans;
      if (Array.isArray(data.redeemCodes)) memoryStore.redeemCodes = data.redeemCodes;
      if (Array.isArray(data.models)) {
        memoryStore.models = data.models.map(m => {
          const mod = { ...m };
          mod.api_model_1 = mod.api_model_1 || mod.model_id || mod.id || '';
          mod.fallback_url_1 = mod.fallback_url_1 || '';
          mod.fallback_key_1 = mod.fallback_key_1 || '';
          mod.fallback_model_1 = mod.fallback_model_1 || mod.api_model_2 || '';
          mod.api_model_2 = mod.api_model_2 || mod.fallback_model_1 || '';
          mod.fallback_url_2 = mod.fallback_url_2 || '';
          mod.fallback_key_2 = mod.fallback_key_2 || '';
          mod.fallback_model_2 = mod.fallback_model_2 || mod.api_model_3 || '';
          mod.api_model_3 = mod.api_model_3 || mod.fallback_model_2 || '';
          return mod;
        });
      }
      if (Array.isArray(data.deletedModelIds)) memoryStore.deletedModelIds = data.deletedModelIds;
      const deletedSet = new Set((memoryStore.deletedModelIds || []).map(x => String(x || '').toLowerCase().trim()));
      const hasExplicitModelsArray = Array.isArray(data.models);
      if (!hasExplicitModelsArray) {
        memoryStore.models = DEFAULT_MEMORY_MODELS.filter(m => !deletedSet.has(String(m.id).toLowerCase()) && !deletedSet.has(String(m.name).toLowerCase()));
      } else {
        memoryStore.models = memoryStore.models.filter(m => {
          const mId = String(m.id || m.model_id || '').toLowerCase().trim();
          const mName = String(m.name || '').toLowerCase().trim();
          return !deletedSet.has(mId) && !deletedSet.has(mName);
        });
      }
      if (data.settings && typeof data.settings === 'object') memoryStore.settings = data.settings;
      console.log('[Memory DB] Restored data from local backup file.');
    } catch (e) {
      console.error('[Memory DB] Backup file read error:', e.message);
    }
  }

  const adminEmails = ['zihanfakir@gmail.com', 'x@zihan.uk'];
  const configuredAdminPassword = String(process.env.ADMIN_PASSWORD || '').trim();
  for (const adminEmail of adminEmails) {
    let admin = memoryStore.users.find(u => u.email && u.email.toLowerCase().trim() === adminEmail);
    if (!admin) {
      // Never seed a password that is written in the source: it would be public.
      // Use the operator-supplied ADMIN_PASSWORD, otherwise a random unusable value that
      // can be replaced by logging in with ADMIN_PASSWORD once it is configured.
      const seedPassword = configuredAdminPassword || require('crypto').randomBytes(32).toString('hex');
      const hashedPassword = await bcrypt.hash(seedPassword, 10);
      admin = {
        _id: 'user_admin_' + adminEmail.split('@')[0],
        name: adminEmail === 'x@zihan.uk' ? 'Zihan' : 'Zihan Fakir',
        email: adminEmail,
        password: hashedPassword,
        role: 'admin',
        is_blocked: false,
        subscription: { plan_name: 'Max', starts_at: new Date(), expires_at: null, is_active: true },
        createdAt: new Date(),
        updatedAt: new Date()
      };
      memoryStore.users.push(admin);
      if (!configuredAdminPassword) {
        console.warn(`[Memory DB] Seeded admin ${adminEmail} with a random password. Set ADMIN_PASSWORD in the environment, then log in with it once to set a usable password.`);
      }
    } else {
      admin.role = 'admin';
      admin.subscription = { plan_name: 'Max', starts_at: new Date(), expires_at: null, is_active: true };
    }
  }
  saveBackup().catch(() => {});
};
seedDefaultAdmin().catch(err => {
  console.error('[Memory DB Seed Error]:', err.message);
});

// Flush backup on graceful shutdown
const flushOnExit = () => {
  try {
    const backupData = {
      users: memoryStore.users || [],
      plans: memoryStore.plans || [],
      redeemCodes: memoryStore.redeemCodes || [],
      usageLogs: (memoryStore.usageLogs || []).slice(-5000),
      models: memoryStore.models || [],
      deletedModelIds: memoryStore.deletedModelIds || [],
      settings: memoryStore.settings || {}
    };
    fs.writeFileSync(BACKUP_FILE, JSON.stringify(backupData, null, 2), 'utf8');
  } catch (e) {}
};
process.on('SIGINT', () => { flushOnExit(); });
process.on('SIGTERM', () => { flushOnExit(); });
process.on('beforeExit', () => { flushOnExit(); });

module.exports = { memoryStore, debouncedSave, saveBackup };
