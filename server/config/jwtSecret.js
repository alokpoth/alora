const crypto = require('crypto');
const JWT_SECRET = process.env.JWT_SECRET || 'REDACTED_HISTORICAL_JWT_SECRET';
module.exports = { JWT_SECRET };
