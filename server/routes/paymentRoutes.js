const express = require('express');
const router = express.Router();
const {
  getPaymentConfig,
  validatePromo,
  submitOrder,
  getMyOrders
} = require('../controllers/paymentController');
const { protect } = require('../middleware/authMiddleware');

router.get('/config', getPaymentConfig);
router.post('/validate-promo', protect, validatePromo);
router.post('/submit', protect, submitOrder);
router.get('/my-orders', protect, getMyOrders);

module.exports = router;
