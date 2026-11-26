const path = require('path');
const express = require('express');
const cors = require('cors');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { connectDB, getIsMongoConnected, ensureDBConnected } = require('./config/db');
const { memoryStore } = require('./config/memoryStore');
const Plan = require('./models/Plan');
const AiModel = require('./models/AiModel');
const { createRateLimiter } = require('./middleware/ipRateLimiter');
const { compressionMiddleware } = require('./middleware/compress');
const { sendServerError } = require('./utils/safeError');
const { protect } = require('./middleware/authMiddleware');
const { adminOnly } = require('./middleware/adminMiddleware');

const authRoutes = require('./routes/authRoutes');
const chatRoutes = require('./routes/chatRoutes');
const redeemRoutes = require('./routes/redeemRoutes');
const adminRoutes = require('./routes/adminRoutes');
const searchRoutes = require('./routes/searchRoutes');
const paymentRoutes = require('./routes/paymentRoutes');

const app = express();

// Rate Limiters for High-Traffic and Brute Force Protection
const authLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: 'অতিরিক্ত লগইন/রেজিস্ট্রেশন অনুরোধ করা হয়েছে। অনুগ্রহ করে ১৫ মিনিট পর আবার চেষ্টা করুন।'
});
const redeemLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'অতিরিক্ত রিডিম কোড অনুরোধ। অনুগ্রহ করে কিছুক্ষণ অপেক্ষা করুন।'
});
const apiLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 120,
  message: 'অতিরিক্ত সার্ভার অনুরোধ। অনুগ্রহ করে কিছুক্ষণ পর আবার চেষ্টা করুন।'
});

// Middleware
app.disable('x-powered-by');
app.set('trust proxy', 1);
const ALLOWED_CORS_ORIGINS = new Set([
  'https://alora.zdots.net',
  'https://www.alora.zdots.net',
  'https://alora.zihan.xyz',
  'https://www.alora.zihan.xyz',
  'https://ai.zihan.xyz',
  'https://alora-backend-emw3.onrender.com',
  'http://localhost:5000',
  'http://localhost:3000',
  'http://127.0.0.1:5000',
  'capacitor://localhost',
  'http://localhost',
  'https://localhost'
]);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || origin === 'null' || ALLOWED_CORS_ORIGINS.has(origin.toLowerCase()) || /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin)) {
      return cb(null, true);
    }
    return cb(null, false);
  }
}));
app.use(compressionMiddleware);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  next();
});
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

const User = require('./models/User');

// Connect DB & Seed Plans/Models
connectDB().then(async () => {
  if (getIsMongoConnected()) {
    try {
      const { getPersistedPlans, getPersistedModels } = require('../utils/getModelConfig');
      const planCount = await Plan.countDocuments();
      if (planCount === 0) {
        const pPlans = await getPersistedPlans();
        if (pPlans && pPlans.length > 0) {
          for (const p of pPlans) {
            await Plan.findOneAndUpdate({ name: p.name }, p, { upsert: true });
          }
          console.log(`[Database Seed] Seeded ${pPlans.length} default plans in MongoDB.`);
        }
      }
      await Plan.seedDefaultPlans();

      const { getDeletedModelIds } = require('../utils/getModelConfig');
      const deletedSet = await getDeletedModelIds();
      const modelCount = await AiModel.countDocuments();
      if (modelCount === 0 && deletedSet.size === 0 && !memoryStore.settings?.modelsInitialized) {
        const pModels = await getPersistedModels();
        if (pModels && pModels.length > 0) {
          for (const m of pModels) {
            await AiModel.findOneAndUpdate(
              { model_id: m.id || m.model_id },
              {
                model_id: m.id || m.model_id,
                name: m.name,
                provider: m.provider || 'Alora',
                type: m.type || 'custom',
                base_url: m.base_url || '',
                api_key: m.api_key || '',
                premium: !!m.premium,
                efficient: !!m.efficient,
                order: m.order || 0,
                api_model_1: m.api_model_1 || m.model_id || m.id || '',
                fallback_url_1: m.fallback_url_1 || '',
                fallback_key_1: m.fallback_key_1 || '',
                fallback_model_1: m.fallback_model_1 || '',
                api_model_2: m.api_model_2 || '',
                fallback_url_2: m.fallback_url_2 || '',
                fallback_key_2: m.fallback_key_2 || '',
                fallback_model_2: m.fallback_model_2 || '',
                api_model_3: m.api_model_3 || ''
              },
              { upsert: true }
            );
          }
          console.log(`[Database Seed] Seeded ${pModels.length} default models in MongoDB.`);
        } else {
          await AiModel.seedDefaultModels();
        }
      }
    } catch (syncErr) {
      console.warn('[Database Seed Warning]:', syncErr.message);
    }

    const adminEmails = ['zihanfakir@gmail.com', 'x@zihan.uk'];
    for (const email of adminEmails) {
      const adminUser = await User.findOne({ email });
      if (adminUser && adminUser.role !== 'admin') {
        adminUser.role = 'admin';
        await adminUser.save();
        console.log(`[Auth] Promoted ${email} to Admin.`);
      }
    }
  }
}).catch(err => console.error('[DB Connection Error]:', err.message));

// API Routes with Rate Limiting & Anti-Cache Headers (fixes login/logout stale cache)
app.use('/api', async (req, res, next) => {
  try {
    await ensureDBConnected();
  } catch (dbErr) {
    console.warn('[Server DB Middleware Warning]:', dbErr.message);
  }
  next();
});
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
});
app.use('/api', apiLimiter);
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/redeem', (req, res, next) => (req.method === 'GET' ? next() : redeemLimiter(req, res, next)), redeemRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/zihan', adminRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/payments', paymentRoutes);

// Health check
const serverHealthHandler = (req, res) => {
  res.json({
    success: true,
    status: 'ok',
    server: 'Alora AI Backend Running',
    mongo: getIsMongoConnected(),
    timestamp: new Date().toISOString()
  });
};
app.get('/api/health', serverHealthHandler);
app.head('/api/health', (req, res) => res.status(200).end());
app.get('/health', serverHealthHandler);
app.head('/health', (req, res) => res.status(200).end());

// Diagnostic debug-models endpoint (admin only, secrets redacted)
app.get('/api/debug-models', protect, adminOnly, async (req, res) => {
  try {
    const { getPersistedModels, getDeletedModelIds } = require('../utils/getModelConfig');
    const isMongo = getIsMongoConnected();
    const deleted = Array.from(await getDeletedModelIds());
    const persisted = await getPersistedModels();
    let mongoList = [];
    if (isMongo) {
      const rawMongoList = await AiModel.find().lean().catch(e => ({ error: e.message }));
      mongoList = Array.isArray(rawMongoList)
        ? rawMongoList.map(({ api_key, fallback_key_1, fallback_key_2, ...rest }) => ({
            ...rest,
            has_api_key: Boolean(api_key && String(api_key).trim()),
            has_fallback_key_1: Boolean(fallback_key_1 && String(fallback_key_1).trim()),
            has_fallback_key_2: Boolean(fallback_key_2 && String(fallback_key_2).trim())
          }))
        : rawMongoList;
    }
    res.json({
      success: true,
      isMongo,
      deleted,
      persistedCount: Array.isArray(persisted) ? persisted.length : 0,
      mongoCount: Array.isArray(mongoList) ? mongoList.length : 0,
      mongoList
    });
  } catch(e) {
    return sendServerError(res, e, 'Internal server error', '[Debug Models Error]:');
  }
});

// Public plans and limits info
app.get('/api/plans', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    const { ensureAllCanonicalPlans } = require('./utils/planDefaults');
    const { getPersistedPlans } = require('../utils/getModelConfig');

    if (getIsMongoConnected()) {
      const Plan = require('./models/Plan');
      const mongoPlans = await Plan.find().lean();
      if (mongoPlans && mongoPlans.length > 0) {
        const all = ensureAllCanonicalPlans(mongoPlans);
        return res.json({ success: true, plans: all.filter(p => p.is_active !== false) });
      }
    }
    const plans = await getPersistedPlans();
    return res.json({ success: true, plans: ensureAllCanonicalPlans(plans).filter(p => p.is_active !== false) });
  } catch (e) {
    res.status(500).json({ success: false, error: 'প্ল্যানের তথ্য লোড করতে সমস্যা হয়েছে।' });
  }
});

const ROOT_DIR = path.join(__dirname, '..');
app.use('/avatars', express.static(path.join(ROOT_DIR, 'avatars'), { maxAge: '7d' }));
app.use('/logo', express.static(path.join(ROOT_DIR, 'logo'), { maxAge: '7d' }));
app.use('/.well-known', express.static(path.join(ROOT_DIR, '.well-known'), { dotfiles: 'allow', maxAge: '1h' }));
app.get('/.well-known/assetlinks.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  return res.sendFile(path.join(ROOT_DIR, '.well-known', 'assetlinks.json'));
});

function sendHtmlPage(res, fileName, extraHeaders = {}) {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  Object.entries(extraHeaders).forEach(([k, v]) => res.setHeader(k, v));
  return res.sendFile(path.join(ROOT_DIR, fileName));
}

// Serve logo images, app icons, favicons, and mobile packages safely
const STATIC_ASSETS = [
  'favicon.ico', 'favicon.svg', 'favicon.png', 'favicon-32x32.png', 'favicon-16x16.png',
  'apple-touch-icon.png', 'app_logo.png', 'app logo.png',
  'alokpath_icon_dark.png', 'alokpath_icon_light.png',
  'alokpath_logo.svg', 'alokpath_logo_dark.png', 'alokpath_logo_light.png',
  'logo_icon_white.png', 'logo_icon_black.png',
  'logo_wordmark_white.png', 'logo_wordmark_black.png',
  'app_logo_transparent.png', 'app_logo_transparent_black.png',
  'app_logo.svg', 'app_logo_transparent.svg',
  'Alora.apk', 'Alora.ipa', 'AloAI.apk', 'Alokpoth.ipa'
];

STATIC_ASSETS.forEach(file => {
  app.get('/' + file, (req, res) => {
    const filePath = path.join(ROOT_DIR, file);
    if (file.endsWith('.apk')) {
      res.setHeader('Content-Type', 'application/vnd.android.package-archive');
      res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
      res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
    } else if (file.endsWith('.ipa')) {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
      res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
    } else if (file.endsWith('.ico')) {
      res.setHeader('Content-Type', 'image/x-icon');
      res.setHeader('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400');
    } else if (file.endsWith('.svg')) {
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400');
    } else if (file.endsWith('.png')) {
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400');
    }
    res.sendFile(filePath);
  });
});

app.get('/', (req, res) => sendHtmlPage(res, 'index.html'));
app.get('/index.html', (req, res) => sendHtmlPage(res, 'index.html'));
app.get(['/admin', '/admin/*', '/admin.html', '/zihan.html'], (req, res) => res.redirect(302, '/'));
app.get(['/zihan', '/zihan/'], (req, res) => sendHtmlPage(res, 'zihan.html', {
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Referrer-Policy': 'no-referrer'
}));
app.get('/login.html', (req, res) => sendHtmlPage(res, 'login.html'));
app.get('/account.html', (req, res) => sendHtmlPage(res, 'account.html'));
app.get('/plans.html', (req, res) => sendHtmlPage(res, 'plans.html'));
app.get('/checkout.html', (req, res) => sendHtmlPage(res, 'checkout.html'));
app.get('/manifest.json', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(ROOT_DIR, 'manifest.json'));
});
app.get('/sw.js', (req, res) => {
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(ROOT_DIR, 'sw.js'));
});

// Dedicated settings and feature pages
app.get('/profile.html', (req, res) => sendHtmlPage(res, 'profile.html'));
app.get('/security.html', (req, res) => sendHtmlPage(res, 'security.html'));
app.get('/personalization.html', (req, res) => sendHtmlPage(res, 'personalization.html'));

// Legacy standalone settings pages were merged into the in-app Settings dialog.
const LEGACY_SETTINGS_REDIRECTS = {
  theme: 'general', language: 'general', sound: 'speech', usage: 'account', subscription: 'account'
};
Object.entries(LEGACY_SETTINGS_REDIRECTS).forEach(([page, tab]) => {
  app.get([`/${page}`, `/${page}.html`], (req, res) => res.redirect(302, `/#settings/${tab}`));
});
app.get('/help.html', (req, res) => sendHtmlPage(res, 'help.html'));
app.get('/redeem.html', (req, res) => sendHtmlPage(res, 'redeem.html'));
app.get('/download.html', (req, res) => sendHtmlPage(res, 'download.html'));
app.get('/download', (req, res) => sendHtmlPage(res, 'download.html'));
app.get('/app', (req, res) => sendHtmlPage(res, 'download.html'));

// ChatGPT Exact SPA & Auth/Pricing URL Routes
app.get(['/c/:chatId', '/c/*', '/g/:gptId', '/share/:shareId', '/settings', '/settings/*'], (req, res) => {
  sendHtmlPage(res, 'index.html');
});
app.get(['/auth/login', '/auth/signup', '/signup'], (req, res) => {
  sendHtmlPage(res, 'login.html');
});
app.get(['/pricing'], (req, res) => {
  sendHtmlPage(res, 'plans.html');
});

// Extensionless Clean Page Routes (with optional trailing slash handled by Express)
['plans', 'checkout', 'login', 'account', 'profile', 'security', 'personalization', 'help', 'redeem'].forEach(p => {
  app.get(`/${p}`, (req, res) => sendHtmlPage(res, `${p}.html`));
});

// Catch-all handler: unknown page/route redirects straight into Home Chat (/); API or static asset callers get 404 JSON
app.use((req, res) => {
  const isApiRequest = req.path === '/api' || req.path.startsWith('/api/');
  const isStaticAssetExt = /\.[a-z0-9]{1,8}$/i.test(req.path) && !req.path.endsWith('.html');
  if (!isApiRequest && !isStaticAssetExt && (req.method === 'GET' || req.method === 'HEAD')) {
    return res.redirect(302, '/');
  }
  res.status(404).json({ success: false, error: 'Route not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error('[Server Error]:', err);
  res.status(err.status || 500).json({ success: false, error: 'Internal server error' });
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Unhandled Rejection]:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Uncaught Exception]:', err);
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`=================================================`);
  console.log(`[Alora AI Server] Running on http://localhost:${PORT}`);
  console.log(`[Secret Admin Panel] Open http://localhost:${PORT}/zihan`);
  console.log(`=================================================`);
});
