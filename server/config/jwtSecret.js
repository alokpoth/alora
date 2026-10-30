const crypto = require('crypto');

// Never fall back to a literal from source control: a published signing key lets anyone mint
// valid tokens (including admin tokens). If the environment does not provide JWT_SECRET we use a
// random per-process secret and warn loudly, so a misconfigured deployment refuses to be forged
// rather than failing to boot.
const envSecret = String(process.env.JWT_SECRET || '').trim();
if (!envSecret) {
  console.warn('[Config] JWT_SECRET is not set. Using a random per-process secret; set JWT_SECRET in the environment (sessions are invalidated on restart until you do).');
}
const JWT_SECRET = envSecret || crypto.randomBytes(48).toString('hex');

module.exports = { JWT_SECRET };
