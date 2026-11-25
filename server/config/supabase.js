const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;
let supabaseCircuitOpenUntil = 0;

const resilientSupabaseFetch = async (url, options = {}) => {
  if (Date.now() < supabaseCircuitOpenUntil) {
    throw new Error('Supabase circuit breaker active (unreachable host)');
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 1800);
  if (options.signal) {
    if (options.signal.aborted) {
      clearTimeout(timeoutId);
      controller.abort();
    } else {
      options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
  }
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    // Open circuit breaker for 5 minutes on DNS/network/timeout failure so requests never stall
    supabaseCircuitOpenUntil = Date.now() + 5 * 60 * 1000;
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
};

if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
    global: { fetch: resilientSupabaseFetch }
  });
  console.log('[Supabase] Client initialized with fast timeout & circuit breaker.');
} else {
  console.warn('[Supabase] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing. Supabase disabled, using primary DB / memoryStore.');
}

module.exports = supabase;
