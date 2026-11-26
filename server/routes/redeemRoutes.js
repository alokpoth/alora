const express = require('express');
const router = express.Router();
const { claimRedeemCode } = require('../controllers/redeemController');
const { getPromo, claimFreeTrial } = require('../controllers/trialController');
const { protect, optionalProtect } = require('../middleware/authMiddleware');
const { createRateLimiter } = require('../middleware/ipRateLimiter');

const claimLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: 'অতিরিক্ত রিডিম/ট্রায়াল অনুরোধ। অনুগ্রহ করে ১৫ মিনিট পর আবার চেষ্টা করুন।'
});

router.get('/promo', optionalProtect, getPromo);
router.post('/trial', claimLimiter, protect, claimFreeTrial);
router.post('/claim', claimLimiter, protect, claimRedeemCode);
// Backward-compatible alias for POST /api/redeem
router.post('/', claimLimiter, protect, claimRedeemCode);

module.exports = router;
