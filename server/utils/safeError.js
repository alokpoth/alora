// server/utils/safeError.js
// Logs full diagnostics server-side while preventing internal DB/upstream details from leaking in 500 responses.

const SENSITIVE_PATTERNS = [
  /sk-[a-zA-Z0-9_-]{12,}/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
  /gsk_[a-zA-Z0-9_-]{16,}/g,
  /glpat-[a-zA-Z0-9_-]{12,}/g,
  /Bearer\s+[a-zA-Z0-9._-]+/gi,
  /mongodb(\+srv)?:\/\/[^\s"']+/gi
];

function redactSecrets(text) {
  let out = String(text || '');
  for (const re of SENSITIVE_PATTERNS) {
    out = out.replace(re, '[REDACTED]');
  }
  return out;
}

function sendServerError(res, err, publicMessage = 'Internal server error', tag = '[Server Error]') {
  const safeLog = redactSecrets(err && err.message ? err.message : String(err || 'Unknown error'));
  console.error(tag, safeLog);
  const status = (err && Number.isInteger(err.status) && err.status >= 400 && err.status < 600) ? err.status : 500;
  const exposeDev = process.env.NODE_ENV === 'development' && status === 500 && err && err.message;
  return res.status(status).json({
    success: false,
    error: exposeDev ? redactSecrets(err.message) : publicMessage
  });
}

module.exports = { redactSecrets, sendServerError };
