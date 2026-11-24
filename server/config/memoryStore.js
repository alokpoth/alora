const DEFAULT_MEMORY_MODELS = [
  {
    id: "openrouter/free",
    model_id: "openrouter/free",
    name: "Alora",
    provider: "Alora",
    type: "openrouter",
    base_url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent",
    api_key: process.env.GEMINI_API_KEY || "REDACTED_HISTORICAL_GOOGLE_KEY",
    premium: false,
    efficient: false,
    order: 1,
    api_model_1: "gemini-2.5-flash",
    fallback_url_1: "https://api.groq.com/openai/v1/chat/completions",
    fallback_key_1: process.env.GROQ_API_KEY || "REDACTED_HISTORICAL_GROQ_KEY",
    fallback_model_1: "llama-3.3-70b-versatile",
    api_model_2: "llama-3.3-70b-versatile",
    fallback_url_2: "https://openrouter.ai/api/v1/chat/completions",
    fallback_key_2: process.env.OPENROUTER_API_KEY || "REDACTED_HISTORICAL_OPENROUTER_KEY",
    fallback_model_2: "openrouter/free",
    api_model_3: "openrouter/free"
  },
  {
    id: "openai/gpt-oss-120b",
    model_id: "openai/gpt-oss-120b",
    name: "Alora Pro",
    provider: "Alora",
    type: "groq",
    base_url: "https://api.groq.com/openai/v1/chat/completions",
    api_key: process.env.GROQ_API_KEY || "REDACTED_HISTORICAL_GROQ_KEY",
    premium: true,
    efficient: false,
    order: 2,
    api_model_1: "openai/gpt-oss-120b",
    fallback_url_1: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent",
    fallback_key_1: process.env.GEMINI_API_KEY || "REDACTED_HISTORICAL_GOOGLE_KEY",
    fallback_model_1: "gemini-2.5-flash",
    api_model_2: "gemini-2.5-flash",
    fallback_url_2: "https://openrouter.ai/api/v1/chat/completions",
    fallback_key_2: process.env.OPENROUTER_API_KEY || "REDACTED_HISTORICAL_OPENROUTER_KEY",
    fallback_model_2: "openrouter/free",
    api_model_3: "openrouter/free"
  },
  {
    id: "gpt-5.6",
    model_id: "gpt-5.6",
    name: "Alora Max",
    provider: "Alora",
    type: "vyce",
    base_url: "https://vyceai.com/v1/chat/completions",
    api_key: process.env.VYCE_API_KEY || "REDACTED_HISTORICAL_OPENAI_KEY",
    premium: true,
    efficient: true,
    order: 3,
    api_model_1: "gpt-5.6",
    fallback_url_1: "https://api.groq.com/openai/v1/chat/completions",
    fallback_key_1: process.env.GROQ_API_KEY || "REDACTED_HISTORICAL_GROQ_KEY",
    fallback_model_1: "openai/gpt-oss-120b",
    api_model_2: "openai/gpt-oss-120b",
    fallback_url_2: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent",
    fallback_key_2: process.env.GEMINI_API_KEY || "REDACTED_HISTORICAL_GOOGLE_KEY",
    fallback_model_2: "gemini-2.5-flash",
    api_model_3: "gemini-2.5-flash"
  }
];
const bcrypt = require('bcryptjs');

// In-Memory Database Fallback Store for when MongoDB is not running locally
const memoryStore = {
  users: [],
  plans: [
    { name: 'Free', displayName: 'ফ্রি প্ল্যান', message_limit: 10, window_hours: 3, allowed_models: ['gemini-3.6-flash', 'llama-3.3-70b-versatile', 'qwen/qwen3.8-27b', 'gemini-3.5-flash-lite', 'openrouter/free', 'mimo-v2.5', 'hy3'], is_active: true },
    { name: 'Pro', displayName: 'প্রো প্ল্যান', message_limit: 30, window_hours: 3, allowed_models: ['*'], is_active: true },
    { name: 'Max', displayName: 'ম্যাক্স প্ল্যান', message_limit: 50, window_hours: 1, allowed_models: ['*'], is_active: true }
  ],
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
      if (!Array.isArray(memoryStore.models) || memoryStore.models.length === 0) {
        memoryStore.models = [...DEFAULT_MEMORY_MODELS];
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
