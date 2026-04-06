const { pool } = require('../config/database');

/**
 * Apply referral code
 * POST /api/user/apply-referral-code
 * Body: { referral_code: "ABC12345" }
 */
const applyReferralCode = async (req, res, next) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();

    const currentUserId = req.user.id;
    const { referral_code } = req.body;

    // Validate input
    if (!referral_code || typeof referral_code !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Referral Code Required',
        error: {
          type: 'MISSING_REFERRAL_CODE',
          reason: 'The referral_code field is required but was not provided or is invalid.',
          details: {
            requiredField: 'referral_code',
            location: 'body',
            expectedType: 'string (8 characters)'
          },
          suggestion: 'Please provide a valid 8-character referral code.',
          action: 'Add referral_code field to your request body.'
        }
      });
    }

    // Normalize code to uppercase
    const normalizedCode = referral_code.toUpperCase().trim();

    if (normalizedCode.length !== 8) {
      return res.status(400).json({
        success: false,
        message: 'Invalid Referral Code Format',
        error: {
          type: 'INVALID_CODE_FORMAT',
          reason: 'Referral codes must be exactly 8 characters long.',
          details: {
            providedLength: normalizedCode.length,
            expectedLength: 8
          },
          suggestion: 'Check the referral code and try again.',
          action: 'Ensure the code is exactly 8 characters.'
        }
      });
    }

    // Check if current user already used a referral code
    const [currentUser] = await connection.execute(
      'SELECT used_referral_code, invitation_code, is_premium, premium_endtime FROM users WHERE id = ?',
      [currentUserId]
    );

    if (currentUser.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User Not Found',
        error: {
          type: 'USER_NOT_FOUND',
          reason: 'The authenticated user does not exist in the database.'
        }
      });
    }

    const currentUserData = currentUser[0];

    // Check if user already used a referral code
    if (currentUserData.used_referral_code) {
      return res.status(400).json({
        success: false,
        message: 'Referral Code Already Used',
        error: {
          type: 'ALREADY_USED_CODE',
          reason: 'You have already used a referral code.',
          details: {
            usedCode: currentUserData.used_referral_code
          },
          suggestion: 'Each user can only use one referral code.',
          action: 'You cannot use another referral code.'
        }
      });
    }

    // Prevent self-referral
    if (currentUserData.invitation_code === normalizedCode) {
      return res.status(400).json({
        success: false,
        message: 'Cannot Use Your Own Code',
        error: {
          type: 'SELF_REFERRAL_FORBIDDEN',
          reason: 'You cannot use your own invitation code.',
          suggestion: 'Ask a friend to share their referral code with you.',
          action: 'Use a different referral code from another user.'
        }
      });
    }

    // Find the code owner
    const [codeOwner] = await connection.execute(
      'SELECT id, full_name, is_premium, premium_endtime FROM users WHERE invitation_code = ?',
      [normalizedCode]
    );

    if (codeOwner.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Invalid Referral Code',
        error: {
          type: 'CODE_NOT_FOUND',
          reason: 'The provided referral code does not exist.',
          details: {
            providedCode: normalizedCode
          },
          suggestion: 'Double-check the code with your friend and try again.',
          action: 'Ensure you have entered the correct referral code.'
        }
      });
    }

    const codeOwnerData = codeOwner[0];
    const codeOwnerId = codeOwnerData.id;

    // Calculate new premium end times (7 days = 7 * 24 * 60 * 60 * 1000 ms)
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const now = new Date();

    // For current user
    let currentUserPremiumEnd;
    if (!currentUserData.is_premium || !currentUserData.premium_endtime || new Date(currentUserData.premium_endtime) < now) {
      // No active premium - set to 7 days from now
      currentUserPremiumEnd = new Date(now.getTime() + sevenDaysMs);
    } else {
      // Has active premium - extend by 7 days
      currentUserPremiumEnd = new Date(new Date(currentUserData.premium_endtime).getTime() + sevenDaysMs);
    }

    // For code owner
    let codeOwnerPremiumEnd;
    if (!codeOwnerData.is_premium || !codeOwnerData.premium_endtime || new Date(codeOwnerData.premium_endtime) < now) {
      // No active premium - set to 7 days from now
      codeOwnerPremiumEnd = new Date(now.getTime() + sevenDaysMs);
    } else {
      // Has active premium - extend by 7 days
      codeOwnerPremiumEnd = new Date(new Date(codeOwnerData.premium_endtime).getTime() + sevenDaysMs);
    }

    // Update current user: mark code as used and extend premium
    await connection.execute(
      `UPDATE users 
       SET used_referral_code = ?, 
           is_premium = 1, 
           premium_endtime = ?
       WHERE id = ?`,
      [normalizedCode, currentUserPremiumEnd, currentUserId]
    );

    // Update code owner: increment referral count and extend premium
    await connection.execute(
      `UPDATE users 
       SET referral_count = referral_count + 1, 
           is_premium = 1, 
           premium_endtime = ?
       WHERE id = ?`,
      [codeOwnerPremiumEnd, codeOwnerId]
    );

    await connection.commit();

    res.json({
      success: true,
      message: 'Referral code applied successfully! Both you and your friend received 1 week of premium.',
      data: {
        yourPremiumEndTime: currentUserPremiumEnd,
        referrerPremiumEndTime: codeOwnerPremiumEnd,
        referrerName: codeOwnerData.full_name
      }
    });

  } catch (error) {
    await connection.rollback();
    console.error('[applyReferralCode] Error applying referral code:', error);
    
    error.context = {
      operation: 'applyReferralCode',
      reason: 'Failed to apply referral code and extend premium memberships',
      suggestion: 'This could be a temporary database issue. Please try again.'
    };
    
    next(error);
  } finally {
    connection.release();
  }
};

module.exports = {
  applyReferralCode
};
