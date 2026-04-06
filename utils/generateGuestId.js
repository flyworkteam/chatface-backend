const { v4: uuidv4 } = require('uuid');

/**
 * Generate unique guest ID
 * Format: guest_[uuid]
 * @returns {String} Unique guest identifier
 */
const generateGuestId = () => {
  return `guest_${uuidv4()}`;
};

/**
 * Generate unique device identifier
 * @param {String} userAgent - Browser/device user agent
 * @param {String} platform - Platform info (optional)
 * @returns {String} Device identifier
 */
const generateDeviceId = (userAgent = '', platform = '') => {
  const crypto = require('crypto');
  const timestamp = Date.now();
  const randomString = Math.random().toString(36).substring(7);
  
  const dataToHash = `${userAgent}-${platform}-${timestamp}-${randomString}`;
  
  return crypto
    .createHash('sha256')
    .update(dataToHash)
    .digest('hex')
    .substring(0, 32);
};

module.exports = {
  generateGuestId,
  generateDeviceId
};
