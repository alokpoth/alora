const crypto = require('crypto');
const net = require('net');
const { JWT_SECRET } = require('../config/jwtSecret');

const ENC_PREFIX = 'enc:v1:';

function getVaultKey() {
  const rawSecret = String(process.env.MODEL_KEY_SECRET || JWT_SECRET || 'alora-default-vault-key');
  return crypto.createHash('sha256').update(rawSecret).digest();
}

function encryptSecret(plain) {
  if (typeof plain !== 'string') return '';
  const trimmed = plain.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith(ENC_PREFIX)) return trimmed;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getVaultKey(), iv);
  const encrypted = Buffer.concat([cipher.update(trimmed, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptSecret(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (!trimmed.startsWith(ENC_PREFIX)) return trimmed;

  try {
    const parts = trimmed.slice(ENC_PREFIX.length).split(':');
    if (parts.length !== 3) return '';
    const iv = Buffer.from(parts[0], 'hex');
    const tag = Buffer.from(parts[1], 'hex');
    const ciphertext = Buffer.from(parts[2], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', getVaultKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (e) {
    return '';
  }
}

function hasConfiguredSecret(value) {
  return Boolean(decryptSecret(value));
}

function isPrivateIpv4(ip) {
  const octets = ip.split('.').map(n => parseInt(n, 10));
  if (octets.length !== 4 || octets.some(n => isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = octets;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPublicHttpUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return false;
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  const host = (parsed.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return false;
  }
  const ipVer = net.isIP(host);
  if (ipVer === 4 && isPrivateIpv4(host)) return false;
  if (ipVer === 6) {
    const low = host.toLowerCase();
    if (low === '::1' || low === '::' || low.startsWith('fc') || low.startsWith('fd') || low.startsWith('fe80') || low.startsWith('::ffff:127.') || low.startsWith('::ffff:10.') || low.startsWith('::ffff:192.168.') || low.startsWith('::ffff:169.254.')) {
      return false;
    }
  }
  return true;
}

const PLAN_HIERARCHY_ACCESS = { Guest: 0, Free: 1, Go: 2, Plus: 3, Pro: 4, Max: 5 };
const ALL_CANONICAL_PLANS = ['Guest', 'Free', 'Go', 'Plus', 'Pro', 'Max'];

function deriveDefaultAllowedPlans(model) {
  if (!model) return [...ALL_CANONICAL_PLANS];
  if (Array.isArray(model.allowed_plans) && model.allowed_plans.length > 0) {
    if (model.allowed_plans.includes('*')) return [...ALL_CANONICAL_PLANS];
    return model.allowed_plans.filter(p => PLAN_HIERARCHY_ACCESS[p] !== undefined);
  }
  if (model.efficient) return ['Max'];
  if (model.premium) return ['Plus', 'Pro', 'Max'];
  return [...ALL_CANONICAL_PLANS];
}

function canPlanAccessModel(model, planName, planObj = null) {
  if (!model) return true;
  if (planName === 'Admin') return true;
  const cleanPlan = PLAN_HIERARCHY_ACCESS[planName] !== undefined ? planName : 'Free';
  const modelId = String(model.model_id || model.id || '').trim();
  const allowedList = Array.isArray(model.allowed_plans) ? model.allowed_plans.map(x => String(x || '').trim()).filter(Boolean) : [];

  if (allowedList.length > 0) {
    if (allowedList.includes('*')) return true;
    return allowedList.some(p => p.toLowerCase() === cleanPlan.toLowerCase());
  }

  // Fallback legacy tier resolution using plan.allowed_models + premium/efficient
  if (planObj && Array.isArray(planObj.allowed_models) && planObj.allowed_models.length > 0 && !planObj.allowed_models.includes('*')) {
    return Boolean(modelId && (planObj.allowed_models.includes(modelId) || (model.id && planObj.allowed_models.includes(model.id))));
  }

  if (model.efficient) return (PLAN_HIERARCHY_ACCESS[cleanPlan] || 0) >= PLAN_HIERARCHY_ACCESS.Max;
  if (model.premium) return (PLAN_HIERARCHY_ACCESS[cleanPlan] || 0) >= PLAN_HIERARCHY_ACCESS.Plus;
  return true;
}

module.exports = {
  encryptSecret,
  decryptSecret,
  hasConfiguredSecret,
  isPublicHttpUrl,
  deriveDefaultAllowedPlans,
  canPlanAccessModel
};
