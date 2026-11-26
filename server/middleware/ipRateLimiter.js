const createRateLimiter = ({
  windowMs = 15 * 60 * 1000,
  max = 20,
  message = 'অতিরিক্ত অনুরোধ করা হয়েছে, অনুগ্রহ করে কিছুক্ষণ পর আবার চেষ্টা করুন।'
} = {}) => {
  const localStore = new Map();

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, record] of localStore.entries()) {
      if (now > record.resetTime) {
        localStore.delete(key);
      }
    }
  }, Math.max(windowMs, 60 * 1000));
  if (cleanup.unref) cleanup.unref();

  return (req, res, next) => {
    if (!req) return next();
    const headers = req.headers || {};
    // Trust Express req.ip (configured via app.set('trust proxy', 1)) or Vercel platform header;
    // ignore unverified client-supplied forwarding headers (CF-Connecting-IP / X-Real-IP / leftmost XFF).
    const vercelIp = process.env.VERCEL ? headers['x-vercel-forwarded-for'] : '';
    const resolvedIp = req.ip || (vercelIp ? String(vercelIp).split(',')[0].trim() : '') || req.socket?.remoteAddress || '127.0.0.1';

    const rawIp = resolvedIp || '127.0.0.1';
    const cleanIp = String(rawIp).replace(/^::ffff:/, '').replace(/[^a-zA-Z0-9.:_-]/g, '_');
    const prefix = req.baseUrl || req.route?.path || req.path || 'rate';
    const key = `${prefix}:${cleanIp}`;
    const now = Date.now();

    // Prevent memory bloat under high connection volume
    if (localStore.size > 5000) {
      for (const [k, r] of localStore.entries()) {
        if (now > r.resetTime) localStore.delete(k);
      }
      if (localStore.size > 5000) localStore.clear();
    }

    let record = localStore.get(key);
    if (!record || now > record.resetTime) {
      record = { count: 1, resetTime: now + windowMs };
      localStore.set(key, record);
      if (res && typeof res.setHeader === 'function') {
        res.setHeader('X-RateLimit-Limit', max);
        res.setHeader('X-RateLimit-Remaining', max - 1);
      }
      return next();
    }

    record.count += 1;
    const remaining = Math.max(0, max - record.count);
    if (res && typeof res.setHeader === 'function') {
      res.setHeader('X-RateLimit-Limit', max);
      res.setHeader('X-RateLimit-Remaining', remaining);
    }

    if (record.count > max) {
      const retryAfterSec = Math.max(1, Math.ceil((record.resetTime - now) / 1000));
      if (res && typeof res.setHeader === 'function') {
        res.setHeader('Retry-After', retryAfterSec);
      }
      return res.status(429).json({ success: false, error: message, retry_after: retryAfterSec });
    }

    next();
  };
};

module.exports = { createRateLimiter };
