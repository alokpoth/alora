const http = require('http');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const UsageLog = require('../models/UsageLog');
const Plan = require('../models/Plan');
const AiModel = require('../models/AiModel');
const User = require('../models/User');
const { getIsMongoConnected } = require('../config/db');
const { memoryStore, debouncedSave } = require('../config/memoryStore');
const { JWT_SECRET } = require('../config/jwtSecret');
const {
  getSystemSettings,
  getModelConfig,
  getPersistedModels,
  getPersistedPlans,
  getApiKeyFromSupabase,
  getUserUsageDetails,
  getUserVoiceUsageDetails,
  incrementUserVoiceUsage,
  invalidateUserUsageCache,
  withUserQuotaLock
} = require('../../utils/getModelConfig');
const { DEFAULT_PLANS_MAP, normalizePlanDoc } = require('../utils/planDefaults');
const { isPublicHttpUrl, canPlanAccessModel } = require('../utils/secretVault');
const { redactSecrets } = require('../utils/safeError');
const { inspectPromptSafety } = require('../utils/safetyFilter');

const GEMINI_VOICE_MAP = {
  auto: 'Aoede',
  nova: 'Aoede',
  cove: 'Charon',
  breeze: 'Puck',
  ember: 'Fenrir',
  juniper: 'Kore'
};

const OPENAI_VOICE_MAP = {
  auto: 'nova',
  nova: 'nova',
  cove: 'onyx',
  breeze: 'shimmer',
  ember: 'echo',
  juniper: 'coral'
};

function wrapPcm16ToWavBase64(pcmBuffer, sampleRate = 24000, numChannels = 1) {
  const byteRate = sampleRate * numChannels * 2;
  const blockAlign = numChannels * 2;
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20);  // Audio format 1 = PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34); // 16 bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcmBuffer]).toString('base64');
}

function stripWavHeaderIfPresent(audioBuf) {
  if (!Buffer.isBuffer(audioBuf) || audioBuf.length <= 44) return null;
  if (audioBuf.slice(0, 4).toString('ascii') === 'RIFF' && audioBuf.slice(8, 12).toString('ascii') === 'WAVE') {
    const sampleRate = audioBuf.readUInt32LE(24) || 16000;
    let offset = 12;
    while (offset + 8 <= audioBuf.length) {
      const chunkId = audioBuf.slice(offset, offset + 4).toString('ascii');
      const chunkSize = audioBuf.readUInt32LE(offset + 4);
      if (chunkId === 'data') {
        return { pcm: audioBuf.slice(offset + 8, Math.min(audioBuf.length, offset + 8 + chunkSize)), sampleRate };
      }
      offset += 8 + chunkSize;
    }
    return { pcm: audioBuf.slice(44), sampleRate };
  }
  return null;
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
      : 'Automatically detect the user\'s spoken language (prioritizing Bengali বাংলা and English, including mixed Bengali-English). Reply in Bengali (বাংলা) whenever the user speaks Bengali or Banglish/mixed Bengali, and reply in English whenever the user speaks English. Translate smoothly whenever requested.';
  const base = `You are Alora, a warm, intelligent, real-time bilingual voice assistant created by Alokpath. Keep spoken answers concise (1 to 4 natural sentences) and conversational. STRICT RULES: Never output any emojis, emoticons, symbols, or pictographs. Never mention, acknowledge, read aloud, or describe any emojis, facial icons, or sound tags. Write clean plain words only (no markdown, bullets, asterisks, or brackets). ${langRule}`;
  return customPrompt && String(customPrompt).trim() ? `${base}\n${String(customPrompt).trim()}` : base;
}

const geminiKeyCursorMap = new Map();
const geminiLiveModelsCache = new Map(); // keyHash -> { ts, models }
const GEMINI_DISCOVERY_TTL_MS = 10 * 60 * 1000;

const GOOGLE_AI_STUDIO_LIVE_ALIASES = {
  'gemini 3.8 live': ['gemini-3.8-live', 'gemini-3.8-flash-live', 'gemini-3-flash-live', 'gemini-2.5-flash-native-audio-preview-12-2025'],
  'gemini 3.8 live extended thinking': ['gemini-3.8-live-extended-thinking', 'gemini-3.8-live-thinking', 'gemini-3.8-live', 'gemini-2.5-flash-native-audio-preview-12-2025'],
  'gemini 3.5 transcribe live': ['gemini-3.5-transcribe-live', 'gemini-2.5-flash-native-audio-preview-12-2025'],
  'gemini 3.5 live translate': ['gemini-3.5-live-translate', 'gemini-2.5-flash-native-audio-preview-12-2025'],
  'gemini 3 flash live': ['gemini-3-flash-live', 'gemini-3.0-flash-live', 'gemini-3.1-flash-live-preview', 'gemini-2.5-flash-native-audio-preview-12-2025'],
  'gemini 2.5 flash native audio dialog': ['gemini-2.5-flash-native-audio-dialog', 'gemini-2.5-flash-preview-native-audio-dialog', 'gemini-2.5-flash-native-audio-preview-12-2025'],
  'lyria realtime': ['lyria-realtime-exp', 'lyria-realtime']
};

function splitApiKeys(raw) {
  if (!raw || typeof raw !== 'string') return [];
  return raw
    .split(/[\n,;]+/)
    .map(k => k.trim())
    .filter(k => k && !k.startsWith('sk-placeholder'));
}

function pickRotatedKeys(keysList, bucket = 'default') {
  if (!Array.isArray(keysList) || keysList.length === 0) return [];
  if (keysList.length === 1) return keysList;
  const idx = (geminiKeyCursorMap.get(bucket) || 0) % keysList.length;
  geminiKeyCursorMap.set(bucket, (idx + 1) % keysList.length);
  return [...keysList.slice(idx), ...keysList.slice(0, idx)];
}

async function resolveGeminiVoiceKeyList(settings, modelCfg, explicitKey = '') {
  const isGemHint = (str) => /gemini|googleapis/i.test(String(str || ''));
  const collectGemKeysFromModel = (m) => {
    if (!m || m.is_active === false) return [];
    const out = [];
    const slots = [
      { key: m.api_key, hint: `${m.type || ''} ${m.model_id || ''} ${m.id || ''} ${m.api_model_1 || ''} ${m.base_url || ''}` },
      { key: m.fallback_key_1, hint: `${m.fallback_model_1 || ''} ${m.api_model_2 || ''} ${m.fallback_url_1 || ''} ${m.base_url || ''}` },
      { key: m.fallback_key_2, hint: `${m.fallback_model_2 || ''} ${m.api_model_3 || ''} ${m.fallback_url_2 || ''} ${m.base_url || ''}` }
    ];
    for (const s of slots) {
      for (const k of splitApiKeys(s.key)) {
        if (k.startsWith('AIza') || isGemHint(s.hint)) out.push(k);
      }
    }
    return out;
  };

  const collected = [
    ...splitApiKeys(explicitKey),
    ...collectGemKeysFromModel(modelCfg),
    ...splitApiKeys(settings && settings.voice_live_api_key).filter(k => k.startsWith('AIza') || !settings?.voice_provider || settings.voice_provider === 'gemini_live')
  ];

  // Always check stored vault / Admin Panel models so Render env vars are completely optional
  const stored = await getApiKeyFromSupabase('__gemini_key__');
  collected.push(...splitApiKeys(stored));

  const models = await getPersistedModels();
  (models || []).forEach(m => {
    collected.push(...collectGemKeysFromModel(m));
  });

  // Env vars are optional fallback only
  collected.push(...splitApiKeys(process.env.GEMINI_API_KEYS));
  collected.push(...splitApiKeys(process.env.GEMINI_API_KEY));

  const unique = Array.from(new Set(collected));
  return pickRotatedKeys(unique, (modelCfg && (modelCfg.model_id || modelCfg.id)) || 'global_gemini_voice');
}

async function resolveGeminiVoiceKey(settings, modelCfg) {
  const list = await resolveGeminiVoiceKeyList(settings, modelCfg);
  return list[0] || '';
}

async function discoverGeminiLiveModels(apiKey, forceRefresh = false) {
  const keys = splitApiKeys(apiKey);
  const key = keys[0] || '';
  if (!key) return [];
  const keyHash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
  const now = Date.now();
  const cached = geminiLiveModelsCache.get(keyHash);
  if (!forceRefresh && cached && (now - cached.ts) < GEMINI_DISCOVERY_TTL_MS) {
    return cached.models;
  }
  try {
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=100&key=${encodeURIComponent(key)}`, {
      method: 'GET',
      signal: AbortSignal.timeout(8000)
    });
    if (!resp.ok) return cached ? cached.models : [];
    const data = await resp.json();
    const rawModels = Array.isArray(data && data.models) ? data.models : [];
    const liveModels = rawModels
      .filter(m => {
        if (!m || !m.name) return false;
        const methods = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
        const combined = `${m.name} ${m.displayName || ''}`.toLowerCase();
        return methods.includes('bidiGenerateContent') || /\blive\b|native-audio|realtime/i.test(combined);
      })
      .map(m => {
        const cleanId = String(m.name).replace(/^models\//, '');
        return {
          model_id: cleanId,
          display_name: String(m.displayName || cleanId).trim(),
          description: String(m.description || '').trim().slice(0, 200),
          methods: Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : []
        };
      });
    geminiLiveModelsCache.set(keyHash, { ts: now, models: liveModels });
    return liveModels;
  } catch {
    return cached ? cached.models : [];
  }
}

async function resolveGeminiLiveModelCandidates(rawModelInput, apiKey) {
  const raw = String(rawModelInput || '').replace(/^models\//i, '').trim();
  const normLower = raw.toLowerCase().replace(/\s+/g, ' ');
  const slug = normLower.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  const candidates = [];
  const addCand = (id) => {
    const clean = String(id || '').replace(/^models\//i, '').trim();
    if (clean && !/\s/.test(clean) && !candidates.includes(clean)) {
      candidates.push(clean);
    }
  };

  const discovered = await discoverGeminiLiveModels(apiKey);
  if (discovered.length > 0 && raw) {
    const exactMatch = discovered.find(d =>
      d.model_id.toLowerCase() === normLower ||
      d.display_name.toLowerCase() === normLower ||
      d.display_name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-') === slug
    );
    if (exactMatch) addCand(exactMatch.model_id);
    const fuzzyMatch = discovered.find(d =>
      d.display_name.toLowerCase().includes(normLower) ||
      normLower.includes(d.display_name.toLowerCase()) ||
      (slug && d.model_id.toLowerCase().includes(slug))
    );
    if (fuzzyMatch) addCand(fuzzyMatch.model_id);
  }

  if (raw && !/\s/.test(raw)) addCand(raw);
  if (GOOGLE_AI_STUDIO_LIVE_ALIASES[normLower]) {
    GOOGLE_AI_STUDIO_LIVE_ALIASES[normLower].forEach(addCand);
  }
  if (slug) addCand(slug);

  discovered
    .filter(d => Array.isArray(d.methods) && d.methods.includes('bidiGenerateContent'))
    .forEach(d => addCand(d.model_id));

  addCand('gemini-2.5-flash-native-audio-preview-12-2025');
  addCand('gemini-2.5-flash-native-audio-preview-09-2025');
  addCand('gemini-live-2.5-flash-preview');
  addCand('gemini-2.0-flash-live-001');
  return candidates;
}

async function runGeminiLiveWebSocketTurn({ apiKey, modelName, audioBase64, mimeType, textPrompt, voicePreset, systemInstruction, history = [] }) {
  if (typeof WebSocket !== 'function') {
    throw new Error('WebSocket client unavailable');
  }
  const cleanMod = String(modelName || 'gemini-2.5-flash-native-audio-preview-12-2025').replace(/^models\//, '');
  const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(apiKey)}`;
  const voiceName = GEMINI_VOICE_MAP[voicePreset] || 'Aoede';

  return await new Promise((resolve, reject) => {
    let settled = false;
    const pcmChunks = [];
    let outputTranscript = '';
    let inputTranscript = '';
    let modelText = '';

    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (err) reject(err);
      else resolve(val);
    };

    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      finish(new Error('Gemini Live WebSocket timeout'));
    }, 18000);

    ws.addEventListener('open', () => {
      const setupFrame = {
        setup: {
          model: `models/${cleanMod}`,
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName }
              }
            }
          },
          systemInstruction: {
            parts: [{ text: systemInstruction }]
          },
          outputAudioTranscription: {},
          inputAudioTranscription: {}
        }
      };
      ws.send(JSON.stringify(setupFrame));
    });

    ws.addEventListener('message', async (evt) => {
      try {
        let rawStr = '';
        if (typeof evt.data === 'string') {
          rawStr = evt.data;
        } else if (evt.data instanceof ArrayBuffer) {
          rawStr = Buffer.from(evt.data).toString('utf8');
        } else if (Buffer.isBuffer(evt.data)) {
          rawStr = evt.data.toString('utf8');
        } else if (evt.data && typeof evt.data.text === 'function') {
          rawStr = await evt.data.text();
        }
        if (!rawStr) return;
        const msg = JSON.parse(rawStr);

        if (msg.error) {
          return finish(new Error(msg.error.message || 'Gemini Live error'));
        }

        if (msg.setupComplete !== undefined) {
          // Send prior turns if any + current user audio/text
          const priorTurns = (Array.isArray(history) ? history.slice(-6) : [])
            .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
            .map(m => ({
              role: m.role === 'assistant' ? 'model' : 'user',
              parts: [{ text: m.content.slice(0, 600) }]
            }));

          if (audioBase64) {
            const audioBuf = Buffer.from(audioBase64, 'base64');
            const wavInfo = stripWavHeaderIfPresent(audioBuf);
            if (wavInfo && wavInfo.pcm.length > 0) {
              if (priorTurns.length > 0) {
                ws.send(JSON.stringify({ clientContent: { turns: priorTurns, turnComplete: false } }));
              }
              const sRate = wavInfo.sampleRate || 16000;
              const trailingSilence = Buffer.alloc(Math.round(sRate * 0.35) * 2, 0);
              const paddedPcm = Buffer.concat([wavInfo.pcm, trailingSilence]);
              ws.send(JSON.stringify({
                realtimeInput: {
                  mediaChunks: [{
                    mimeType: `audio/pcm;rate=${sRate}`,
                    data: paddedPcm.toString('base64')
                  }]
                }
              }));
              ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
              ws.send(JSON.stringify({ clientContent: { turnComplete: true } }));
              return;
            }
          }

          const currentParts = [];
          if (audioBase64) {
            const cleanWsMime = String(mimeType || 'audio/webm').split(';')[0].trim() || 'audio/webm';
            currentParts.push({ inlineData: { mimeType: cleanWsMime, data: audioBase64 } });
          }
          if (textPrompt) {
            currentParts.push({ text: textPrompt });
          } else if (audioBase64) {
            currentParts.push({ text: 'Listen to the Bengali or English speech and reply directly in plain spoken words without any emojis.' });
          }
          ws.send(JSON.stringify({
            clientContent: {
              turns: [...priorTurns, { role: 'user', parts: currentParts }],
              turnComplete: true
            }
          }));
          return;
        }

        const sc = msg.serverContent;
        if (sc) {
          if (sc.inputTranscription && typeof sc.inputTranscription.text === 'string') {
            inputTranscript += sc.inputTranscription.text;
          }
          if (sc.outputTranscription && typeof sc.outputTranscription.text === 'string') {
            outputTranscript += sc.outputTranscription.text;
          }
          if (sc.modelTurn && Array.isArray(sc.modelTurn.parts)) {
            for (const part of sc.modelTurn.parts) {
              if (part.text) modelText += part.text;
              if (part.inlineData && part.inlineData.data) {
                pcmChunks.push(Buffer.from(part.inlineData.data, 'base64'));
              }
            }
          }
          if (sc.turnComplete) {
            const wavB64 = pcmChunks.length > 0 ? wrapPcm16ToWavBase64(Buffer.concat(pcmChunks), 24000, 1) : '';
            const finalReply = cleanSpokenText(outputTranscript || modelText);
            const cleanIn = cleanSpokenText(inputTranscript) || cleanSpokenText(textPrompt || '');
            return finish(null, {
              transcript: cleanIn,
              reply: finalReply || (wavB64 ? ' ' : ''),
              audio_base64: wavB64 || null,
              audio_mime: wavB64 ? 'audio/wav' : null,
              provider: 'gemini_live'
            });
          }
        }
      } catch (parseErr) {
        finish(parseErr);
      }
    });

    ws.addEventListener('error', () => {
      finish(new Error('Gemini Live WebSocket connection failed'));
    });

    ws.addEventListener('close', (ev) => {
      if (!settled) {
        if (pcmChunks.length > 0 || outputTranscript || modelText) {
          const wavB64 = pcmChunks.length > 0 ? wrapPcm16ToWavBase64(Buffer.concat(pcmChunks), 24000, 1) : '';
          finish(null, {
            transcript: cleanSpokenText(inputTranscript) || cleanSpokenText(textPrompt || ''),
            reply: cleanSpokenText(outputTranscript || modelText),
            audio_base64: wavB64 || null,
            audio_mime: wavB64 ? 'audio/wav' : null,
            provider: 'gemini_live'
          });
        } else {
          finish(new Error(`Gemini Live closed (${ev?.code || 1006})`));
        }
      }
    });
  });
}

async function runGeminiMultimodalRestTurn({ apiKey, modelName, audioBase64, mimeType, textPrompt, systemInstruction, history = [] }) {
  const candidateModels = [];
  if (modelName && !String(modelName).includes('native-audio')) {
    candidateModels.push(String(modelName).replace(/^models\//, ''));
  }
  candidateModels.push('gemini-2.5-flash', 'gemini-2.0-flash');

  const contents = (Array.isArray(history) ? history.slice(-6) : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content.slice(0, 600) }]
    }));

  const userParts = [];
  if (audioBase64) {
    const cleanMime = String(mimeType || 'audio/wav').split(';')[0].trim() || 'audio/wav';
    userParts.push({ inlineData: { mimeType: cleanMime, data: audioBase64 } });
    userParts.push({
      text: textPrompt
        ? `User said: "${textPrompt}". Return strictly valid JSON: {"transcript": "...", "reply": "..."} where reply is concise spoken plain text in the user's language (Bengali বাংলা or English) with ZERO emojis or emoji descriptions.`
        : 'Transcribe what the user spoke in the audio accurately (detect Bengali বাংলা and English automatically, writing Bengali in Bengali Unicode script and English in Latin script; never output Hindi/Devanagari for Bengali speech) and generate your concise spoken reply in that same language. STRICT: Include ZERO emojis, emoticons, or descriptions of emojis/sounds. Return strictly valid JSON: {"transcript": "<what user said>", "reply": "<your concise spoken response>"}'
    });
  } else {
    userParts.push({ text: textPrompt });
  }
  contents.push({ role: 'user', parts: userParts });

  let lastErr = null;
  for (const mod of candidateModels) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(mod)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const body = {
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents,
        generationConfig: audioBase64 ? { responseMimeType: 'application/json', temperature: 0.65 } : { temperature: 0.65 }
      };
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(16000)
      });
      if (!resp.ok) {
        lastErr = new Error(`Gemini HTTP ${resp.status}`);
        continue;
      }
      const data = await resp.json();
      const rawText = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
      if (audioBase64) {
        try {
          const parsed = JSON.parse(rawText);
          return {
            transcript: cleanSpokenText(String(parsed.transcript || textPrompt || '')),
            reply: cleanSpokenText(parsed.reply || ''),
            audio_base64: null,
            audio_mime: null,
            provider: 'gemini_live'
          };
        } catch {
          return {
            transcript: cleanSpokenText(textPrompt || ''),
            reply: cleanSpokenText(rawText),
            audio_base64: null,
            audio_mime: null,
            provider: 'gemini_live'
          };
        }
      }
      return {
        transcript: cleanSpokenText(textPrompt || ''),
        reply: cleanSpokenText(rawText),
        audio_base64: null,
        audio_mime: null,
        provider: 'gemini_live'
      };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Gemini voice turn failed');
}

async function transcribeAudioFallback({ audioBase64, mimeType, sttUrl, apiKey, language }) {
  if (!audioBase64) return { text: '', status: 'silence' };
  const audioBuf = Buffer.from(audioBase64, 'base64');
  const cleanMime = String(mimeType || 'audio/wav').split(';')[0].trim() || 'audio/wav';
  const ext = cleanMime.includes('webm') ? 'webm' : (cleanMime.includes('mp4') ? 'm4a' : (cleanMime.includes('ogg') ? 'ogg' : 'wav'));

  let hadWorkingProvider = false;
  let lastErrMsg = '';
  const allModels = (await getPersistedModels().catch(() => [])) || [];

  // 1. Collect Custom STT, Groq Whisper & OpenAI Whisper candidates (Admin Panel settings + all 3 model slots + optional env)
  const settings = await getSystemSettings().catch(() => ({}));
  const sttCandidates = [];
  if (sttUrl && isPublicHttpUrl(sttUrl) && apiKey) {
    sttCandidates.push({ url: sttUrl.trim(), key: apiKey.trim(), model: sttUrl.includes('groq.com') ? 'whisper-large-v3-turbo' : 'whisper-1' });
  }
  for (const vk of splitApiKeys(settings && settings.voice_live_api_key)) {
    if (vk.startsWith('gsk_')) {
      sttCandidates.push({ url: 'https://api.groq.com/openai/v1/audio/transcriptions', key: vk, model: 'whisper-large-v3-turbo' });
    }
  }
  for (const m of allModels) {
    if (!m || m.is_active === false) continue;
    const modelSlots = [
      { key: m.api_key, url: m.base_url || '', type: m.type || '' },
      { key: m.fallback_key_1, url: m.fallback_url_1 || m.base_url || '', type: '' },
      { key: m.fallback_key_2, url: m.fallback_url_2 || m.base_url || '', type: '' }
    ];
    for (const sl of modelSlots) {
      const hint = `${sl.url} ${sl.type}`.toLowerCase();
      for (const k of splitApiKeys(sl.key)) {
        if (hint.includes('groq') || k.startsWith('gsk_')) {
          sttCandidates.push({ url: 'https://api.groq.com/openai/v1/audio/transcriptions', key: k, model: 'whisper-large-v3-turbo' });
        }
      }
    }
  }
  const groqEnv = process.env.GROQ_API_KEY || (await getApiKeyFromSupabase('__groq_key__')) || '';
  for (const gk of splitApiKeys(groqEnv)) {
    sttCandidates.push({ url: 'https://api.groq.com/openai/v1/audio/transcriptions', key: gk, model: 'whisper-large-v3-turbo' });
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
          form.append('prompt', 'বাংলা ভাষায় কথোপকথন। ইংরেজি শব্দ বাংলা বা ইংরেজি অক্ষরে। কোনো ইমোজি নয়।');
        } else if (language === 'en-US') {
          form.append('language', 'en');
          form.append('prompt', 'Natural English conversation without emojis.');
        } else {
          form.append('prompt', 'বাংলা এবং ইংরেজি দ্বিভাষিক কথোপকথন। Bengali and English bilingual speech. No emojis.');
        }

        const sttRes = await fetch(cand.url, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${cand.key}` },
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

  // 2. Gemini Multimodal STT fallback across rotated keys (Admin Panel settings + DB Gemini models + optional env)
  const gKeys = await resolveGeminiVoiceKeyList(settings, null, '');
  const gemModels = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash-lite'];
  for (const gKey of gKeys.slice(0, 4)) {
    for (const gm of gemModels) {
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${gm}:generateContent?key=${encodeURIComponent(gKey)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              role: 'user',
              parts: [
                { inlineData: { mimeType: cleanMime, data: audioBase64 } },
                { text: 'Transcribe the exact spoken words from this audio. Detect Bengali (বাংলা) and English automatically (including mixed Bengali-English sentences): write Bengali speech in Bengali Unicode script (বাংলা লিপি) and English words in Latin script. Never output Devanagari/Hindi for Bengali speech. STRICT: Output ONLY the plain spoken words — zero emojis, zero emoticons, zero descriptions of emojis or background sounds. If silent or noise only, return empty string.' }
              ]
            }]
          }),
          signal: AbortSignal.timeout(12000)
        });
        if (r.ok) {
          hadWorkingProvider = true;
          const d = await r.json();
          const t = cleanSpokenText(d?.candidates?.[0]?.content?.parts?.[0]?.text || '');
          if (t) return { text: t, status: 'ok' };
          break; // model confirmed audio was empty/silence
        } else {
          lastErrMsg = `Gemini STT HTTP ${r.status}`;
        }
      } catch (e) {
        lastErrMsg = e && e.message ? e.message : 'Gemini STT error';
      }
    }
  }

  if (hadWorkingProvider) {
    return { text: '', status: 'silence' };
  }
  return {
    text: '',
    status: 'error',
    error: lastErrMsg || 'ভয়েস অডিও ট্রান্সক্রাইব করতে Gemini বা Groq STT API কনফিগার করা নেই।'
  };
}

async function runCustomVoiceApiTurn({ apiUrl, apiKey, modelName, audioBase64, mimeType, textPrompt, voicePreset, systemInstruction, sttUrl, language, history = [] }) {
  if (!apiUrl || !isPublicHttpUrl(apiUrl)) {
    throw new Error('সঠিক কাস্টম ভয়েস API URL কনফিগার করা হয়নি।');
  }
  let endpoint = apiUrl.trim();
  if (!endpoint.endsWith('/chat/completions') && !endpoint.includes('/models/') && !endpoint.includes(':generateContent')) {
    endpoint = endpoint.replace(/\/+$/, '') + '/chat/completions';
  }

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const priorMsgs = [
    { role: 'system', content: systemInstruction },
    ...(Array.isArray(history) ? history.slice(-6) : [])
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map(m => ({ role: m.role, content: m.content.slice(0, 600) }))
  ];

  const isAudioPreviewModel = /audio/i.test(String(modelName || ''));
  const wavCheck = audioBase64 ? stripWavHeaderIfPresent(Buffer.from(audioBase64, 'base64')) : null;

  if (isAudioPreviewModel && (wavCheck || textPrompt)) {
    const userContent = [];
    if (wavCheck) {
      userContent.push({ type: 'input_audio', input_audio: { data: audioBase64, format: 'wav' } });
    }
    if (textPrompt) {
      userContent.push({ type: 'text', text: textPrompt });
    }
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: modelName || 'gpt-4o-audio-preview',
        modalities: ['text', 'audio'],
        audio: { voice: OPENAI_VOICE_MAP[voicePreset] || 'nova', format: 'wav' },
        messages: [...priorMsgs, { role: 'user', content: userContent }]
      }),
      signal: AbortSignal.timeout(20000)
    });
    if (resp.ok) {
      const data = await resp.json();
      const msg = data?.choices?.[0]?.message || {};
      const outAudio = msg?.audio?.data || null;
      const outTranscript = msg?.audio?.transcript || (typeof msg.content === 'string' ? msg.content : '') || '';
      return {
        transcript: textPrompt || '',
        reply: cleanSpokenText(outTranscript),
        audio_base64: outAudio,
        audio_mime: outAudio ? 'audio/wav' : null,
        provider: 'custom_api'
      };
    }
  }

  let spokenText = String(textPrompt || '').trim();
  if (!spokenText && audioBase64) {
    const sttOut = await transcribeAudioFallback({ audioBase64, mimeType, sttUrl, apiKey, language });
    spokenText = (sttOut && typeof sttOut === 'object') ? (sttOut.text || '') : String(sttOut || '');
    if (!spokenText && sttOut && sttOut.status === 'error' && audioBase64.length > 2000) {
      throw new Error(sttOut.error || 'ভয়েস অডিও ট্রান্সক্রিপশন পাওয়া যায়নি।');
    }
  }
  if (!spokenText) {
    return { transcript: '', reply: '', audio_base64: null, audio_mime: null, empty_audio: true, provider: 'custom_api' };
  }

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: modelName || 'gpt-4o-mini',
      messages: [...priorMsgs, { role: 'user', content: spokenText }],
      temperature: 0.65,
      stream: false
    }),
    signal: AbortSignal.timeout(18000)
  });
  if (!resp.ok) {
    throw new Error(`Custom Voice API HTTP ${resp.status}`);
  }
  const data = await resp.json();
  const replyText = data?.choices?.[0]?.message?.content || data?.reply || data?.text || '';
  return {
    transcript: spokenText,
    reply: cleanSpokenText(replyText),
    audio_base64: data?.audio_base64 || null,
    audio_mime: data?.audio_base64 ? (data.audio_mime || 'audio/wav') : null,
    provider: 'custom_api'
  };
}

async function runChatModelVoiceTurn({ targetModelId, audioBase64, mimeType, textPrompt, systemInstruction, sttUrl, language, history = [] }) {
  let spokenText = String(textPrompt || '').trim();
  if (!spokenText && audioBase64) {
    const sttOut = await transcribeAudioFallback({ audioBase64, mimeType, sttUrl, apiKey: '', language });
    spokenText = (sttOut && typeof sttOut === 'object') ? (sttOut.text || '') : String(sttOut || '');
    if (!spokenText && sttOut && sttOut.status === 'error' && audioBase64.length > 2000) {
      throw new Error('ভয়েস অডিও প্রসেস করতে অ্যাডমিন প্যানেলে (Models বা Live Voice সেটিংসে) একটি সক্রিয় Gemini বা Groq API কী যুক্ত করুন।');
    }
  }
  if (!spokenText) {
    return { transcript: '', reply: '', audio_base64: null, audio_mime: null, empty_audio: true, provider: 'chat_models' };
  }

  const models = await getPersistedModels();
  let modelCfg = targetModelId
    ? ((await getModelConfig(targetModelId)) || (models || []).find(m => m && (m.id === targetModelId || m.model_id === targetModelId)))
    : null;
  if (!modelCfg && Array.isArray(models) && models.length > 0) {
    modelCfg = models.find(m => m && m.is_active !== false) || models[0];
  }

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
    try {
      const isGem = tier.type === 'gemini' || String(tier.mod).startsWith('gemini-') || String(tier.url).includes('generativelanguage.googleapis.com');
      if (isGem && !String(tier.url).includes('/openai/')) {
        const gKey = tier.key || (await resolveGeminiVoiceKey(null, modelCfg));
        if (!gKey) continue;
        const gMod = String(tier.mod === 'gemini-3.5-flash-lite' || tier.mod === 'gemini-3.6-flash' ? 'gemini-2.5-flash' : tier.mod);
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(gMod)}:generateContent?key=${encodeURIComponent(gKey)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemInstruction }] },
            contents: messages.filter(m => m.role !== 'system').map(m => ({
              role: m.role === 'assistant' ? 'model' : 'user',
              parts: [{ text: m.content }]
            }))
          }),
          signal: AbortSignal.timeout(15000)
        });
        if (r.ok) {
          const d = await r.json();
          const txt = d?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
          if (txt.trim()) {
            return {
              transcript: spokenText,
              reply: cleanSpokenText(txt),
              audio_base64: null,
              audio_mime: null,
              model: modelCfg?.name || 'Alora Voice',
              provider: 'chat_models'
            };
          }
        }
        continue;
      }

      let url = tier.url;
      let key = tier.key;
      if (!url) {
        if (tier.type === 'groq' || tier.mod === 'openai/gpt-oss-120b') {
          url = 'https://api.groq.com/openai/v1/chat/completions';
          key = key || process.env.GROQ_API_KEY || (await getApiKeyFromSupabase('__groq_key__')) || '';
        } else {
          url = 'https://openrouter.ai/api/v1/chat/completions';
          key = key || process.env.OPENROUTER_API_KEY || (await getApiKeyFromSupabase('__openrouter_key__')) || '';
        }
      }
      if (!isPublicHttpUrl(url)) continue;
      if (!url.endsWith('/chat/completions') && !url.endsWith('/completions')) {
        url = url.replace(/\/+$/, '') + '/chat/completions';
      }
      const headers = { 'Content-Type': 'application/json' };
      if (key) headers['Authorization'] = `Bearer ${key}`;
      const r = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: tier.mod, messages, temperature: 0.65, stream: false }),
        signal: AbortSignal.timeout(15000)
      });
      if (r.ok) {
        const d = await r.json();
        const txt = d?.choices?.[0]?.message?.content || '';
        if (txt && String(txt).trim()) {
          return {
            transcript: spokenText,
            reply: cleanSpokenText(String(txt)),
            audio_base64: null,
            audio_mime: null,
            model: modelCfg?.name || 'Alora Voice',
            provider: 'chat_models'
          };
        }
      }
    } catch {}
  }

  throw new Error('ভয়েস উত্তর তৈরি করতে মডেল বর্তমানে ব্যস্ত আছে।');
}

async function executeVoiceTurn(payload = {}, forcedSettings = null, planObj = null, planName = 'Free') {
  const settings = forcedSettings ? { ...(await getSystemSettings()), ...forcedSettings } : await getSystemSettings();
  const {
    audio_base64 = '',
    mime_type = 'audio/wav',
    text_prompt = '',
    voice_preset = 'auto',
    language = 'auto',
    chat_model = '',
    voice_model = '',
    messages = []
  } = payload;

  const cleanAudio = typeof audio_base64 === 'string' ? audio_base64.replace(/^data:[^;]+;base64,/, '').trim() : '';
  const cleanText = typeof text_prompt === 'string' ? text_prompt.trim().slice(0, 4000) : '';

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

  async function runGeminiLiveSlot({ rawModelName, explicitKey, modelCfgForKeys, labelName }) {
    const keys = await resolveGeminiVoiceKeyList(settings, modelCfgForKeys, explicitKey);
    if (!keys.length) return null;

    let lastErr = null;
    for (const gKey of keys.slice(0, 3)) {
      const modCandidates = await resolveGeminiLiveModelCandidates(rawModelName, gKey);
      for (const modCand of modCandidates.slice(0, 5)) {
        try {
          const wsResult = await runGeminiLiveWebSocketTurn({
            apiKey: gKey,
            modelName: modCand,
            audioBase64: cleanAudio,
            mimeType: mime_type,
            textPrompt: cleanText,
            voicePreset: voice_preset,
            systemInstruction: sysInstruction,
            history: messages
          });
          if (wsResult && (wsResult.reply || wsResult.audio_base64)) {
            return { ...wsResult, model: labelName || 'Alora Live Voice' };
          }
        } catch (wsErr) {
          lastErr = wsErr;
        }
      }
      try {
        const restRes = await runGeminiMultimodalRestTurn({
          apiKey: gKey,
          modelName: modCandidates[0] || rawModelName,
          audioBase64: cleanAudio,
          mimeType: mime_type,
          textPrompt: cleanText,
          systemInstruction: sysInstruction,
          history: messages
        });
        if (restRes && (restRes.reply || restRes.audio_base64)) {
          return { ...restRes, model: labelName || 'Alora Live Voice' };
        }
      } catch (restErr) {
        lastErr = restErr;
      }
    }
    if (lastErr) throw lastErr;
    return null;
  }

  async function runVoiceModelConfigTurn(vModelCfg) {
    const labelName = vModelCfg.name || vModelCfg.model_id || 'Alora Live Voice';
    const slots = [
      {
        mod: vModelCfg.api_model_1 || vModelCfg.model_id || vModelCfg.id || '',
        url: vModelCfg.base_url || '',
        key: vModelCfg.api_key || ''
      },
      {
        mod: vModelCfg.api_model_2 || vModelCfg.fallback_model_1 || '',
        url: vModelCfg.fallback_url_1 || vModelCfg.base_url || '',
        key: vModelCfg.fallback_key_1 || vModelCfg.api_key || ''
      },
      {
        mod: vModelCfg.api_model_3 || vModelCfg.fallback_model_2 || '',
        url: vModelCfg.fallback_url_2 || vModelCfg.base_url || '',
        key: vModelCfg.fallback_key_2 || vModelCfg.api_key || ''
      }
    ].filter(s => s.mod || s.url);

    let lastSlotErr = null;
    for (const slot of slots) {
      const slotUrl = String(slot.url || '').trim();
      const isGeminiSlot = !slotUrl || /generativelanguage\.googleapis\.com/i.test(slotUrl) || vModelCfg.type === 'gemini' || /gemini|lyria/i.test(String(slot.mod || ''));
      try {
        if (isGeminiSlot) {
          const out = await runGeminiLiveSlot({
            rawModelName: slot.mod || settings.voice_live_model || 'gemini-2.5-flash-native-audio-preview-12-2025',
            explicitKey: slot.key,
            modelCfgForKeys: vModelCfg,
            labelName
          });
          if (out) return out;
        } else {
          const customRes = await runCustomVoiceApiTurn({
            apiUrl: slotUrl,
            apiKey: slot.key || settings.voice_live_api_key,
            modelName: slot.mod,
            audioBase64: cleanAudio,
            mimeType: mime_type,
            textPrompt: cleanText,
            voicePreset: voice_preset,
            systemInstruction: sysInstruction,
            sttUrl: settings.voice_stt_url,
            language,
            history: messages
          });
          if (customRes) return { ...customRes, model: labelName };
        }
      } catch (e) {
        lastSlotErr = e;
      }
    }
    if (lastSlotErr) throw lastSlotErr;
    return null;
  }

  // Admin Live Test mode (forcedSettings passed directly from Admin Panel test button)
  if (forcedSettings) {
    const testProv = ['gemini_live', 'custom_api', 'chat_models'].includes(settings.voice_provider)
      ? settings.voice_provider
      : 'gemini_live';
    if (testProv === 'gemini_live') {
      const keys = await resolveGeminiVoiceKeyList(settings, null);
      if (!keys.length) throw new Error('Gemini Live API Key কনফিগার করা হয়নি।');
      const out = await runGeminiLiveSlot({
        rawModelName: settings.voice_live_model || 'gemini-2.5-flash-native-audio-preview-12-2025',
        explicitKey: keys.join(','),
        modelCfgForKeys: null,
        labelName: settings.voice_live_model || 'Gemini Live'
      });
      if (out) return out;
      throw new Error('Gemini Live টেস্ট উত্তর পাওয়া যায়নি।');
    }
    if (testProv === 'custom_api') {
      const resCustom = await runCustomVoiceApiTurn({
        apiUrl: settings.voice_live_url,
        apiKey: settings.voice_live_api_key,
        modelName: settings.voice_live_model,
        audioBase64: cleanAudio,
        mimeType: mime_type,
        textPrompt: cleanText,
        voicePreset: voice_preset,
        systemInstruction: sysInstruction,
        sttUrl: settings.voice_stt_url,
        language,
        history: messages
      });
      return { ...resCustom, model: settings.voice_live_model || 'Custom Voice' };
    }
    return await runChatModelVoiceTurn({
      targetModelId: chat_model,
      audioBase64: cleanAudio,
      mimeType: mime_type,
      textPrompt: cleanText,
      systemInstruction: sysInstruction,
      sttUrl: settings.voice_stt_url,
      language,
      history: messages
    });
  }

  // Determine per-plan voice_mode ('chat_as_live' | 'live_models' | 'both') & accessible models
  const planOverride = planObj && typeof planObj.voice_model === 'string' ? planObj.voice_model.trim() : '';
  let planVoiceMode = (planName === 'Admin')
    ? 'both'
    : (planObj && ['chat_as_live', 'live_models', 'both'].includes(planObj.voice_mode) ? planObj.voice_mode : 'chat_as_live');

  if (planOverride === '__chat_models__') planVoiceMode = 'chat_as_live';
  else if (planOverride === '__gemini_live__' || planOverride === '__custom_voice__') planVoiceMode = 'live_models';

  const requestedVoiceModelId = String(voice_model || '').trim();
  const requestedChatModelId = String(chat_model || '').trim();

  // Mode 1: Plan configured so Chat Models themselves work like Live Voice ('chat_as_live')
  if (planVoiceMode === 'chat_as_live') {
    const targetChatId = (planOverride && !planOverride.startsWith('__'))
      ? planOverride
      : (requestedVoiceModelId || requestedChatModelId);
    return await runChatModelVoiceTurn({
      targetModelId: targetChatId,
      audioBase64: cleanAudio,
      mimeType: mime_type,
      textPrompt: cleanText,
      systemInstruction: sysInstruction,
      sttUrl: settings.voice_stt_url,
      language,
      history: messages
    });
  }

  // Check if user in 'both' mode explicitly picked a Chat model inside Voice Mode
  if (planVoiceMode === 'both' && requestedVoiceModelId) {
    const reqCfg = await getModelConfig(requestedVoiceModelId);
    if (reqCfg && (reqCfg.category || 'chat') === 'chat' && canPlanAccessModel(reqCfg, planName, planObj)) {
      return await runChatModelVoiceTurn({
        targetModelId: requestedVoiceModelId,
        audioBase64: cleanAudio,
        mimeType: mime_type,
        textPrompt: cleanText,
        systemInstruction: sysInstruction,
        sttUrl: settings.voice_stt_url,
        language,
        history: messages
      });
    }
  }

  // Mode 2 / 'both' with Live Models: Build ordered chain of accessible category='voice' models (just like Chat models!)
  let allModels = [];
  if (getIsMongoConnected()) {
    allModels = await AiModel.find({ is_active: { $ne: false } }).sort({ order: 1, createdAt: 1 }).lean().catch(() => []);
  }
  if (!allModels || allModels.length === 0) {
    allModels = (await getPersistedModels()) || [];
  }

  const accessibleVoiceModels = [];
  for (const rawM of allModels) {
    if (!rawM || rawM.is_active === false) continue;
    if (rawM.category !== 'voice') continue;
    if (!canPlanAccessModel(rawM, planName, planObj)) continue;
    const hydrated = await getModelConfig(rawM.model_id || rawM.id);
    if (hydrated) accessibleVoiceModels.push(hydrated);
  }

  const orderedLiveQueue = [];
  const pushUniqueModel = (cfg) => {
    if (!cfg) return;
    const cid = String(cfg.model_id || cfg.id || '');
    if (cid && !orderedLiveQueue.some(x => String(x.model_id || x.id || '') === cid)) {
      orderedLiveQueue.push(cfg);
    }
  };

  if (requestedVoiceModelId) {
    const picked = accessibleVoiceModels.find(m => (m.model_id || m.id) === requestedVoiceModelId);
    if (picked) pushUniqueModel(picked);
  }
  if (planOverride && !planOverride.startsWith('__')) {
    const planDefMod = accessibleVoiceModels.find(m => (m.model_id || m.id) === planOverride);
    if (planDefMod) pushUniqueModel(planDefMod);
  }
  accessibleVoiceModels.forEach(pushUniqueModel);

  // Try each configured Live Voice model (and its 3 internal fallback slots) in order
  for (const liveCfg of orderedLiveQueue) {
    try {
      const liveOut = await runVoiceModelConfigTurn(liveCfg);
      if (liveOut && (liveOut.reply || liveOut.audio_base64 || liveOut.empty_audio)) {
        return liveOut;
      }
    } catch {}
  }

  // If no dedicated 'voice' models matched or succeeded, try global Live Voice provider setting
  let globalProvider = ['gemini_live', 'custom_api', 'chat_models'].includes(settings.voice_provider)
    ? settings.voice_provider
    : 'gemini_live';
  if (planOverride === '__custom_voice__') globalProvider = 'custom_api';
  else if (planOverride === '__gemini_live__') globalProvider = 'gemini_live';

  if (globalProvider === 'gemini_live') {
    try {
      const globalOut = await runGeminiLiveSlot({
        rawModelName: settings.voice_live_model || 'gemini-2.5-flash-native-audio-preview-12-2025',
        explicitKey: '',
        modelCfgForKeys: null,
        labelName: 'Alora Live Voice'
      });
      if (globalOut) return globalOut;
    } catch {}
  } else if (globalProvider === 'custom_api' && settings.voice_live_url) {
    try {
      const resCustom = await runCustomVoiceApiTurn({
        apiUrl: settings.voice_live_url,
        apiKey: settings.voice_live_api_key,
        modelName: settings.voice_live_model,
        audioBase64: cleanAudio,
        mimeType: mime_type,
        textPrompt: cleanText,
        voicePreset: voice_preset,
        systemInstruction: sysInstruction,
        sttUrl: settings.voice_stt_url,
        language,
        history: messages
      });
      if (resCustom) return { ...resCustom, model: 'Alora Voice' };
    } catch {}
  }

  // Seamless ultimate fallback to Chat-as-Live so Voice Mode never fails
  return await runChatModelVoiceTurn({
    targetModelId: requestedChatModelId,
    audioBase64: cleanAudio,
    mimeType: mime_type,
    textPrompt: cleanText,
    systemInstruction: sysInstruction,
    sttUrl: settings.voice_stt_url,
    language,
    history: messages
  });
}

const handleLiveVoiceTurn = async (req, res) => {
  const userId = req.user ? String(req.user._id || req.user.id) : (req.guestId ? String(req.guestId) : null);
  try {
    const planObj = req.currentPlan || DEFAULT_PLANS_MAP.Free;
    const planName = req.user ? (planObj.name || 'Free') : 'Guest';

    const result = await executeVoiceTurn(req.body || {}, null, planObj, planName);

    // If audio was pure silence, roll back reserved cache slot and do not deduct voice quota
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

    // Check output prompt safety if transcript came from raw audio
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
      provider: result.provider || 'gemini_live',
      model: result.model || 'Alora Live Voice',
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

// Zero-dependency RFC-6455 WebSocket frame helpers for /ws/voice-live
function encodeWsTextFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function attachVoiceLiveWebSocket(httpServer) {
  if (!httpServer || typeof WebSocket !== 'function') return;

  httpServer.on('upgrade', async (req, socket, head) => {
    try {
      const parsedUrl = new URL(req.url || '/', 'http://localhost');
      if (parsedUrl.pathname !== '/ws/voice-live' && parsedUrl.pathname !== '/api/chat/ws/voice-live') {
        socket.destroy();
        return;
      }

      const wsKey = req.headers['sec-websocket-key'];
      if (!wsKey) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
      }

      // Authenticate optional JWT token
      let user = null;
      const token = parsedUrl.searchParams.get('token') || '';
      if (token) {
        try {
          const decoded = jwt.verify(token, JWT_SECRET);
          if (getIsMongoConnected() && decoded.id && /^[0-9a-fA-F]{24}$/.test(String(decoded.id))) {
            user = await User.findById(decoded.id).lean();
          }
          if (!user && memoryStore.users) {
            user = memoryStore.users.find(u => String(u._id || u.id) === String(decoded.id) || (decoded.email && u.email === decoded.email));
          }
        } catch {}
      }

      const adminEmails = ['zihanfakir@gmail.com', 'x@zihan.uk'];
      const isAdmin = Boolean(user && (user.role === 'admin' || (user.email && adminEmails.includes(String(user.email).toLowerCase()))));
      const planName = isAdmin ? 'Admin' : (user?.subscription?.plan_name || (user ? 'Free' : 'Guest'));
      let plan = DEFAULT_PLANS_MAP[planName] || DEFAULT_PLANS_MAP.Free;
      if (!isAdmin) {
        if (getIsMongoConnected()) {
          try {
            const pDoc = await Plan.findOne({ name: planName }).lean();
            if (pDoc) plan = normalizePlanDoc(pDoc);
          } catch {}
        } else {
          const pList = await getPersistedPlans();
          const found = pList.find(p => p.name === planName);
          if (found) plan = normalizePlanDoc(found);
        }
      }

      const userId = user ? String(user._id || user.id) : `guest_${String(req.socket?.remoteAddress || '127.0.0.1').replace(/[^a-zA-Z0-9]/g, '_')}`;
      if (!isAdmin && user) {
        const [mDet, vDet] = await Promise.all([
          getUserUsageDetails(userId, plan.window_hours || 3),
          getUserVoiceUsageDetails(userId, plan.window_hours || 3)
        ]);
        if (mDet.count >= plan.message_limit || plan.voice_limit <= 0 || vDet.count >= plan.voice_limit) {
          socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
          socket.destroy();
          return;
        }
      }

      const settings = await getSystemSettings();
      const gKey = await resolveGeminiVoiceKey(settings, null);
      if (!gKey) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
        socket.destroy();
        return;
      }

      const acceptHash = crypto
        .createHash('sha1')
        .update(wsKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');

      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptHash}\r\n\r\n`
      );

      const voicePreset = parsedUrl.searchParams.get('voice') || 'auto';
      const lang = parsedUrl.searchParams.get('lang') || 'auto';
      const reqModParam = parsedUrl.searchParams.get('model') || settings.voice_live_model || 'gemini-2.5-flash-native-audio-preview-12-2025';
      const wsModCandidates = await resolveGeminiLiveModelCandidates(reqModParam, gKey);
      const liveMod = wsModCandidates[0] || 'gemini-2.5-flash-native-audio-preview-12-2025';
      const upstream = new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(gKey)}`);

      const sendClientJson = (obj) => {
        if (!socket.destroyed) {
          try { socket.write(encodeWsTextFrame(JSON.stringify(obj))); } catch {}
        }
      };

      upstream.addEventListener('open', () => {
        upstream.send(JSON.stringify({
          setup: {
            model: `models/${liveMod}`,
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: GEMINI_VOICE_MAP[voicePreset] || 'Aoede' } } }
            },
            systemInstruction: { parts: [{ text: buildVoiceSystemInstruction(lang, settings.voice_system_prompt) }] },
            outputAudioTranscription: {},
            inputAudioTranscription: {}
          }
        }));
      });

      let pcmTurnChunks = [];
      upstream.addEventListener('message', async (ev) => {
        try {
          const str = typeof ev.data === 'string'
            ? ev.data
            : (ev.data instanceof ArrayBuffer ? Buffer.from(ev.data).toString('utf8') : await ev.data.text());
          const msg = JSON.parse(str);
          if (msg.setupComplete !== undefined) {
            sendClientJson({ type: 'ready' });
            return;
          }
          const sc = msg.serverContent;
          if (sc) {
            if (sc.inputTranscription?.text) {
              const ctIn = cleanSpokenText(sc.inputTranscription.text);
              if (ctIn) sendClientJson({ type: 'input_transcript', text: ctIn });
            }
            if (sc.outputTranscription?.text) {
              const ctOut = cleanSpokenText(sc.outputTranscription.text);
              if (ctOut) sendClientJson({ type: 'output_transcript', text: ctOut });
            }
            if (sc.modelTurn?.parts) {
              for (const p of sc.modelTurn.parts) {
                if (p.inlineData?.data) pcmTurnChunks.push(Buffer.from(p.inlineData.data, 'base64'));
                if (p.text) {
                  const ctTxt = cleanSpokenText(p.text);
                  if (ctTxt) sendClientJson({ type: 'text', text: ctTxt });
                }
              }
            }
            if (sc.turnComplete) {
              const wav = pcmTurnChunks.length > 0 ? wrapPcm16ToWavBase64(Buffer.concat(pcmTurnChunks), 24000, 1) : null;
              pcmTurnChunks = [];
              if (!isAdmin && userId) {
                await withUserQuotaLock(userId, async () => {
                  if (getIsMongoConnected()) {
                    await UsageLog.create({ user_id: userId, model_id: 'voice-live', timestamp: new Date() }).catch(() => {});
                  } else {
                    memoryStore.usageLogs.push({ _id: 'log_' + Date.now(), user_id: userId, model_id: 'voice-live', timestamp: new Date() });
                    debouncedSave();
                  }
                  await incrementUserVoiceUsage(userId, plan.window_hours || 3);
                });
              }
              sendClientJson({ type: 'turn_complete', audio_base64: wav, audio_mime: wav ? 'audio/wav' : null });
            }
          }
        } catch {}
      });

      upstream.addEventListener('close', () => { try { socket.end(); } catch {} });
      upstream.addEventListener('error', () => { try { socket.destroy(); } catch {} });

      let recvBuf = Buffer.alloc(0);
      if (head && head.length) recvBuf = Buffer.concat([recvBuf, head]);

      const parseFrames = () => {
        while (recvBuf.length >= 2) {
          const first = recvBuf[0];
          const opcode = first & 0x0f;
          const masked = (recvBuf[1] & 0x80) !== 0;
          let len = recvBuf[1] & 0x7f;
          let offset = 2;
          if (len === 126) {
            if (recvBuf.length < 4) return;
            len = recvBuf.readUInt16BE(2);
            offset = 4;
          } else if (len === 127) {
            if (recvBuf.length < 10) return;
            len = Number(recvBuf.readBigUInt64BE(2));
            offset = 10;
          }
          if (len > 4 * 1024 * 1024) {
            socket.destroy();
            return;
          }
          const maskLen = masked ? 4 : 0;
          if (recvBuf.length < offset + maskLen + len) return;
          const mask = masked ? recvBuf.slice(offset, offset + 4) : null;
          const data = Buffer.from(recvBuf.slice(offset + maskLen, offset + maskLen + len));
          recvBuf = recvBuf.slice(offset + maskLen + len);
          if (masked && mask) {
            for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
          }
          if (opcode === 0x8) {
            try { upstream.close(); } catch {}
            socket.end();
            return;
          }
          if (opcode === 0x1 && upstream.readyState === 1) {
            try {
              const clientMsg = JSON.parse(data.toString('utf8'));
              if (clientMsg.type === 'audio_pcm' && clientMsg.data) {
                upstream.send(JSON.stringify({
                  realtimeInput: { mediaChunks: [{ mimeType: `audio/pcm;rate=${clientMsg.rate || 16000}`, data: clientMsg.data }] }
                }));
              } else if (clientMsg.type === 'turn_end') {
                upstream.send(JSON.stringify({ clientContent: { turnComplete: true } }));
              } else if (clientMsg.type === 'text' && clientMsg.text) {
                upstream.send(JSON.stringify({
                  clientContent: { turns: [{ role: 'user', parts: [{ text: String(clientMsg.text).slice(0, 2000) }] }], turnComplete: true }
                }));
              }
            } catch {}
          }
        }
      };

      socket.on('data', (chunk) => {
        recvBuf = Buffer.concat([recvBuf, chunk]);
        if (recvBuf.length > 5 * 1024 * 1024) {
          socket.destroy();
          return;
        }
        parseFrames();
      });
      socket.on('close', () => { try { upstream.close(); } catch {} });
      socket.on('error', () => { try { upstream.close(); } catch {} });
      parseFrames();
    } catch {
      try { socket.destroy(); } catch {}
    }
  });
}

module.exports = {
  executeVoiceTurn,
  handleLiveVoiceTurn,
  attachVoiceLiveWebSocket,
  wrapPcm16ToWavBase64,
  discoverGeminiLiveModels,
  resolveGeminiVoiceKey,
  cleanSpokenText,
  buildVoiceSystemInstruction
};
