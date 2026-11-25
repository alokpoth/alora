const express = require('express');
const router = express.Router();
const { claimRedeemCode } = require('../controllers/redeemController');
const { getPromo, claimFreeTrial } = require('../controllers/trialController');
const { protect, optionalProtect } = require('../middleware/authMiddleware');

router.get('/promo', optionalProtect, getPromo);
router.post('/trial', protect, claimFreeTrial);
router.post('/claim', protect, claimRedeemCode);
router.post('/', protect, claimRedeemCode);

module.exports = router;
