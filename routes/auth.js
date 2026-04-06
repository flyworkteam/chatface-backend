const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const { handleValidationErrors } = require('../middleware/validation');
const { authenticateToken } = require('../middleware/auth');
const {
  createGuestUser,
  refreshAccessToken,
  logout,
  googleSignIn,
  appleSignIn,
  getCurrentUser,
} = require('../controllers/authController');

/**
 * @route   POST /api/auth/guest
 * @desc    Create guest user
 * @access  Public
 */
router.post(
  '/guest',
  [
    body('device_info').optional().isObject().withMessage('Device info must be an object')
  ],
  handleValidationErrors,
  createGuestUser
);

/**
 * @route   POST /api/auth/refresh
 * @desc    Refresh access token
 * @access  Public
 */
router.post(
  '/refresh',
  [
    body('refreshToken').notEmpty().withMessage('Refresh token is required')
  ],
  handleValidationErrors,
  refreshAccessToken
);

/**
 * @route   POST /api/auth/logout
 * @desc    Logout user
 * @access  Private
 */
router.post(
  '/logout',
  authenticateToken,
  logout
);

router.get('/me', authenticateToken, getCurrentUser);


/**
 * @route   POST /api/auth/google
 * @desc    Google Sign-In (Mobile SDK - Client Secret gerekmez)
 * @access  Public
 */
router.post(
  '/google',
  [
    body('idToken').notEmpty().withMessage('ID token is required')
  ],
  handleValidationErrors,
  googleSignIn
);

/**
 * @route   POST /api/auth/apple
 * @desc    Apple Sign-In (Native SDK - Bundle ID yeterli!)
 * @access  Public
 */
router.post(
  '/apple',
  [
    body('identityToken').notEmpty().withMessage('Identity token is required')
  ],
  handleValidationErrors,
  appleSignIn
);

module.exports = router;
