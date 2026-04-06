const { verifyToken } = require('../utils/jwt');
const { pool } = require('../config/database');

/**
 * Middleware to verify JWT access token
 * Protects routes that require authentication
 */
const authenticateToken = async (req, res, next) => {
  try {
    // Get token from Authorization header
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Access token is required'
      });
    }

    // Verify token
    const decoded = verifyToken(token);

    // Get user from database
    const [users] = await pool.execute(
      'SELECT id, email, full_name, auth_provider, is_guest, is_active, onboarding_completed FROM users WHERE id = ?',
      [decoded.id]
    );

    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const user = users[0];

    // Check if user is active
    if (!user.is_active) {
      return res.status(403).json({
        success: false,
        message: 'User account is inactive'
      });
    }

    // Attach user to request object
    req.user = user;
    req.token = decoded;

    next();
  } catch (error) {
    if (error.message === 'Invalid or expired token') {
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired access token',
        shouldRefresh: true
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Authentication failed',
      error: error.message
    });
  }
};

/**
 * Middleware to check if user has completed onboarding
 */
const requireOnboarding = (req, res, next) => {
  if (!req.user.onboarding_completed) {
    return res.status(403).json({
      success: false,
      message: 'Please complete onboarding first',
      requiresOnboarding: true
    });
  }
  next();
};

/**
 * Middleware to allow only guest users
 */
const guestOnly = (req, res, next) => {
  if (!req.user.is_guest) {
    return res.status(403).json({
      success: false,
      message: 'This endpoint is only for guest users'
    });
  }
  next();
};

/**
 * Middleware to allow only registered (non-guest) users
 */
const registeredOnly = (req, res, next) => {
  if (req.user.is_guest) {
    return res.status(403).json({
      success: false,
      message: 'This endpoint requires a registered account'
    });
  }
  next();
};

module.exports = {
  authenticateToken,
  requireOnboarding,
  guestOnly,
  registeredOnly
};
