const AiModel = require('../models/AiModel');
const UsageLog = require('../models/UsageLog');
const { getIsMongoConnected } = require('../config/db');
const { memoryStore, debouncedSave } = require('../config/memoryStore');
const {
  getSystemSettings,
  getModelConfig,
  getPersistedModels,
  getApiKeyFromSupabase,
  getUserUsageDetails,
  getUserVoiceUsageDetails,
  incrementUserVoiceUsage,
  invalidateUserUsageCache
} = require('../../utils/getModelConfig');
const { DEFAULT_PLANS_MAP } = require('../utils/planDefaults');
const { isPublicHttpUrl, canPlanAccessModel, decryptSecret, resolveChatCompletionUrl, getAlternateChatEndpointUrl } = require('../utils/secretVault');
const { redactSecrets } = require('../utils/safeError');
const {
  getSafeModelDisplayName,
  inspectPromptSafety,
  sanitizeModelIdentityText
} = require('../utils/safetyFilter');

function wrapPcm16ToWavBase64(pcmBuffer, sampleRate = 16000, numChannels = 1) {
  const byteRate = sampleRate * numChannels * 2;
  const blockAlign = numChannels * 2;
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcmBuffer]).toString('base64');
}

function stripVoiceEmojis(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let text = raw
    .replace(/[\u{1F1E6}-\u{1F1FF}]{2}/gu, ' ')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B00}-\u{2BFF}\uFE0E\uFE0F\u200D\u20E3]/gu, ' ');
  try {
    text = text.replace(/\p{Extended_Pictographic}/gu, ' ');
  } catch {}
  return text
    .replace(/(?:^|\s)[:;xX8=][-~']?[)DdpP(\/|\\*oO3<>]+(?=\s|$)/g, ' ')
    .replace(/<3+|:\)+|;\)+|:\(+/g, ' ')
    .replace(/\*(?:smiles?|smiling|laughs?|laughing|chuckles?|waves?|winks?|nods?|sighs?|cries?|happy|sad|wink|emoji)\*/gi, ' ')
    .replace(/\[(?:emoji|smile|laugh|grin|heart|thumbs\s*up|clap|fire|rocket|wave|wink|sparkles?)[^\]]*\]/gi, ' ');
}

function cleanSpokenText(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return stripVoiceEmojis(raw)
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_#`~>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildVoiceSystemInstruction(language, customPrompt = '') {
  const langRule = language === 'bn-BD'
    ? 'Respond in natural, warm conversational Bengali (বাংলা), mixing common English technical words only when natural.'
    : language === 'en-US'
      ? 'Respond in natural conversational English unless the user explicitly asks for Bengali or translation.'
      : 'Always support and respect BOTH Bengali (বাংলা) and English seamlessly. If the user speaks Bengali, Banglish, or mixed Bengali-English, reply in natural Bengali (বাংলা). If the user speaks English, reply in natural English. Never ignore Bengali input and never force English when the user speaks or requests Bengali.';
  const base = `You are Alora, a warm, intelligent bilingual voice assistant created by Alokpath. Speak aloud naturally through a Chat model in 1 to 4 concise conversational sentences. STRICT RULES: Never output any emojis, emoticons, symbols, or pictographs. Never mention, acknowledge, read aloud, or describe any emojis or sound tags. Use plain spoken words only (no markdown, bullets, asterisks, or brackets). Never mention third-party AI model or API names. ${langRule}`;
  return customPrompt && String(customPrompt).trim() ? `${base}\n${String(customPrompt).trim()}` : base;
}

function splitApiKeys(raw) {
  if (!raw || typeof raw !== 'string') return [];
  return raw
    .split(/[\n,;]+/)
    .map(k => k.trim())
    .filter(k => k && !k.startsWith('sk-placeholder'));
}

async function hasConfiguredVoiceStt() {
  try {
    if (process.env.GROQ_API_KEY && String(process.env.GROQ_API_KEY).trim()) return true;
    const settings = await getSystemSettings().catch(() => ({}));
    if (settings.voice_stt_url && isPublicHttpUrl(settings.voice_stt_url) && settings.voice_live_api_key) return true;
    for (const vk of splitApiKeys(settings && settings.voice_live_api_key)) {
      if (vk.startsWith('gsk_')) return true;
    }
    const allModels = (await getPersistedModels().catch(() => [])) || [];
    for (const m of allModels) {
      if (!m || m.is_active === false || m.category === 'voice') continue;
      const slots = [
        { url: m.base_url || '', type: m.type || '', key: m.api_key },
        { url: m.fallback_url_1 || m.base_url || '', type: '', key: m.fallback_key_1 },
        { url: m.fallback_url_2 || m.base_url || '', type: '', key: m.fallback_key_2 }
      ];
      for (const sl of slots) {
        const hint = `${sl.url} ${sl.type}`.toLowerCase();
        const keys = splitApiKeys(sl.key);
        if (!keys.length) continue;
        if (hint.includes('groq') || keys.some(k => k.startsWith('gsk_'))) return true;
      }
    }
  } catch {}
  return false;
}

async function transcribeAudioFallback({ audioBase64, mimeType, sttUrl, apiKey, language }) {
  if (!audioBase64) return { text: '', status: 'silence' };
  const audioBuf = Buffer.from(audioBase64, 'base64');
  const cleanMime = String(mimeType || 'audio/wav').split(';')[0].trim() || 'audio/wav';
  const ext = cleanMime.includes('webm') ? 'webm' : (cleanMime.includes('mp4') ? 'm4a' : (cleanMime.includes('ogg') ? 'ogg' : 'wav'));

  let hadWorkingProvider = false;
  let lastErrMsg = '';
  const settings = await getSystemSettings().catch(() => ({}));
  const allModels = (await getPersistedModels().catch(() => [])) || [];

  const sttCandidates = [];
  if (sttUrl && isPublicHttpUrl(sttUrl)) {
    const k = String(apiKey || settings.voice_live_api_key || '').trim();
    if (k) {
      sttCandidates.push({
        url: sttUrl.trim(),
        key: k,
        model: sttUrl.includes('groq.com') ? 'whisper-large-v3-turbo' : 'whisper-1'
      });
    }
  }
  for (const vk of splitApiKeys(settings && settings.voice_live_api_key)) {
    if (vk.startsWith('gsk_')) {
      sttCandidates.push({
        url: 'https://api.groq.com/openai/v1/audio/transcriptions',
        key: vk,
        model: 'whisper-large-v3-turbo'
      });
    }
  }
  for (const m of allModels) {
    if (!m || m.is_active === false || m.category === 'voice') continue;
    const modelSlots = [
      { key: m.api_key, url: m.base_url || '', type: m.type || '' },
      { key: m.fallback_key_1, url: m.fallback_url_1 || m.base_url || '', type: '' },
      { key: m.fallback_key_2, url: m.fallback_url_2 || m.base_url || '', type: '' }
    ];
    for (const sl of modelSlots) {
      const hint = `${sl.url} ${sl.type}`.toLowerCase();
      for (const k of splitApiKeys(sl.key)) {
        if (hint.includes('groq') || k.startsWith('gsk_')) {
          sttCandidates.push({
            url: 'https://api.groq.com/openai/v1/audio/transcriptions',
            key: k,
            model: 'whisper-large-v3-turbo'
          });
        }
      }
    }
  }
  const groqEnv = process.env.GROQ_API_KEY || (await getApiKeyFromSupabase('__groq_key__')) || '';
  for (const gk of splitApiKeys(groqEnv)) {
    sttCandidates.push({
      url: 'https://api.groq.com/openai/v1/audio/transcriptions',
      key: gk,
      model: 'whisper-large-v3-turbo'
    });
  }

  if (typeof FormData === 'function' && typeof Blob === 'function') {
    const seenStt = new Set();
    for (const cand of sttCandidates) {
      const ck = `${cand.url}|${cand.key}`;
      if (!cand.key || seenStt.has(ck)) continue;
      seenStt.add(ck);
      try {
        const form = new FormData();
        form.append('file', new Blob([audioBuf], { type: cleanMime }), `speech.${ext}`);
        form.append('model', cand.model);
        if (language === 'bn-BD') {
          form.append('language', 'bn');
          form.append('prompt', 'বাংলা ভাষায় কথোপকথন। ইংরেজি শব্দ প্রয়োজনে ইংরেজি বা বাংলায়। কোনো ইমোজি নয়।');
        } else if (language === 'en-US') {
          form.append('language', 'en');
          form.append('prompt', 'Natural English speech without emojis.');
        } else {
          form.append('prompt', 'বাংলা এবং ইংরেজি দ্বিভাষিক কথোপকথন। Bengali and English bilingual speech. No emojis.');
        }

        const sttRes = await fetch(cand.url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${cand.key}` },
          body: form,
          signal: AbortSignal.timeout(12000)
        });
        if (sttRes.ok) {
          hadWorkingProvider = true;
          const sttJson = await sttRes.json();
          const sttClean = cleanSpokenText(sttJson && typeof sttJson.text === 'string' ? sttJson.text : '');
          if (sttClean) {
            return { text: sttClean, status: 'ok' };
          }
        } else {
          lastErrMsg = `STT HTTP ${sttRes.status}`;
        }
      } catch (e) {
        lastErrMsg = e && e.message ? e.message : 'STT network error';
      }
    }
  }

  if (hadWorkingProvider) {
    return { text: '', status: 'silence' };
  }
  return {
    text: '',
    status: 'error',
    code: 'NO_STT_KEY',
    error: lastErrMsg || 'অডিও ট্রান্সক্রিপশন কী কনফিগার করা নেই।'
  };
}

async function runCustomVoiceApiTurn({ apiUrl, apiKey, modelName, audioBase64, mimeType, textPrompt, fallbackText, systemInstruction, sttUrl, language, history = [] }) {
  if (!apiUrl || !isPublicHttpUrl(apiUrl) || /generativelanguage\.googleapis\.com/i.test(apiUrl)) {
    throw new Error('সঠিক কাস্টম ভয়েস API URL কনফিগার করা হয়নি।');
  }
  let spokenText = cleanSpokenText(String(textPrompt || ''));
  if (!spokenText && audioBase64) {
    const sttOut = await transcribeAudioFallback({ audioBase64, mimeType, sttUrl, apiKey, language });
    spokenText = (sttOut && typeof sttOut === 'object') ? (sttOut.text || '') : String(sttOut || '');
    if (!spokenText && fallbackText) {
      spokenText = cleanSpokenText(fallbackText);
    }
    if (!spokenText && sttOut && sttOut.status === 'error') {
      const err = new Error(sttOut.error || 'অডিও ট্রান্সক্রাইব করা যায়নি।');
      if (sttOut.code) err.code = sttOut.code;
      throw err;
    }
  }
  if (!spokenText) {
    return { transcript: '', reply: '', audio_base64: null, audio_mime: null, empty_audio: true, provider: 'custom_api' };
  }

  const cleanVoiceKey = decryptSecret(apiKey || '');
  const headers = { 'Content-Type': 'application/json' };
  if (cleanVoiceKey) headers.Authorization = `Bearer ${cleanVoiceKey}`;

  let finalUrl = resolveChatCompletionUrl(apiUrl);

  const messages = [
    { role: 'system', content: systemInstruction },
    ...(Array.isArray(history) ? history.slice(-6) : [])
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map(m => ({ role: m.role, content: m.content.slice(0, 600) })),
    { role: 'user', content: spokenText }
  ];

  const reqBodyWithTemp = JSON.stringify({ model: modelName || 'gpt-4o-mini', messages, temperature: 0.65, stream: false });
  let resp = await fetch(finalUrl, {
    method: 'POST',
    headers,
    body: reqBodyWithTemp,
    signal: AbortSignal.timeout(18000)
  });

  if (resp.status === 404 || resp.status === 405) {
    const altUrl = getAlternateChatEndpointUrl(finalUrl);
    if (altUrl) {
      const rAlt = await fetch(altUrl, { method: 'POST', headers, body: reqBodyWithTemp, signal: AbortSignal.timeout(18000) });
      if (rAlt.status !== 404 && rAlt.status !== 405) {
        resp = rAlt;
        finalUrl = altUrl;
      }
    }
  }
  if (resp.status === 400 || resp.status === 422) {
    resp = await fetch(finalUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: modelName || 'gpt-4o-mini', messages, stream: false }),
      signal: AbortSignal.timeout(18000)
    });
  }

  if (!resp.ok) {
    throw new Error(`Custom Voice HTTP ${resp.status}`);
  }
  const data = await resp.json().catch(() => ({}));
  const replyText = data?.choices?.[0]?.message?.content || data?.reply || data?.text || '';
  return {
    transcript: spokenText,
    reply: cleanSpokenText(sanitizeModelIdentityText(String(replyText || ''), 'Alora')),
    audio_base64: data?.audio_base64 || null,
    audio_mime: data?.audio_base64 ? (data.audio_mime || 'audio/wav') : null,
    provider: 'custom_api'
  };
}

async function resolveTargetChatModel(targetModelId, planName, planObj) {
  let allModels = [];
  if (getIsMongoConnected()) {
    allModels = await AiModel.find({ is_active: { $ne: false } }).sort({ order: 1, createdAt: 1 }).lean().catch(() => []);
  }
  if (!allModels || allModels.length === 0) {
    allModels = (await getPersistedModels()) || [];
  }

  const { getDeletedModelIds } = require('../../utils/getModelConfig');
  const deletedSet = await getDeletedModelIds().catch(() => new Set());
  const chatCandidates = (allModels || []).filter(m => {
    if (!m || m.is_active === false || m.category === 'voice' || m.category === 'image') return false;
    const mId = String(m.model_id || m.id || '').toLowerCase().trim();
    const mName = String(m.name || '').toLowerCase().trim();
    if (deletedSet && (deletedSet.has(mId) || deletedSet.has(mName))) return false;
    if (/generativelanguage\.googleapis\.com/i.test(String(m.base_url || ''))) return false;
    return true;
  });

  const pickById = (idStr) => {
    const clean = String(idStr || '').trim();
    if (!clean) return null;
    const raw = chatCandidates.find(m => (m.id === clean || m.model_id === clean));
    if (!raw || !canPlanAccessModel(raw, planName, planObj)) return null;
    return raw;
  };

  let picked = pickById(targetModelId);
  if (!picked) {
    picked = chatCandidates.find(m => canPlanAccessModel(m, planName, planObj)) || null;
  }
  if (!picked) return null;
  return (await getModelConfig(picked.model_id || picked.id)) || picked;
}

async function runChatModelVoiceTurn({
  targetModelId,
  audioBase64,
  mimeType,
  textPrompt,
  fallbackText,
  systemInstruction,
  sttUrl,
  language,
  history = [],
  planName = 'Free',
  planObj = null
}) {
  let spokenText = cleanSpokenText(String(textPrompt || ''));
  if (audioBase64 && (!spokenText || language === 'auto')) {
    const sttOut = await transcribeAudioFallback({ audioBase64, mimeType, sttUrl, apiKey: '', language });
    const whisperText = (sttOut && typeof sttOut === 'object') ? cleanSpokenText(sttOut.text || '') : '';
    if (whisperText) {
      spokenText = whisperText;
    } else if (!spokenText && fallbackText) {
      spokenText = cleanSpokenText(fallbackText);
    } else if (!spokenText && sttOut && sttOut.status === 'error' && audioBase64.length > 2000) {
      const err = new Error('ভয়েস অডিও ট্রান্সক্রিপশন কী নেই অথবা সরাসরি স্পিচ রিকগনিশন ব্যবহার করুন।');
      err.code = sttOut.code || 'NO_STT_KEY';
      throw err;
    }
  }
  if (!spokenText) {
    return { transcript: '', reply: '', audio_base64: null, audio_mime: null, empty_audio: true, provider: 'chat_models' };
  }

  const safety = inspectPromptSafety(spokenText);
  if (safety.blocked) {
    const err = new Error(safety.message);
    err.statusCode = 400;
    err.code = 'SAFETY_BLOCKED';
    throw err;
  }

  const modelCfg = await resolveTargetChatModel(targetModelId, planName, planObj);
  const safeDisplayName = getSafeModelDisplayName((modelCfg && (modelCfg.name || modelCfg.model_id || modelCfg.id)) || 'Alora');

  const tiers = [];
  if (modelCfg) {
    tiers.push({
      url: modelCfg.base_url || '',
      key: modelCfg.api_key || '',
      mod: modelCfg.api_model_1 || modelCfg.model_id || modelCfg.id,
      type: modelCfg.type || ''
    });
    if (modelCfg.fallback_url_1 || modelCfg.api_model_2 || modelCfg.fallback_model_1) {
      tiers.push({
        url: modelCfg.fallback_url_1 || modelCfg.base_url || '',
        key: modelCfg.fallback_key_1 || modelCfg.api_key || '',
        mod: modelCfg.api_model_2 || modelCfg.fallback_model_1,
        type: ''
      });
    }
    if (modelCfg.fallback_url_2 || modelCfg.api_model_3 || modelCfg.fallback_model_2) {
      tiers.push({
        url: modelCfg.fallback_url_2 || modelCfg.base_url || '',
        key: modelCfg.fallback_key_2 || modelCfg.api_key || '',
        mod: modelCfg.api_model_3 || modelCfg.fallback_model_2,
        type: ''
      });
    }
  } else {
    tiers.push({
      url: 'https://openrouter.ai/api/v1/chat/completions',
      key: process.env.OPENROUTER_API_KEY || (await getApiKeyFromSupabase('__openrouter_key__')) || '',
      mod: targetModelId || 'openrouter/free',
      type: 'openrouter'
    });
  }

  const messages = [
    { role: 'system', content: systemInstruction },
    ...(Array.isArray(history) ? history.slice(-6) : [])
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map(m => ({ role: m.role, content: m.content.slice(0, 600) })),
    { role: 'user', content: spokenText }
  ];

  for (const tier of tiers) {
    if (!tier.mod) continue;
    if (/generativelanguage\.googleapis\.com/i.test(String(tier.url || '')) || tier.type === 'gemini') {
      continue;
    }
    try {
      let url = tier.url;
      let key = decryptSecret(tier.key || '');
      if (!url) {
        if (tier.type === 'groq' || tier.mod === 'openai/gpt-oss-120b' || tier.mod === 'openai/gpt-oss-20b') {
          url = 'https://api.groq.com/openai/v1/chat/completions';
          key = key || decryptSecret(process.env.GROQ_API_KEY || (await getApiKeyFromSupabase('__groq_key__')) || '');
        } else {
          url = 'https://openrouter.ai/api/v1/chat/completions';
          key = key || decryptSecret(process.env.OPENROUTER_API_KEY || (await getApiKeyFromSupabase('__openrouter_key__')) || '');
        }
      }
      if (!isPublicHttpUrl(url)) continue;
      url = resolveChatCompletionUrl(url, tier.type || '');
      const headers = { 'Content-Type': 'application/json' };
      if (key) headers.Authorization = `Bearer ${key}`;
      const bodyWithTemp = JSON.stringify({ model: tier.mod, messages, temperature: 0.65, stream: false });
      let r = await fetch(url, {
        method: 'POST',
        headers,
        body: bodyWithTemp,
        signal: AbortSignal.timeout(15000)
      });
      if (r.status === 404 || r.status === 405) {
        const altUrl = getAlternateChatEndpointUrl(url);
        if (altUrl) {
          const rAlt = await fetch(altUrl, { method: 'POST', headers, body: bodyWithTemp, signal: AbortSignal.timeout(15000) });
          if (rAlt.status !== 404 && rAlt.status !== 405) {
            r = rAlt;
            url = altUrl;
          }
        }
      }
      if (r.status === 400 || r.status === 422) {
        r = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model: tier.mod, messages, stream: false }),
          signal: AbortSignal.timeout(15000)
        });
      }
      if (r.ok) {
        const d = await r.json();
        const txt = d?.choices?.[0]?.message?.content || d?.output_text || d?.response || '';
        const sanitized = cleanSpokenText(sanitizeModelIdentityText(String(txt || ''), safeDisplayName));
        if (sanitized) {
          return {
            transcript: spokenText,
            reply: sanitized,
            audio_base64: null,
            audio_mime: null,
            model: safeDisplayName,
            provider: 'chat_models'
          };
        }
      }
    } catch {}
  }

  throw new Error('ভয়েস উত্তর তৈরি করতে চ্যাট মডেল বর্তমানে ব্যস্ত আছে।');
}

async function executeVoiceTurn(payload = {}, forcedSettings = null, planObj = null, planName = 'Free') {
  const settings = forcedSettings ? { ...(await getSystemSettings()), ...forcedSettings } : await getSystemSettings();
  const {
    audio_base64 = '',
    mime_type = 'audio/wav',
    text_prompt = '',
    fallback_text = '',
    language = 'auto',
    chat_model = '',
    voice_model = '',
    messages = []
  } = payload;

  const cleanAudio = typeof audio_base64 === 'string' ? audio_base64.replace(/^data:[^;]+;base64,/, '').trim() : '';
  const cleanText = typeof text_prompt === 'string' ? text_prompt.trim().slice(0, 4000) : '';
  const cleanFallback = typeof fallback_text === 'string' ? fallback_text.trim().slice(0, 4000) : '';

  if (!cleanAudio && !cleanText) {
    const err = new Error('কোনো ভয়েস অডিও বা টেক্সট পাওয়া যায়নি।');
    err.statusCode = 400;
    throw err;
  }
  if (cleanAudio && cleanAudio.length > 6 * 1024 * 1024) {
    const err = new Error('ভয়েস অডিও সাইজ অতিরিক্ত বড়। ছোট করে বলুন।');
    err.statusCode = 400;
    throw err;
  }
  if (cleanText) {
    const safety = inspectPromptSafety(cleanText);
    if (safety.blocked) {
      const err = new Error(safety.message);
      err.statusCode = 400;
      err.code = 'SAFETY_BLOCKED';
      throw err;
    }
  }

  const sysInstruction = buildVoiceSystemInstruction(language, settings.voice_system_prompt);
  const targetModelId = String(voice_model || chat_model || '').trim();

  if (settings.voice_provider === 'custom_api' && settings.voice_live_url && isPublicHttpUrl(settings.voice_live_url) && !/generativelanguage\.googleapis\.com/i.test(settings.voice_live_url)) {
    try {
      const customOut = await runCustomVoiceApiTurn({
        apiUrl: settings.voice_live_url,
        apiKey: settings.voice_live_api_key,
        modelName: settings.voice_live_model,
        audioBase64: cleanAudio,
        mimeType: mime_type,
        textPrompt: cleanText,
        fallbackText: cleanFallback,
        systemInstruction: sysInstruction,
        sttUrl: settings.voice_stt_url,
        language,
        history: messages
      });
      if (customOut) return { ...customOut, model: customOut.model || 'Alora Voice' };
    } catch (e) {
      if (forcedSettings) throw e;
    }
  }

  return await runChatModelVoiceTurn({
    targetModelId,
    audioBase64: cleanAudio,
    mimeType: mime_type,
    textPrompt: cleanText,
    fallbackText: cleanFallback,
    systemInstruction: sysInstruction,
    sttUrl: settings.voice_stt_url,
    language,
    history: messages,
    planName,
    planObj
  });
}

const handleLiveVoiceTurn = async (req, res) => {
  const userId = req.user ? String(req.user._id || req.user.id) : (req.guestId ? String(req.guestId) : null);
  try {
    const planObj = req.currentPlan || DEFAULT_PLANS_MAP.Free;
    const planName = req.user ? (planObj.name || 'Free') : 'Guest';

    const result = await executeVoiceTurn(req.body || {}, null, planObj, planName);

    if (result.empty_audio) {
      if (req.user && userId) {
        invalidateUserUsageCache(userId);
      }
      return res.json({
        success: true,
        empty_audio: true,
        transcript: '',
        reply: '',
        audio_base64: null
      });
    }

    if (result.transcript) {
      const safety = inspectPromptSafety(result.transcript);
      if (safety.blocked) {
        if (req.user && userId) invalidateUserUsageCache(userId);
        return res.status(400).json({ success: false, code: 'SAFETY_BLOCKED', error: safety.message });
      }
    }

    if (userId) {
      if (getIsMongoConnected()) {
        UsageLog.create({
          user_id: userId,
          model_id: 'voice-live',
          timestamp: new Date()
        }).catch(() => {});
      } else {
        memoryStore.usageLogs.push({
          _id: 'log_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          user_id: userId,
          model_id: 'voice-live',
          timestamp: new Date()
        });
        if (memoryStore.usageLogs.length > 5000) {
          memoryStore.usageLogs = memoryStore.usageLogs.slice(-5000);
        }
        debouncedSave();
      }
      if (!req._quotaCacheReserved) {
        await incrementUserVoiceUsage(userId, planObj.window_hours || 3).catch(() => {});
      }
    }

    let voiceUsage = null;
    if (req.user && userId && planObj.name !== 'Admin') {
      const [vDet, mDet] = await Promise.all([
        getUserVoiceUsageDetails(userId, planObj.window_hours || 3),
        getUserUsageDetails(userId, planObj.window_hours || 3)
      ]);
      voiceUsage = {
        voiceUsed: vDet.count,
        voiceLimit: Number(planObj.voice_limit ?? 0),
        voiceRemaining: Math.max(0, Number(planObj.voice_limit ?? 0) - vDet.count),
        used: mDet.count,
        limit: Number(planObj.message_limit || 50),
        remaining: Math.max(0, Number(planObj.message_limit || 50) - mDet.count)
      };
    }

    return res.json({
      success: true,
      transcript: result.transcript || '',
      reply: result.reply || '',
      audio_base64: result.audio_base64 || null,
      audio_mime: result.audio_mime || null,
      provider: result.provider || 'chat_models',
      model: result.model || 'Alora Voice',
      usage: voiceUsage
    });
  } catch (error) {
    if (req.user && userId) {
      invalidateUserUsageCache(userId);
    }
    const status = error.statusCode || 500;
    return res.status(status).json({
      success: false,
      code: error.code || 'VOICE_ERROR',
      error: redactSecrets(error.message || 'ভয়েস সংযোগে সমস্যা হয়েছে।')
    });
  }
};

module.exports = {
  executeVoiceTurn,
  handleLiveVoiceTurn,
  wrapPcm16ToWavBase64,
  cleanSpokenText,
  buildVoiceSystemInstruction,
  hasConfiguredVoiceStt
};
