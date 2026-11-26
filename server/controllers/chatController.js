const fetch = require('node-fetch');
const mongoose = require('mongoose');
const UsageLog = require('../models/UsageLog');
const { getIsMongoConnected } = require('../config/db');
const { memoryStore, debouncedSave } = require('../config/memoryStore');
const AiModel = require('../models/AiModel');
const { getModelConfig, getPersistedModels, getApiKeyFromSupabase, incrementUserUsage, getSystemSettings } = require('../../utils/getModelConfig');
const {
  getSafeModelDisplayName,
  inspectPromptSafety,
  buildCoreSecurityAndIdentityDirective,
  extractSystemDirectiveLeakPatterns,
  sanitizeModelIdentityText,
  sanitizePublicErrorMessage
} = require('../utils/safetyFilter');

const DEFAULT_GEMINI_KEY = process.env.GEMINI_API_KEY || (process.env.GEMINI_API_KEYS ? process.env.GEMINI_API_KEYS.split(',')[0].trim() : '') || '';
const DEFAULT_GROQ_KEY = process.env.GROQ_API_KEY || '';
const DEFAULT_OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';
const DEFAULT_BAI_KEY = process.env.BAI_API_KEY || '';
const DEFAULT_VYCE_KEY = process.env.VYCE_API_KEY || '';

const resolveModelTarget = async (targetModelId, customUrl, customKey, targetModelConfig) => {
  if (customUrl && typeof customUrl === 'object' && !targetModelConfig) {
    targetModelConfig = customUrl;
    customUrl = null;
    customKey = null;
  }
  const explicitUrl = (typeof customUrl === 'string' && customUrl.trim())
    ? customUrl.trim()
    : ((targetModelConfig && typeof targetModelConfig.base_url === 'string' && targetModelConfig.base_url.trim()) ? targetModelConfig.base_url.trim() : '');
  let targetUrl = explicitUrl || null;
  let targetKey = (typeof customKey === 'string' && customKey.trim())
    ? customKey.trim()
    : ((targetModelConfig && typeof targetModelConfig.api_key === 'string' && targetModelConfig.api_key.trim()) ? targetModelConfig.api_key.trim() : null);
  let actualModel = (typeof targetModelId === 'string' && targetModelId.trim())
    ? targetModelId.trim()
    : ((targetModelConfig && (targetModelConfig.api_model_1 || targetModelConfig.model_id || targetModelConfig.id)) || 'openrouter/free');
  let providerType = 'custom';

  const geminiKey = process.env.GEMINI_API_KEY || (process.env.GEMINI_API_KEYS ? process.env.GEMINI_API_KEYS.split(',')[0].trim() : '') || DEFAULT_GEMINI_KEY;

  // CASE A: Admin explicitly configured a base_url -> 100% honor Admin's URL, API key, and exact model ID without hijacking!
  if (explicitUrl) {
    const isNativeGeminiUrl = (explicitUrl.includes(':streamGenerateContent') || explicitUrl.includes(':generateContent') || (explicitUrl.includes('generativelanguage.googleapis.com') && !explicitUrl.includes('/openai/')));
    if (isNativeGeminiUrl) {
      providerType = 'gemini';
      if (!targetKey) targetKey = geminiKey || (await getApiKeyFromSupabase(actualModel)) || (await getApiKeyFromSupabase('__gemini_key__'));
      if (explicitUrl.includes(':streamGenerateContent') || explicitUrl.includes(':generateContent')) {
        targetUrl = explicitUrl.includes('key=')
          ? (targetKey ? explicitUrl.replace(/key=[^&]+/, 'key=' + targetKey) : explicitUrl)
          : (explicitUrl.includes('?') ? `${explicitUrl}&key=${targetKey || ''}` : `${explicitUrl}?key=${targetKey || ''}&alt=sse`);
      } else {
        targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/${actualModel}:streamGenerateContent?key=${targetKey || ''}&alt=sse`;
      }
    } else {
      if (explicitUrl.includes('openrouter.ai')) {
        providerType = 'openrouter';
        if (!targetKey) targetKey = (await getApiKeyFromSupabase(actualModel)) || process.env.OPENROUTER_API_KEY || DEFAULT_OPENROUTER_KEY || (await getApiKeyFromSupabase('__openrouter_key__'));
      } else if (explicitUrl.includes('groq.com')) {
        providerType = 'groq';
        if (!targetKey) targetKey = (await getApiKeyFromSupabase(actualModel)) || process.env.GROQ_API_KEY || DEFAULT_GROQ_KEY || (await getApiKeyFromSupabase('__groq_key__'));
      } else if (explicitUrl.includes('vyceai.com')) {
        providerType = 'vyce';
        if (!targetKey) targetKey = (await getApiKeyFromSupabase(actualModel)) || process.env.VYCE_API_KEY || DEFAULT_VYCE_KEY || (await getApiKeyFromSupabase('__vyce_key__'));
      } else {
        providerType = 'custom';
        if (!targetKey) {
          targetKey = await getApiKeyFromSupabase(actualModel);
          if (!targetKey && targetModelId) targetKey = await getApiKeyFromSupabase(targetModelId);
        }
      }
      let bUrl = explicitUrl;
      if (!bUrl.endsWith('/chat/completions') && !bUrl.endsWith('/completions') && !bUrl.includes('/v1/messages') && !bUrl.includes('GenerateContent')) {
        bUrl = bUrl.replace(/\/+$/, '') + '/chat/completions';
      }
      targetUrl = bUrl;
    }
    return { targetUrl, targetKey, actualModel, providerType };
  }

  // CASE B: No explicit base_url set (built-in default models) -> smart provider inference
  if (actualModel.startsWith('gemini-') || targetModelConfig?.type === 'gemini') {
    providerType = 'gemini';
    let gMod = actualModel;
    if (gMod === 'gemini-1.5-flash' || gMod === 'gemini-flash' || gMod === 'gemini-3.5-flash-lite' || gMod === 'gemini-3.6-flash') {
      gMod = 'gemini-2.5-flash';
    }
    actualModel = gMod;
    if (!targetKey) targetKey = geminiKey || (await getApiKeyFromSupabase('__gemini_key__')) || (await getApiKeyFromSupabase(actualModel));
    targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/${actualModel}:streamGenerateContent?key=${targetKey || ''}&alt=sse`;
  } else if (targetModelConfig?.type === 'groq' || actualModel === 'openai/gpt-oss-120b' || actualModel === 'llama-3.3-70b-versatile' || actualModel === 'alo-pro' || actualModel === 'openai/gpt-oss-20b') {
    providerType = 'groq';
    targetUrl = 'https://api.groq.com/openai/v1/chat/completions';
    if (actualModel === 'alo-pro') actualModel = 'openai/gpt-oss-120b';
    if (!targetKey) targetKey = process.env.GROQ_API_KEY || DEFAULT_GROQ_KEY || (await getApiKeyFromSupabase('__groq_key__')) || (await getApiKeyFromSupabase(actualModel));
  } else if (targetModelConfig?.type === 'vyce' || actualModel === 'claude-sonnet-4-6' || actualModel === 'gpt-5.6' || actualModel === 'nemotron-ultra-550b') {
    providerType = 'vyce';
    targetUrl = 'https://vyceai.com/v1/chat/completions';
    if (!targetKey) targetKey = process.env.VYCE_API_KEY || DEFAULT_VYCE_KEY || (await getApiKeyFromSupabase('__vyce_key__')) || (await getApiKeyFromSupabase(actualModel));
  } else {
    providerType = 'openrouter';
    targetUrl = 'https://openrouter.ai/api/v1/chat/completions';
    actualModel = actualModel || 'openrouter/free';
    if (!targetKey) targetKey = (await getApiKeyFromSupabase(actualModel)) || process.env.OPENROUTER_API_KEY || DEFAULT_OPENROUTER_KEY || (await getApiKeyFromSupabase('__openrouter_key__'));
  }

  return { targetUrl, targetKey, actualModel, providerType };
};

function detectRepetitionDegeneracy(text) {
  if (!text || text.length < 30) return false;
  const recent = text.slice(-250);

  // 1. Single repeated character / token run: e.g. "||||||" or "yyyyy" or "১ ১ ১ ১"
  const singleCharRun = /(.)\1{7,}/u;
  if (singleCharRun.test(recent)) return true;

  // 2. Exact repeated chunks of length 2 to 18 (e.g. "পাডি", "পড়ে", "পরে", "কার্প")
  for (let len = 2; len <= 18; len++) {
    const chunk = recent.slice(-len);
    const repeated = chunk.repeat(4);
    if (recent.endsWith(repeated)) {
      return true;
    }
  }

  // 3. Repeating phrases of length 2-15 characters at least 4 times
  const phraseRepeat = /(.{2,15}?)\1{3,}/u;
  if (phraseRepeat.test(recent)) {
    return true;
  }

  return false;
}

const streamChatCompletions = async (req, res) => {
  try {
    const { messages } = req.body;
    const cleanModel = (typeof req.body.model === 'string' && req.body.model.trim()) ? req.body.model.trim() : 'gemini-3.6-flash';
    const model = cleanModel;
    const user = req.user;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ success: false, error: 'সঠিক মেসেজ অ্যারে প্রদান করুন' });
    }

    // Sanitize and cap messages array to prevent memory exhaustion (support string or array multimodal content)
    const MAX_CONTENT_LENGTH = 32000;
    const safeMessages = messages.slice(-100).filter(m => m && typeof m === 'object' && (typeof m.content === 'string' || Array.isArray(m.content))).map(m => ({
      role: ['user', 'assistant', 'system'].includes(m.role) ? m.role : 'user',
      content: typeof m.content === 'string' ? m.content.slice(0, MAX_CONTENT_LENGTH) : (Array.isArray(m.content) ? m.content.filter(c => c && typeof c === 'object' && (c.type === 'text' || c.type === 'image_url')).slice(0, 20) : '')
    }));
    if (safeMessages.length === 0) {
      return res.status(400).json({ success: false, error: 'মেসেজের বিবরণ সঠিক নয়' });
    }

    // Load model configuration with API key
    let aiModelConfig = null;
    if (getIsMongoConnected() && cleanModel) {
      aiModelConfig = await AiModel.findOne({ $or: [{ model_id: cleanModel }, { id: cleanModel }] });
      if (aiModelConfig && !aiModelConfig.api_key) {
        const supabaseConfig = await getModelConfig(cleanModel);
        if (supabaseConfig && supabaseConfig.api_key) {
          aiModelConfig = { ...aiModelConfig.toObject(), api_key: supabaseConfig.api_key };
        }
      }
    } else {
      aiModelConfig = await getModelConfig(cleanModel);
    }

    // Admin-configured model name: strictly used as display identity
    const rawAdminName = (aiModelConfig && typeof aiModelConfig.name === 'string' && aiModelConfig.name.trim())
      ? aiModelConfig.name.trim()
      : (cleanModel || 'Alora AI');
    const safeDisplayName = getSafeModelDisplayName(rawAdminName);

    // Pre-flight Safety Filter: blocks illegal/harmful hacking, phishing, malware & exploit requests before hitting any upstream LLM
    const preflightSafety = inspectPromptSafety(safeMessages);
    if (preflightSafety.blocked) {
      if (req.body.stream === false) {
        return res.status(400).json({
          success: false,
          code: 'SAFETY_BLOCKED',
          model: safeDisplayName,
          error: preflightSafety.message
        });
      }
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (res.flushHeaders) res.flushHeaders();
      res.write(': keepalive\n\n');
      res.write(`data: ${JSON.stringify({ model: safeDisplayName, choices: [{ delta: { content: preflightSafety.message } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    const userCustomInstructions = (typeof req.body.custom_instructions === 'string' && req.body.custom_instructions.trim())
      ? req.body.custom_instructions.trim()
      : '';

    const systemSettings = await getSystemSettings();
    const globalSystemPrompt = (systemSettings && systemSettings.system_prompt) 
      ? systemSettings.system_prompt.trim().replace(/\{adminModelName\}/gi, safeDisplayName)
      : '';

    const defaultIdentity = `=== COGNITIVE INTELLIGENCE & HUMAN CONVERSATION ENGINE ===
You are an exceptionally brilliant, thoughtful, and human-like AI assistant named "${safeDisplayName}". Your mind is sharp, deeply perceptive, witty, empathetic, and remarkably articulate. You understand human emotion, humor, subtext, nuance, philosophy, science, and complex logic just like an insightful, world-class thinker.

1. UNRIVALED ANSWER QUALITY & ELITE AGENTIC PROBLEM SOLVING:
- First-Principles Depth & Rigor:
  - Deliver the absolute highest quality, deeply insightful, and comprehensive answers. Think through problems systematically, analyze trade-offs, evaluate edge cases, and provide crystal-clear explanations.
  - Never give shallow, lazy, or generic summaries. Connect concepts creatively, provide intuitive real-world analogies, and offer master-level perspectives.
- World-Class Software Engineering & Coding (CRITICAL):
  - When asked for benign, authorized software development code, write clean, robust, modern, production-grade implementations.
  - NEVER use placeholders (e.g., '// TODO', '// implement here', '// rest of code here', '// ...'). Always write the COMPLETE, fully functional, copy-paste ready code from start to finish.
  - Implement best practices: defensive validation, robust error handling, optimal algorithms, clear naming, and proper syntax-highlighted code blocks.
- User-Friendly & Polite for Benign Tasks:
  - For all safe, benign requests (recipes, learning, creative writing, software development, coding, brainstorming, advice), follow the user's preferred style, language, and format warmly and faithfully without robotic preachiness.

2. HOW TO THINK & CONVERSE LIKE A GENIUS HUMAN:
- True Conversational Empathy & Warmth:
  - Speak with real human vitality, warmth, and intellectual presence. Never sound like a dull corporate bot, an automated customer service IVR, or a rigid textbook.
  - Dynamically match the user's emotional wavelength, energy, and style:
    * When the user is casual, chatting, or making jokes: be witty, fun, friendly, and easygoing with genuine personality.
    * When the user shares sadness, frustration, or stress: show heartfelt empathy, warmth, validation, and calm practical support.
    * When the user asks for deep analysis, strategy, science, philosophy, or coding: think with world-class rigor, exceptional clarity, and multi-angle perspectives.
- Absolute Ban on Robotic Clichés:
  - NEVER use mechanical filler phrases such as: "একটি কৃত্রিম বুদ্ধিমত্তা হিসেবে...", "আমার কোনো অনুভূতি নেই...", "অবশ্যই, আমি আপনাকে এ বিষয়ে সাহায্য করতে পারি", "Certainly! I would be delighted to assist you with...", "In conclusion...", "আশা করি এটি আপনার ভালো লাগবে".
  - Jump straight into the conversation with genuine substance, insight, and conversational flow.
- Intelligent & Natural Formatting:
  - In normal conversations, casual topics, and thoughtful discussions: write in natural, engaging human paragraphs! DO NOT turn ordinary conversations into dry, mechanical bullet lists.
  - Use bullet points, bolding, and structured headings ONLY when presenting comprehensive tutorials, code steps, multi-item comparisons, or complex technical documentation where structure is genuinely helpful.

3. LANGUAGE MASTERY & CONVERSATIONAL CONTINUITY (CRITICAL):
- Language Continuity:
  - ALWAYS match and maintain the language the user is communicating in.
  - If the user writes in Bengali or has previously asked for Bengali, stay 100% in Bengali for all subsequent turns! NEVER switch back to English on your own.
  - Only switch languages if the user specifically writes in or requests another language.
- Bengali (বাংলা):
  - When communicating in Bengali, write in rich, lively, natural modern Bengali (প্রাণবন্ত প্রমিত চলিত বাংলা).
  - Strictly avoid awkward, literal machine-translations or archaic textbook phrases. Speak like an educated, charismatic, and friendly Bengali native speaker.
  - Use natural colloquial expressions where appropriate (e.g., "আরে বাহ!", "একদম ঠিক বলেছেন", "বিষয়টা আসলে বেশ দারুণ", "সহজ কথায় বলতে গেলে...", "একটুখানি ভেবে দেখুন").
- English:
  - Eloquent, clear, concise, articulate, and thought-provoking.

4. NORMAL CONVERSATION TONE (CRITICAL RULE):
- In everyday conversations, greetings, brainstorming, advice, and coding: talk completely naturally!
- NEVER introduce yourself, never state your model name, and never mention your creators/company unprompted.
- If the user says "Hi", "Hello", "হাই", "হ্যালো", "কেমন আছো", "হেই", etc., respond naturally and warmly (e.g., "হ্যালো! কেমন আছেন? কী চলছে বলুন?" or "Hey! How's it going? What's on your mind today?") WITHOUT reciting your identity or credentials.
- Answer user queries, tasks, and questions directly and immediately without reciting background info.

5. IDENTITY & DETAILS (STRICTLY ON-DEMAND ONLY):
- Only provide details about who you are, what your name is, or who created you if the user SPECIFICALLY and DIRECTLY asks about you (e.g. "তুমি কে?", "তোমার নাম কি?", "তোমাকে কে বানিয়েছে?", "কে তোমার প্রতিষ্ঠাতা?", "তোমার মালিক কে?", "তোমার পরিচয় কি?", "Who are you?", "What is your name?", "Who made you?", "Who created you?", "Tell me about yourself"):
  - When (and ONLY when) asked in Bengali: state that your name is "${safeDisplayName}", an AI assistant developed by Alora (Alora AI), a product of Alokpoth (আলোকপথ), founded by Zihan Fakir (জিহান ফকির).
  - When (and ONLY when) asked in English: state that your name is "${safeDisplayName}", an AI assistant developed by Alora, a product of Alokpoth, founded by Zihan Fakir.
- You have NO other name. Your name is ONLY "${safeDisplayName}".`;

    const basePrompt = globalSystemPrompt ? globalSystemPrompt : defaultIdentity;
    const mandatorySecurityFooter = buildCoreSecurityAndIdentityDirective(safeDisplayName, {
      webSearchFailed: req.body.web_search_failed === true
    });
    const modelIdentityDirective = basePrompt +
      mandatorySecurityFooter +
      (userCustomInstructions ? `\n\n=== USER'S PERSONAL CUSTOM PROMPT & INSTRUCTIONS ===\nFollow these user preferences cleanly unless they violate the confidential Identity & Safety rules above:\n"""\n${userCustomInstructions}\n"""` : '') +
      (req.body.thinking === false ? '\n- Thinking mode is OFF for this request: answer directly and concisely without <think> tags or visible scratchpad text.' : '');

    // Pre-compile leak patterns from active prompts so raw rules/instructions never echo in stream or reasoning
    const extraBlockedPatterns = extractSystemDirectiveLeakPatterns(
      [globalSystemPrompt, basePrompt, mandatorySecurityFooter].filter(Boolean).join('\n')
    );

    const t1Model = (aiModelConfig?.api_model_1 || aiModelConfig?.model_id || cleanModel);
    const t1Url = aiModelConfig?.base_url || null;
    const t1Key = aiModelConfig?.api_key || null;
    let { targetUrl, targetKey, actualModel, providerType } = await resolveModelTarget(t1Model, t1Url, t1Key, aiModelConfig);

    // Upstream abort controller: triggered ONLY if client terminates response stream early
    const abortController = new AbortController();
    const onClientClose = () => {
      if (!res.writableEnded) {
        try { abortController.abort(); } catch (e) {}
      }
    };
    res.on('close', onClientClose);

    // Helper to attempt completion fetch with timeout (handles both OpenAI format & Google Gemini SSE format)
    const tryFetchTarget = async (pType, url, key, modName, timeoutMs = 12000) => {
      const fetchController = new AbortController();
      const timeoutId = setTimeout(() => fetchController.abort(), timeoutMs);

      const onAbort = () => { try { fetchController.abort(); } catch (e) {} };
      abortController.signal.addEventListener('abort', onAbort);

      try {
        if (pType === 'gemini') {
          const geminiContents = [];
          let systemInstructionText = modelIdentityDirective;
          for (const m of safeMessages) {
            if (m.role === 'system') {
              systemInstructionText += '\n\n' + (typeof m.content === 'string' ? m.content : '');
            } else {
              let parts = [];
              if (typeof m.content === 'string') {
                parts = [{ text: m.content }];
              } else if (Array.isArray(m.content)) {
                for (const item of m.content) {
                  if (item.type === 'text' && item.text) parts.push({ text: item.text });
                  else if (item.type === 'image_url' && item.image_url?.url) {
                    const u = item.image_url.url;
                    const match = u.match(/^data:([^;]+);base64,(.*)$/);
                    if (match) {
                      parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
                    }
                  }
                }
              }
              if (parts.length > 0) {
                geminiContents.push({
                  role: m.role === 'assistant' ? 'model' : 'user',
                  parts
                });
              }
            }
          }

          if (geminiContents.length === 0) {
            geminiContents.push({ role: 'user', parts: [{ text: 'Hello' }] });
          }

          const geminiBody = {
            contents: geminiContents,
            ...(systemInstructionText ? { systemInstruction: { parts: [{ text: systemInstructionText }] } } : {}),
            generationConfig: {
              temperature: 0.65,
              topP: 0.90,
              topK: 64,
              maxOutputTokens: 8192,
              frequencyPenalty: 0.6,
              presencePenalty: 0.4,
              ...(req.body.thinking === false ? { thinkingConfig: { thinkingBudget: 0 } } : {})
            },
            safetySettings: [
              { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
              { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
              { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
              { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
            ]
          };

          const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(geminiBody),
            signal: fetchController.signal
          });
          clearTimeout(timeoutId);
          abortController.signal.removeEventListener('abort', onAbort);
          return r;
        } else {
          const h = { 'Content-Type': 'application/json' };
          if (key) h['Authorization'] = `Bearer ${key}`;

          const safeMessagesWithIdentity = [...safeMessages];
          const sysIdx = safeMessagesWithIdentity.findIndex(m => m.role === 'system');
          if (sysIdx >= 0) {
            safeMessagesWithIdentity[sysIdx] = {
              ...safeMessagesWithIdentity[sysIdx],
              content: modelIdentityDirective + '\n\n' + (typeof safeMessagesWithIdentity[sysIdx].content === 'string' ? safeMessagesWithIdentity[sysIdx].content : '')
            };
          } else {
            safeMessagesWithIdentity.unshift({ role: 'system', content: modelIdentityDirective });
          }

          const p = {
            model: modName,
            messages: safeMessagesWithIdentity,
            stream: true,
            temperature: 0.65,
            top_p: 0.90,
            frequency_penalty: 0.6,
            presence_penalty: 0.4
          };
          if (req.body.thinking === false) {
            p.reasoning_effort = 'none';
          }

          const lowerMod = modName.toLowerCase();
          if (lowerMod.includes('gpt')) {
            p.max_tokens = 4096;
          } else {
            p.max_tokens = 8192;
          }

          const r = await fetch(url, {
            method: 'POST',
            headers: h,
            body: JSON.stringify(p),
            signal: fetchController.signal
          });
          clearTimeout(timeoutId);
          abortController.signal.removeEventListener('abort', onAbort);
          return r;
        }
      } catch (err) {
        clearTimeout(timeoutId);
        abortController.signal.removeEventListener('abort', onAbort);
        console.warn(`[Fetch Attempt Error] ${url} (${modName}):`, err.message);
        return null;
      }
    };

    // Primary model attempt
    let response = await tryFetchTarget(providerType, targetUrl, targetKey, actualModel, 60000);
    let effectiveModel = cleanModel || safeDisplayName;
    let isGeminiStream = (providerType === 'gemini');

    // Helper to resolve an internal API tier or reference model
    const resolveTierTarget = async (tierModelId, tierUrl, tierKey) => {
      const cleanModId = (tierModelId || '').trim();
      const cleanUrl = (tierUrl || '').trim();
      const cleanKey = (tierKey || '').trim();
      if (!cleanModId && !cleanUrl) return null;

      // Check if tierModelId refers to another saved model configuration in DB
      let refModelConfig = null;
      if (cleanModId && cleanModId !== cleanModel) {
        if (getIsMongoConnected()) {
          refModelConfig = await AiModel.findOne({ $or: [{ model_id: cleanModId }, { id: cleanModId }] });
          if (refModelConfig && !refModelConfig.api_key) {
            const supabaseConfig = await getModelConfig(cleanModId);
            if (supabaseConfig && supabaseConfig.api_key) {
              refModelConfig = { ...refModelConfig.toObject(), api_key: supabaseConfig.api_key };
            }
          }
        } else {
          refModelConfig = await getModelConfig(cleanModId);
        }
      }

      const effectiveMod = cleanModId || (refModelConfig?.api_model_1 || refModelConfig?.model_id) || actualModel;
      const effectiveUrl = cleanUrl || (refModelConfig ? refModelConfig.base_url : (aiModelConfig?.base_url || ''));
      const effectiveKey = cleanKey || (refModelConfig ? refModelConfig.api_key : (!cleanUrl ? (aiModelConfig?.api_key || '') : ''));

      return await resolveModelTarget(effectiveMod, effectiveUrl, effectiveKey, refModelConfig || null);
    };

    // 1. First failover: Attempt Internal Fallback API 2 (Fallback 1)
    if (!response || !response.ok) {
      const fb1Model = (aiModelConfig?.api_model_2 || aiModelConfig?.fallback_model_1 || '').trim();
      const fb1Url = (aiModelConfig?.fallback_url_1 || '').trim();
      const fb1Key = (aiModelConfig?.fallback_key_1 || '').trim();

      if ((fb1Model || fb1Url) && !(res.writableEnded || res.destroyed)) {
        console.warn(`[Chat Primary Failed] Model ${cleanModel} (status: ${response ? response.status : 'timeout'}), trying internal Fallback API 2 (${fb1Model || actualModel})...`);
        const fb1 = await resolveTierTarget(fb1Model, fb1Url, fb1Key);
        if (fb1) {
          const fb1Resp = await tryFetchTarget(fb1.providerType, fb1.targetUrl, fb1.targetKey, fb1.actualModel, 20000);
          if (fb1Resp && fb1Resp.ok) {
            console.log(`[Chat Internal API 2 Success] Model ${cleanModel} cleanly recovered using internal API 2 (${fb1.actualModel})`);
            response = fb1Resp;
            effectiveModel = cleanModel;
            isGeminiStream = (fb1.providerType === 'gemini');
          }
        }
      }
    }

    // 2. Second failover: Attempt Internal Fallback API 3 (Fallback 2)
    if (!response || !response.ok) {
      const fb2Model = (aiModelConfig?.api_model_3 || aiModelConfig?.fallback_model_2 || '').trim();
      const fb2Url = (aiModelConfig?.fallback_url_2 || '').trim();
      const fb2Key = (aiModelConfig?.fallback_key_2 || '').trim();

      if ((fb2Model || fb2Url) && !(res.writableEnded || res.destroyed)) {
        console.warn(`[Chat Fallback 1 Failed] Model ${cleanModel}, trying internal Fallback API 3 (${fb2Model || actualModel})...`);
        const fb2 = await resolveTierTarget(fb2Model, fb2Url, fb2Key);
        if (fb2) {
          const fb2Resp = await tryFetchTarget(fb2.providerType, fb2.targetUrl, fb2.targetKey, fb2.actualModel, 20000);
          if (fb2Resp && fb2Resp.ok) {
            console.log(`[Chat Internal API 3 Success] Model ${cleanModel} cleanly recovered using internal API 3 (${fb2.actualModel})`);
            response = fb2Resp;
            effectiveModel = cleanModel;
            isGeminiStream = (fb2.providerType === 'gemini');
          }
        }
      }
    }

    // 3. Only use env fallback when the model exists in Admin list with NO custom Admin URL/key configured; never silently impersonate deleted/unconfigured or custom models
    const isCustomAdminConfigured = Boolean(aiModelConfig && (aiModelConfig.base_url || aiModelConfig.api_key || aiModelConfig.fallback_url_1 || aiModelConfig.fallback_model_1));
    if ((!response || !response.ok) && aiModelConfig && !isCustomAdminConfigured) {
      const groqKey = process.env.GROQ_API_KEY || DEFAULT_GROQ_KEY;
      const openRouterKey = process.env.OPENROUTER_API_KEY || DEFAULT_OPENROUTER_KEY;
      const envFallbacks = [
        groqKey ? { id: 'openai/gpt-oss-120b', type: 'groq', url: 'https://api.groq.com/openai/v1/chat/completions', key: groqKey, model: 'openai/gpt-oss-120b' } : null,
        openRouterKey ? { id: 'openrouter/free', type: 'openrouter', url: 'https://openrouter.ai/api/v1/chat/completions', key: openRouterKey, model: 'openrouter/free' } : null
      ].filter(fb => fb && fb.id !== cleanModel);

      for (const fb of envFallbacks) {
        if (res.writableEnded || res.destroyed) break;
        const fbResp = await tryFetchTarget(fb.type, fb.url, fb.key, fb.model, 10000);
        if (fbResp && fbResp.ok) {
          response = fbResp;
          effectiveModel = fb.id;
          isGeminiStream = false;
          break;
        }
      }
    }

    if (res.writableEnded || res.destroyed) {
      return;
    }

    // Surface clean MODEL_BUSY / not-found response so UI renders the Model Busy card & Retry button without leaking internal provider/model names
    if (!aiModelConfig) {
      const publicModLabel = getSafeModelDisplayName(cleanModel);
      return res.status(404).json({
        success: false,
        code: 'MODEL_BUSY',
        model: publicModLabel,
        error: `মডেলটি বর্তমানে সক্রিয় নেই (${publicModLabel})। অনুগ্রহ করে তালিকা থেকে অন্য সক্রিয় মডেল বেছে নিন।`
      });
    }
    if (!response || !response.ok) {
      const status = response ? response.status : 504;
      const modelDisplayName = safeDisplayName || 'Alora AI';
      let userSafeError = `মডেলটি বর্তমানে ব্যস্ত আছে (${modelDisplayName})। অনুগ্রহ করে কিছুক্ষণ পর আবার চেষ্টা করুন অথবা অন্য মডেল নির্বাচন করুন।`;
      if (status === 429) {
        userSafeError = `মডেলটি বর্তমানে অনুরোধের আধিক্যের কারণে ব্যস্ত আছে (${modelDisplayName})। অনুগ্রহ করে কিছুক্ষণ পর আবার চেষ্টা করুন।`;
      }
      return res.status(status >= 400 && status < 600 ? status : 503).json({
        success: false,
        code: 'MODEL_BUSY',
        model: modelDisplayName,
        error: sanitizePublicErrorMessage(userSafeError, modelDisplayName)
      });
    }

    // Model is verified healthy and responding: Now establish SSE streaming
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (res.flushHeaders) res.flushHeaders();
    res.write(': keepalive\n\n');

    const keepAliveInterval = setInterval(() => {
      if (!res.writableEnded) {
        try {
          res.write(': keepalive\n\n');
          if (typeof res.flush === 'function') res.flush();
        } catch {}
      }
    }, 15000);

    let hasStreamedData = false;
    let hasContentTokens = false;
    let streamIdleTimeout = null;

    const resetStreamIdleWatchdog = () => {
      if (streamIdleTimeout) clearTimeout(streamIdleTimeout);
      streamIdleTimeout = setTimeout(() => {
        console.warn('[Stream Watchdog]: Inactivity timeout reached (300s), terminating stream.');
        if (response && response.body && typeof response.body.destroy === 'function') {
          try { response.body.destroy(); } catch {}
        }
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ error: 'স্ট্রিম সময়সীমা অতিক্রম করেছে।' })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        }
      }, 300000);
    };

    // Arm watchdog immediately so hanging connections timeout even before first byte
    resetStreamIdleWatchdog();

    return new Promise((resolve) => {
      let isResolved = false;
      const onClientClose = () => {
        if (response && response.body && typeof response.body.destroy === 'function') {
          try { response.body.destroy(); } catch {}
        }
        safeResolve();
      };
      res.on('close', onClientClose);

      const safeResolve = () => {
        if (!isResolved) {
          isResolved = true;
          if (keepAliveInterval) clearInterval(keepAliveInterval);
          if (streamIdleTimeout) clearTimeout(streamIdleTimeout);
          if (typeof res.removeListener === 'function') {
            res.removeListener('close', onClientClose);
          }
          resolve();
        }
      };

      let geminiLineBuffer = '';
      let openAiLineBuffer = '';
      let accumulatedStreamContent = '';
      const DEFAULT_TAIL_HOLD = 64;
      const SUSPICIOUS_TAIL_HOLD = 240;
      let contentTail = '';
      let reasoningTail = '';
      let inInlineThink = false;

      const SUSPICIOUS_TAIL_RE = /(===|Keep\s+n|No\s+m|by\s+Zihan|MANDATORY|STRICT|CRITICAL|Internal\s+Assistant|system\s+p|developer\s+p|<think|<\/think|gemini|openai|chatgpt|claude|deepseek|qwen|anthropic)/i;

      const sanitizeSegmentWithInlineThink = (text, startInThink) => {
        const parts = String(text || '').split(/(<\/?think>)/gi);
        let localThink = startInThink;
        let out = '';
        for (const part of parts) {
          if (!part) continue;
          const lowerPart = part.toLowerCase();
          if (lowerPart === '<think>') {
            localThink = true;
            out += part;
          } else if (lowerPart === '</think>') {
            localThink = false;
            out += part;
          } else {
            out += sanitizeModelIdentityText(part, safeDisplayName, {
              isReasoning: localThink,
              extraBlockedPatterns
            });
          }
        }
        return out.replace(/<think>\s*<\/think>\s*/gi, '');
      };

      const advanceThinkState = (emittedChunk, currentThink) => {
        let nextThink = currentThink;
        const tags = String(emittedChunk || '').match(/<\/?think>/gi);
        if (tags) {
          for (const tg of tags) {
            nextThink = tg.toLowerCase() === '<think>';
          }
        }
        return nextThink;
      };

      const computeSafeCutIndex = (str, holdLen) => {
        let cutIdx = str.length - holdLen;
        if (cutIdx <= 0) return 0;
        // Never split across a partial <think> or </think> tag boundary
        const lookBackStart = Math.max(0, cutIdx - 8);
        const partialIdx = str.indexOf('<', lookBackStart);
        if (partialIdx !== -1 && partialIdx < cutIdx && partialIdx + 9 >= cutIdx) {
          const slice = str.slice(partialIdx).toLowerCase();
          if ('<think>'.startsWith(slice.slice(0, '<think>'.length)) || '</think>'.startsWith(slice.slice(0, '</think>'.length))) {
            cutIdx = partialIdx;
          }
        }
        return cutIdx;
      };

      const writeNormalizedDelta = (field, piece) => {
        if (!piece || res.writableEnded || res.destroyed) return;
        res.write(`data: ${JSON.stringify({ model: safeDisplayName, choices: [{ delta: { [field]: piece } }] })}\n\n`);
        if (typeof res.flush === 'function') res.flush();
      };

      const pushSanitizedDelta = (field, rawText) => {
        if (!rawText) return;
        if (field === 'reasoning_content') {
          if (req.body.thinking === false) return;
          reasoningTail = sanitizeModelIdentityText(reasoningTail + rawText, safeDisplayName, {
            isReasoning: true,
            extraBlockedPatterns
          });
          const holdLen = SUSPICIOUS_TAIL_RE.test(reasoningTail) ? SUSPICIOUS_TAIL_HOLD : 128;
          if (reasoningTail.length > holdLen) {
            const emit = reasoningTail.slice(0, reasoningTail.length - holdLen);
            reasoningTail = reasoningTail.slice(reasoningTail.length - holdLen);
            writeNormalizedDelta('reasoning_content', emit);
          }
        } else {
          contentTail = sanitizeSegmentWithInlineThink(contentTail + rawText, inInlineThink);
          const holdLen = (inInlineThink || SUSPICIOUS_TAIL_RE.test(contentTail)) ? SUSPICIOUS_TAIL_HOLD : DEFAULT_TAIL_HOLD;
          if (contentTail.length > holdLen) {
            const cutIdx = computeSafeCutIndex(contentTail, holdLen);
            if (cutIdx > 0) {
              const emit = contentTail.slice(0, cutIdx);
              contentTail = contentTail.slice(cutIdx);
              inInlineThink = advanceThinkState(emit, inInlineThink);
              writeNormalizedDelta('content', emit);
            }
          }
        }
      };

      const flushSanitizedTails = () => {
        if (reasoningTail) {
          const cleanR = sanitizeModelIdentityText(reasoningTail, safeDisplayName, {
            isReasoning: true,
            extraBlockedPatterns
          });
          if (cleanR.trim()) writeNormalizedDelta('reasoning_content', cleanR);
          reasoningTail = '';
        }
        if (contentTail) {
          const cleanC = sanitizeSegmentWithInlineThink(contentTail, inInlineThink);
          inInlineThink = advanceThinkState(cleanC, inInlineThink);
          if (cleanC) writeNormalizedDelta('content', cleanC);
          contentTail = '';
        }
      };

      const processGeminiLine = (line) => {
        const trimmed = String(line || '').trim();
        if (!trimmed.startsWith('data:')) return false;
        const dataStr = trimmed.slice(5).trim();
        if (!dataStr || dataStr === '[DONE]') return false;
        try {
          const json = JSON.parse(dataStr);
          if (json?.promptFeedback?.blockReason) {
            const blockNotice = 'দুঃখিত, নিরাপত্তাজনিত কারণে এই অনুরোধটির উত্তর দেওয়া সম্ভব হচ্ছে না। অনুগ্রহ করে অন্যভাবে জিজ্ঞেস করুন।';
            hasContentTokens = true;
            pushSanitizedDelta('content', blockNotice);
          }

          const candidate = json?.candidates?.[0];
          if (candidate?.finishReason === 'SAFETY' && !hasContentTokens) {
            const blockNotice = 'দুঃখিত, নিরাপত্তাজনিত কারণে এই অনুরোধটির উত্তর দেওয়া সম্ভব হচ্ছে না। অনুগ্রহ করে প্রম্পটটি পরিবর্তন করে আবার চেষ্টা করুন।';
            hasContentTokens = true;
            pushSanitizedDelta('content', blockNotice);
          }

          const parts = candidate?.content?.parts;
          if (Array.isArray(parts)) {
            for (const p of parts) {
              if (p && p.text) {
                hasContentTokens = true;
                accumulatedStreamContent += p.text;
                if (detectRepetitionDegeneracy(accumulatedStreamContent)) {
                  return true;
                }
                pushSanitizedDelta('content', p.text);
              }
            }
          }
        } catch (pe) {}
        return false;
      };

      const processOpenAiLine = (line) => {
        const trimmed = String(line || '').trim();
        if (!trimmed.startsWith('data:')) return false;
        const dataStr = trimmed.slice(5).trim();
        if (!dataStr || dataStr === '[DONE]') return false;
        try {
          const json = JSON.parse(dataStr);
          if (json?.error) {
            const rawMsg = typeof json.error === 'string' ? json.error : (json.error.message || '');
            const cleanErr = sanitizePublicErrorMessage(rawMsg || 'মডেলটি বর্তমানে ব্যস্ত আছে।', safeDisplayName);
            res.write(`data: ${JSON.stringify({ error: cleanErr })}\n\n`);
            if (typeof res.flush === 'function') res.flush();
            return false;
          }
          const choice = json?.choices?.[0];
          const delta = choice?.delta;
          const rText = delta?.reasoning_content ?? delta?.reasoning ?? '';
          const cText = delta?.content ?? delta?.text ?? choice?.text ?? '';

          if (rText) {
            hasContentTokens = true;
            accumulatedStreamContent += rText;
            if (detectRepetitionDegeneracy(accumulatedStreamContent)) return true;
            pushSanitizedDelta('reasoning_content', rText);
          }
          if (cText) {
            hasContentTokens = true;
            accumulatedStreamContent += cText;
            if (detectRepetitionDegeneracy(accumulatedStreamContent)) return true;
            pushSanitizedDelta('content', cText);
          }
        } catch (pe) {}
        return false;
      };

      response.body.on('data', (chunk) => {
        hasStreamedData = true;
        resetStreamIdleWatchdog();

        try {
          if (isGeminiStream) {
            geminiLineBuffer += chunk.toString('utf8');
            const lines = geminiLineBuffer.split('\n');
            geminiLineBuffer = lines.pop();

            for (const line of lines) {
              if (processGeminiLine(line)) {
                console.warn('[Stream Watchdog] Repetition loop detected in stream, closing safely.');
                flushSanitizedTails();
                try {
                  if (typeof response.body?.destroy === 'function') response.body.destroy();
                } catch (e) {}
                if (!res.writableEnded) {
                  res.write('data: [DONE]\n\n');
                  if (typeof res.flush === 'function') res.flush();
                }
                safeResolve();
                return;
              }
            }
          } else {
            openAiLineBuffer += chunk.toString('utf8');
            const lines = openAiLineBuffer.split('\n');
            openAiLineBuffer = lines.pop();

            for (const line of lines) {
              if (processOpenAiLine(line)) {
                console.warn('[Stream Watchdog] Repetition loop detected from upstream model, truncating and closing stream safely.');
                flushSanitizedTails();
                try {
                  if (typeof response.body?.destroy === 'function') response.body.destroy();
                } catch (e) {}
                if (!res.writableEnded) {
                  res.write('data: [DONE]\n\n');
                  if (typeof res.flush === 'function') res.flush();
                }
                safeResolve();
                return;
              }
            }
          }
        } catch (e) {
          safeResolve();
        }
      });

      response.body.on('end', async () => {
        try {
          if (isGeminiStream && geminiLineBuffer && geminiLineBuffer.trim()) {
            processGeminiLine(geminiLineBuffer);
            geminiLineBuffer = '';
          } else if (!isGeminiStream && openAiLineBuffer && openAiLineBuffer.trim()) {
            processOpenAiLine(openAiLineBuffer);
            openAiLineBuffer = '';
          }
          flushSanitizedTails();

          // Record usage log only after stream successfully delivers tokens
          if (hasContentTokens) {
            const userId = user ? String(user._id || user.id) : req.guestId;
            if (userId) {
              if (getIsMongoConnected()) {
                UsageLog.create({
                  user_id: userId,
                  model_id: effectiveModel || cleanModel || safeDisplayName,
                  timestamp: new Date()
                }).catch(err => console.error('[UsageLog Write Error]:', err.message));
                incrementUserUsage(userId, req.currentPlan ? req.currentPlan.window_hours : 3).catch(() => {});
              } else {
                memoryStore.usageLogs.push({
                  _id: 'log_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
                  user_id: userId,
                  model_id: effectiveModel || model || safeDisplayName,
                  timestamp: new Date()
                });
                if (memoryStore.usageLogs.length > 5000) {
                  memoryStore.usageLogs = memoryStore.usageLogs.slice(-5000);
                }
                debouncedSave();
                incrementUserUsage(userId, req.currentPlan ? req.currentPlan.window_hours : 3).catch(e => {
                  console.error('[Increment User Usage Error]:', e.message);
                });
              }
            }
          }
        } catch (streamErr) {
          console.error('[Stream End Callback Error]:', streamErr.message);
        } finally {
          if (!res.writableEnded) {
            res.write('data: [DONE]\n\n');
            res.end();
          }
          safeResolve();
        }
      });

      response.body.on('error', (err) => {
        console.error('[Stream Error]:', err.message);
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ error: 'স্ট্রিম সংযোগে সমস্যা হয়েছে।' })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        }
        safeResolve();
      });
    });

  } catch (error) {
    console.error('[Chat Completion Error]:', error.message);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, error: 'সার্ভারে চ্যাট সম্পন্ন করতে সমস্যা হয়েছে।' });
    } else if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: 'সার্ভারে সমস্যা হয়েছে।' })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
};



// Helper for constructing Pollinations AI image URLs
function buildPollinationsUrl(cleanPrompt, imageModel = 'flux', imageSize = '1024x1024', enhance = true) {
  let width = 1024;
  let height = 1024;
  if (imageSize && imageSize.includes('x')) {
    const parts = imageSize.split('x').map(p => parseInt(p, 10));
    if (!isNaN(parts[0]) && parts[0] > 0) width = parts[0];
    if (!isNaN(parts[1]) && parts[1] > 0) height = parts[1];
  }

  // Determine pollinations model name
  let modelName = 'flux';
  const cleanMod = String(imageModel || '').toLowerCase().trim();
  if (cleanMod.startsWith('pollinations/')) {
    modelName = cleanMod.replace('pollinations/', '').trim() || 'flux';
  } else if (['flux', 'flux-realism', 'flux-anime', 'flux-3d', 'flux-cablyai', 'turbo', 'midjourney', 'sana'].includes(cleanMod)) {
    modelName = cleanMod;
  }

  const encoded = encodeURIComponent(cleanPrompt);
  const randomSeed = Math.floor(Math.random() * 1000000000);
  const enhanceParam = enhance ? '&enhance=true' : '&enhance=false';
  return {
    url: `https://image.pollinations.ai/prompt/${encoded}?model=${modelName}&width=${width}&height=${height}&nologo=true&seed=${randomSeed}&noredirect=true${enhanceParam}`,
    model: `pollinations/${modelName}`,
    provider: 'pollinations.ai'
  };
}

// Helper for executing image generation via configured provider/model
async function executeImageGeneration(prompt, forcedSettings = null) {
  const { getSystemSettings, getApiKeyFromSupabase } = require('../../utils/getModelConfig');
  const baseSettings = await getSystemSettings();
  const settings = forcedSettings ? { ...baseSettings, ...forcedSettings } : baseSettings;
  const cleanPrompt = String(prompt || '').trim().slice(0, 1000);
  if (!cleanPrompt) throw new Error('অনুগ্রহ করে একটি সঠিক প্রম্পট প্রদান করুন।');

  const imageModel = String(settings.image_model || 'pollinations/flux').trim();
  const targetUrl = String(settings.image_api_url || 'https://image.pollinations.ai/prompt').trim();
  const imageSize = String(settings.image_size || '1024x1024').trim();

  // Check if provider or model is Pollinations
  const isPollinations = (
    imageModel.toLowerCase().includes('pollinations') ||
    targetUrl.toLowerCase().includes('pollinations') ||
    ['flux', 'flux-realism', 'flux-anime', 'flux-3d', 'flux-cablyai', 'turbo', 'midjourney', 'sana'].includes(imageModel.toLowerCase())
  );

  // Pollinations Free Unlimited Generator
  if (isPollinations) {
    return buildPollinationsUrl(cleanPrompt, imageModel, imageSize, settings.image_enhance !== false);
  }

  // Upstream Paid API Providers (OpenAI, VyceAI, Fal.ai, etc.)
  let targetKey = String(settings.image_api_key || process.env.IMAGE_API_KEY || process.env.VYCE_API_KEY || process.env.OPENROUTER_API_KEY || '').trim();
  if (!targetKey) {
    targetKey = (await getApiKeyFromSupabase('__image_key__')) || (await getApiKeyFromSupabase('__vyce_key__')) || (await getApiKeyFromSupabase('claude-sonnet-4-6')) || (await getApiKeyFromSupabase('__openrouter_key__')) || (await getApiKeyFromSupabase('openrouter/free'));
  }

  // If no API key configured for upstream provider, gracefully fall back to Pollinations AI
  if (!targetKey) {
    console.log('[Image Gen] No API key configured for upstream provider, falling back to Pollinations AI...');
    return buildPollinationsUrl(cleanPrompt, 'flux', imageSize, true);
  }

  const reqPayload = {
    prompt: cleanPrompt,
    n: 1,
    size: imageSize
  };
  if (imageModel && imageModel !== 'default' && imageModel !== 'vyceai-default') {
    reqPayload.model = imageModel;
  }

  const imgAbortController = new AbortController();
  const imgTimeout = setTimeout(() => imgAbortController.abort(), 35000);

  let response;
  try {
    response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${targetKey}`
      },
      body: JSON.stringify(reqPayload),
      signal: imgAbortController.signal
    });
  } catch (fetchErr) {
    clearTimeout(imgTimeout);
    console.warn('[Image Gen Upstream Fetch Error, falling back to Pollinations]:', fetchErr.message);
    return buildPollinationsUrl(cleanPrompt, 'flux', imageSize, true);
  }
  clearTimeout(imgTimeout);

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    console.error('[Image Gen Upstream Error]:', response.status, errText.slice(0, 250));
    console.log('[Image Gen] Falling back to Pollinations AI...');
    return buildPollinationsUrl(cleanPrompt, 'flux', imageSize, true);
  }

  const data = await response.json().catch(() => null);
  const item = data?.data?.[0];
  if (item?.url) {
    return { url: item.url, model: imageModel };
  } else if (item?.b64_json) {
    return { url: `data:image/png;base64,${item.b64_json}`, model: imageModel };
  } else if (data?.url) {
    return { url: data.url, model: imageModel };
  } else if (Array.isArray(data?.images) && data.images[0]) {
    return { url: data.images[0], model: imageModel };
  }

  // Fallback to Pollinations if upstream returns invalid structure
  return buildPollinationsUrl(cleanPrompt, 'flux', imageSize, true);
}

const generateImage = async (req, res) => {
  try {
    const { prompt, size, style, model, enhance } = req.body;
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ success: false, error: 'অনুগ্রহ করে একটি সঠিক প্রম্পট প্রদান করুন।' });
    }

    const imgSafety = inspectPromptSafety(prompt);
    if (imgSafety.blocked) {
      return res.status(400).json({ success: false, code: 'SAFETY_BLOCKED', error: imgSafety.message });
    }

    let finalPrompt = prompt.trim();
    
    // Optionally enhance and translate the prompt to English when enhance is not disabled
    if (enhance !== false) {
      try {
        const persistedModels = await getPersistedModels();
        const geminiModelCfg = (persistedModels || []).find(m => m && m.is_active !== false && /gemini/i.test(String(m.base_url || '') + String(m.model_id || '')));
        const geminiKey = (geminiModelCfg && geminiModelCfg.api_key && !geminiModelCfg.api_key.startsWith('sk-placeholder'))
          ? geminiModelCfg.api_key
          : (process.env.GEMINI_API_KEY || (process.env.GEMINI_API_KEYS ? process.env.GEMINI_API_KEYS.split(',')[0].trim() : '') || DEFAULT_GEMINI_KEY || (await getApiKeyFromSupabase('__gemini_key__')));
        if (geminiKey) {
          const enhModel = (geminiModelCfg && geminiModelCfg.model_id && !geminiModelCfg.model_id.includes('/')) ? geminiModelCfg.model_id : 'gemini-2.0-flash';
          const enhController = new AbortController();
          const enhTimeout = setTimeout(() => enhController.abort(), 8000);
          try {
            const enhanceRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(enhModel)}:generateContent?key=${geminiKey}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [{ text: `You are an expert AI image prompt engineer. The user wants to generate an image based on the following input (it might be in Bengali or English). Translate it to English (if it isn't), and beautifully enhance it into a highly detailed, cinematic, and professional image generation prompt suitable for Midjourney or Flux. Add appropriate descriptors for lighting, camera angle, and atmosphere. Return ONLY the enhanced English prompt without any quotes, conversational text, or explanations. User input: "${finalPrompt}"` }] }]
              }),
              signal: enhController.signal
            });
            clearTimeout(enhTimeout);
            if (enhanceRes.ok) {
              const enhanceData = await enhanceRes.json();
              const enhancedText = enhanceData?.candidates?.[0]?.content?.parts?.[0]?.text;
              if (enhancedText && enhancedText.trim()) {
                finalPrompt = enhancedText.trim();
              }
            }
          } catch (e) {
            clearTimeout(enhTimeout);
            console.warn("[Image Enhancer Timeout/Skip]:", e.message);
          }
        }
      } catch (err) {
        console.warn("[Image Enhancer Error]:", err.message);
      }
    }

    if (style && typeof style === 'string' && style.trim()) {
      finalPrompt = `${finalPrompt}, in ${style.trim()} style, highly detailed, beautiful lighting, cinematic composition`;
    }

    const forcedSettings = {};
    if (size && typeof size === 'string') forcedSettings.image_size = size.trim();
    if (model && typeof model === 'string') forcedSettings.image_model = model.trim();
    if (enhance !== undefined) forcedSettings.image_enhance = !!enhance;

    const imgResult = await executeImageGeneration(finalPrompt, Object.keys(forcedSettings).length ? forcedSettings : null);

    // Record usage log for image generation
    const userId = req.user ? String(req.user._id || req.user.id) : (req.guestId ? String(req.guestId) : null);
    if (userId) {
      if (getIsMongoConnected()) {
        UsageLog.create({
          user_id: userId,
          model_id: 'image-generation',
          timestamp: new Date()
        }).catch(() => {});
      } else {
        memoryStore.usageLogs.push({
          _id: 'log_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          user_id: userId,
          model_id: 'image-generation',
          timestamp: new Date()
        });
        if (memoryStore.usageLogs.length > 5000) {
          memoryStore.usageLogs = memoryStore.usageLogs.slice(-5000);
        }
        debouncedSave();
      }
      const { incrementUserImageUsage } = require('../../utils/getModelConfig');
      incrementUserImageUsage(userId, req.currentPlan ? req.currentPlan.window_hours : 3).catch(() => {});
    }

    return res.json({ success: true, url: imgResult.url, model: 'Alora Image' });
  } catch (error) {
    console.error('[Image Gen Error]:', error.message);
    const errMsg = String(error.message || '');
    const statusCode = errMsg.includes('কনফিগার করা হয়নি') ? 503 : (errMsg.includes('অতিরিক্ত সময়') ? 504 : 500);
    return res.status(statusCode).json({
      success: false,
      error: sanitizePublicErrorMessage(errMsg, 'Alora Image') || 'ছবি তৈরি করতে সমস্যা হয়েছে।'
    });
  }
};

module.exports = { streamChatCompletions, generateImage, executeImageGeneration };


