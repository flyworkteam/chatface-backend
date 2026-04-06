const crypto = require('crypto');

/**
 * Generate a unique referral/invitation code for a user
 * Format: 8 characters (uppercase letters and numbers)
 * Example: "A7K9XM2P"
 * 
 * @returns {string} A random 8-character referral code
 */
function generateReferralCode() {
  // Characters to use: A-Z and 0-9 (excluding similar looking characters like O/0, I/1, L)
  const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  
  // Generate 8 random characters
  for (let i = 0; i < 8; i++) {
    const randomIndex = crypto.randomInt(0, characters.length);
    code += characters[randomIndex];
  }
  
  return code;
}

/**
 * Generate a unique referral code and verify it doesn't exist in database
 * @param {Object} connection - MySQL connection object
 * @returns {Promise<string>} A unique referral code
 */
async function generateUniqueReferralCode(connection) {
  let code;
  let isUnique = false;
  let attempts = 0;
  const maxAttempts = 10;

  while (!isUnique && attempts < maxAttempts) {
    code = generateReferralCode();
    
    // Check if code already exists
    const [existing] = await connection.execute(
      'SELECT id FROM users WHERE invitation_code = ?',
      [code]
    );
    
    if (existing.length === 0) {
      isUnique = true;
    }
    
    attempts++;
  }

  if (!isUnique) {
    throw new Error('Failed to generate unique referral code after multiple attempts');
  }

  return code;
}

module.exports = {
  generateReferralCode,
  generateUniqueReferralCode
};
