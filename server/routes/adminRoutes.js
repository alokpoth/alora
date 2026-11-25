const express = require('express');
const router = express.Router();
const {
  getAdminStats,
  getUsers,
  deleteUser,
  updateUserPlan,
  updateUserRole,
  toggleBlockUser,
  getPlans,
  updatePlanLimits,
  generateRedeemCodes,
  getRedeemCodes,
  deleteRedeemCode,
  createCustomRedeemCode,
  getModels,
  updateModel,
  addModel,
  deleteModel,
  reorderModels,
  getApiKeys,
  saveApiKey,
  deleteApiKey,
  getSystemLogs,
  getSettings,
  updateSettings,
  testWebSearchSetting,
  testImageGenSetting,
  getPromoCodes,
  createPromoCode,
  deletePromoCode,
  getPaymentOrders,
  approvePaymentOrder,
  rejectPaymentOrder
} = require('../controllers/adminController');
const { protect } = require('../middleware/authMiddleware');
const { adminOnly } = require('../middleware/adminMiddleware');

// All routes are protected by Auth + Admin Role Check
router.use(protect);
router.use(adminOnly);

router.get('/stats', getAdminStats);
router.get('/settings', getSettings);
router.put('/settings', updateSettings);
router.post('/settings/test-search', testWebSearchSetting);
router.post('/settings/test-image', testImageGenSetting);

router.get('/promo-codes', getPromoCodes);
router.post('/promo-codes', createPromoCode);
router.delete('/promo-codes/:codeId', deletePromoCode);

router.get('/orders', getPaymentOrders);
router.put('/orders/:orderId/approve', approvePaymentOrder);
router.put('/orders/:orderId/reject', rejectPaymentOrder);

router.get('/users', getUsers);
router.delete('/users/:userId', deleteUser);
router.put('/users/:userId/plan', updateUserPlan);
router.put('/users/:userId/role', updateUserRole);
router.put('/users/:userId/block', toggleBlockUser);

router.get('/plans', getPlans);
router.put('/plans/:planName', updatePlanLimits);

router.post('/redeem/generate', generateRedeemCodes);
router.post('/redeem/custom', createCustomRedeemCode);
router.get('/redeem/list', getRedeemCodes);
router.delete('/redeem/:codeId', deleteRedeemCode);

router.get('/models', getModels);
router.post('/models', addModel);
router.put('/models/reorder', reorderModels);
router.put('/models/:modelId(*)', updateModel);
router.delete('/models', deleteModel);
router.delete('/models/:modelId(*)', deleteModel);

router.get('/keys', getApiKeys);
router.post('/keys', saveApiKey);
router.delete('/keys/:provider', deleteApiKey);

router.get('/logs', getSystemLogs);

module.exports = router;
