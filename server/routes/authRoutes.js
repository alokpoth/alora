const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');

router.post('/register', authController.registerUser);
router.post('/login', authController.loginUser);
router.get('/me', protect, authController.getMe);
router.put('/me', protect, authController.updateProfile);
router.put('/profile', protect, authController.updateProfile);
router.delete('/me', protect, authController.deleteAccount);
router.delete('/account', protect, authController.deleteAccount);
router.put('/change-password', protect, authController.changePassword);
router.post('/change-password', protect, authController.changePassword);
router.post('/forgot-password', authController.forgotPassword);
router.get('/google', authController.googleAuth);
router.get('/google/callback', authController.googleCallback);

module.exports = router;

