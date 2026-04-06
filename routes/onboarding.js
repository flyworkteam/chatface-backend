const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const {
  getOnboardingStatus
} = require('../controllers/onboardingController');


/**
 * @route   GET /api/onboarding/status
 * @desc    Get onboarding status
 * @access  Private
 */
router.get(
  '/status',
  authenticateToken,
  getOnboardingStatus
);

module.exports = router;
