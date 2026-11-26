const express = require('express');
const router = express.Router();
const { searchDuckDuckGo } = require('../controllers/searchController');
const { optionalProtect } = require('../middleware/authMiddleware');
const { checkRateLimit } = require('../middleware/rateLimitMiddleware');
const { createRateLimiter } = require('../middleware/ipRateLimiter');

const searchRouteLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 30,
  message: 'অতিরিক্ত ওয়েব সার্চ অনুরোধ করা হয়েছে। এক মিনিট পর চেষ্টা করুন।'
});

router.get('/', searchRouteLimiter, optionalProtect, checkRateLimit, searchDuckDuckGo);

module.exports = router;
