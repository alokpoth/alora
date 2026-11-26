const express = require('express');
const router = express.Router();
const {
  getPaymentConfig,
  validatePromo,
  submitOrder,
  getMyOrders
} = require('../controllers/paymentController');
const { protect } = require('../middleware/authMiddleware');
const { createRateLimiter } = require('../middleware/ipRateLimiter');

const billingActionLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 25,
  message: 'অতিরিক্ত প্রোমো বা অর্ডার অনুরোধ করা হয়েছে। কিছুক্ষণ পর আবার চেষ্টা করুন।'
});

router.get('/config', getPaymentConfig);
router.post('/validate-promo', billingActionLimiter, protect, validatePromo);
router.post('/submit', billingActionLimiter, protect, submitOrder);
router.get('/my-orders', protect, getMyOrders);

module.exports = router;
