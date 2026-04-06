const jwt = require('jsonwebtoken');
require('dotenv').config();
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '30d';

/**
 * Generate Access Token (short-lived)
 * @param {Object} payload - User data to encode in token
 * @returns {String} JWT access token
 */
const generateAccessToken = (payload) => {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
    issuer: 'chatface-api'
  });
};

/**
 * Generate Refresh Token (long-lived)
 * @param {Object} payload - User data to encode in token
 * @returns {String} JWT refresh token
 */
const generateRefreshToken = (payload) => {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: JWT_REFRESH_EXPIRES_IN,
    issuer: 'chatface-api'
  });
};

/**
 * Generate both Access and Refresh tokens
 * @param {Object} user - User object
 * @returns {Object} { accessToken, refreshToken }
 */
const generateTokenPair = (user) => {
  const payload = {
    id: user.id,
    email: user.email,
    isGuest: user.is_guest,
    authProvider: user.auth_provider,
    jti: crypto.randomBytes(16).toString('hex')
  };

  return {
    accessToken: generateAccessToken(payload),
    refreshToken: generateRefreshToken(payload)
  };
};

/**
 * Verify JWT token
 * @param {String} token - JWT token to verify
 * @returns {Object} Decoded token payload
 */
const verifyToken = (token) => {
  try {
    return jwt.verify(token, JWT_SECRET, {
      issuer: 'chatface-api'
    });
  } catch (error) {
    throw new Error('Invalid or expired token');
  }
};

/**
 * Decode token without verification (for debugging)
 * @param {String} token - JWT token
 * @returns {Object} Decoded token
 */
const decodeToken = (token) => {
  return jwt.decode(token);
};

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  generateTokenPair,
  verifyToken,
  decodeToken
};
