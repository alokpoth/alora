const PLAN_ORDER = ['Guest', 'Free', 'Go', 'Plus', 'Pro', 'Max'];
const USER_PLANS = ['Free', 'Go', 'Plus', 'Pro', 'Max'];
const PAID_PLANS = ['Go', 'Plus', 'Pro', 'Max'];
const PLAN_HIERARCHY = { Free: 1, Go: 2, Plus: 3, Pro: 4, Max: 5 };

const DEFAULT_PLANS_MAP = {
  Guest: {
    name: 'Guest',
    displayName: 'গেস্ট (Guest)',
    message_limit: 2,
    window_hours: 24,
    image_limit: 0,
    voice_limit: 2,
    voice_model: '',
    image_model: '',
    price_usd: 0,
    price_bdt: 0,
    tagline: 'Try Alora instantly without logging in',
    allowed_models: ['openrouter/free'],
    is_active: true
  },
  Free: {
    name: 'Free',
    displayName: 'ফ্রি প্ল্যান (Free)',
    message_limit: 50,
    window_hours: 3,
    image_limit: 0,
    voice_limit: 10,
    voice_model: '',
    image_model: '',
    price_usd: 0,
    price_bdt: 0,
    tagline: 'Intelligence for everyday tasks and quick answers',
    allowed_models: ['openrouter/free'],
    is_active: true
  },
  Go: {
    name: 'Go',
    displayName: 'গো প্ল্যান (Go)',
    message_limit: 100,
    window_hours: 3,
    image_limit: 0,
    voice_limit: 30,
    voice_model: '',
    image_model: '',
    price_usd: 5,
    price_bdt: 650,
    tagline: 'More room to write, learn, and create',
    allowed_models: ['openrouter/free'],
    is_active: true
  },
  Plus: {
    name: 'Plus',
    displayName: 'প্লাস প্ল্যান (Plus)',
    message_limit: 500,
    window_hours: 3,
    image_limit: 0,
    voice_limit: 100,
    voice_model: '',
    image_model: '',
    price_usd: 20,
    price_bdt: 2600,
    tagline: 'Personalized AI with advanced reasoning models',
    allowed_models: ['*'],
    is_active: true
  },
  Pro: {
    name: 'Pro',
    displayName: 'প্রো প্ল্যান (Pro)',
    message_limit: 3000,
    window_hours: 1,
    image_limit: 0,
    voice_limit: 300,
    voice_model: '',
    image_model: '',
    price_usd: 60,
    price_bdt: 7800,
    tagline: 'Higher speed and expanded limits for heavy work',
    allowed_models: ['*'],
    is_active: true
  },
  Max: {
    name: 'Max',
    displayName: 'ম্যাক্স প্ল্যান (Max)',
    message_limit: 7000,
    window_hours: 1,
    image_limit: 0,
    voice_limit: 1000,
    voice_model: '',
    image_model: '',
    price_usd: 120,
    price_bdt: 15600,
    tagline: 'Full frontier intelligence with our highest usage limits',
    allowed_models: ['*'],
    is_active: true
  }
};

const DEFAULT_PLANS = PLAN_ORDER.map(name => ({ ...DEFAULT_PLANS_MAP[name], allowed_models: [...DEFAULT_PLANS_MAP[name].allowed_models] }));

function normalizePlanDoc(rawPlan) {
  if (!rawPlan) return null;
  const plain = (typeof rawPlan.toObject === 'function') ? rawPlan.toObject() : { ...rawPlan };
  const name = PLAN_ORDER.includes(plain.name) ? plain.name : 'Free';
  const def = DEFAULT_PLANS_MAP[name] || DEFAULT_PLANS_MAP.Free;

  const rawMsg = Number(plain.message_limit);
  const validMsg = !isNaN(rawMsg) && (name === 'Guest' ? rawMsg >= 0 : rawMsg >= 1) ? rawMsg : def.message_limit;

  const rawWin = Number(plain.window_hours);
  const validWin = !isNaN(rawWin) && rawWin >= 1 ? rawWin : def.window_hours;

  const rawImg = Number(plain.image_limit);
  const validImg = (plain.image_limit !== undefined && plain.image_limit !== null && !isNaN(rawImg) && rawImg >= 0)
    ? rawImg
    : def.image_limit;

  const rawVoice = Number(plain.voice_limit);
  const validVoice = (plain.voice_limit !== undefined && plain.voice_limit !== null && !isNaN(rawVoice) && rawVoice >= 0)
    ? rawVoice
    : def.voice_limit;

  const rawPrice = Number(plain.price_bdt);
  const validPrice = (plain.price_bdt !== undefined && plain.price_bdt !== null && !isNaN(rawPrice) && rawPrice >= 0)
    ? rawPrice
    : def.price_bdt;

  const rawUsd = Number(plain.price_usd);
  const validPriceUsd = (plain.price_usd !== undefined && plain.price_usd !== null && !isNaN(rawUsd) && rawUsd >= 0)
    ? Math.round(rawUsd * 100) / 100
    : def.price_usd;

  return {
    ...plain,
    name,
    displayName: (typeof plain.displayName === 'string' && plain.displayName.trim()) ? plain.displayName.trim() : def.displayName,
    message_limit: validMsg,
    window_hours: validWin,
    image_limit: validImg,
    voice_limit: validVoice,
    voice_model: typeof plain.voice_model === 'string' ? plain.voice_model.trim() : (def.voice_model || ''),
    image_model: typeof plain.image_model === 'string' ? plain.image_model.trim() : (def.image_model || ''),
    price_usd: validPriceUsd,
    price_bdt: validPrice,
    tagline: (typeof plain.tagline === 'string' && plain.tagline.trim()) ? plain.tagline.trim() : def.tagline,
    allowed_models: (Array.isArray(plain.allowed_models) && plain.allowed_models.length > 0)
      ? plain.allowed_models
      : [...def.allowed_models],
    is_active: plain.is_active !== false
  };
}

function ensureAllCanonicalPlans(rawPlans = []) {
  const byName = new Map();
  (Array.isArray(rawPlans) ? rawPlans : []).forEach(p => {
    if (p && PLAN_ORDER.includes(p.name)) {
      byName.set(p.name, normalizePlanDoc(p));
    }
  });
  return PLAN_ORDER.map(name => {
    return byName.get(name) || normalizePlanDoc({ ...DEFAULT_PLANS_MAP[name] });
  });
}

module.exports = {
  PLAN_ORDER,
  USER_PLANS,
  PAID_PLANS,
  PLAN_HIERARCHY,
  DEFAULT_PLANS_MAP,
  DEFAULT_PLANS,
  normalizePlanDoc,
  ensureAllCanonicalPlans
};
