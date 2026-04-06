const { pool } = require('../config/database');
const { generateTokenPair } = require('../utils/jwt');
const { generateGuestId, generateDeviceId } = require('../utils/generateGuestId');
const { generateUniqueReferralCode } = require('../utils/generateReferralCode');
const { OAuth2Client } = require('google-auth-library');

const normalizeProfilePictureUrls = (value) => {
  if (!value) return [];

  if (Array.isArray(value)) {
    return value.filter((url) => typeof url === 'string' && url.trim());
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.filter((url) => typeof url === 'string' && url.trim());
      }
      return value.trim() ? [value] : [];
    } catch (_) {
      return value.trim() ? [value] : [];
    }
  }

  return [];
};

const mapUserResponse = (user) => ({
  id: user.id,
  email: user.email,
  fullName: user.full_name,
  profilePictureUrls: normalizeProfilePictureUrls(user.profile_picture_urls),
  authProvider: user.auth_provider,
  isGuest: !!user.is_guest,
  onboardingCompleted: !!user.onboarding_completed,
  preferredLanguage: user.preferred_language || 'en',
  onesignalPlayerId: user.onesignal_player_id,
  createdAt: user.created_at,
  updatedAt: user.updated_at,
});

const getCurrentUser = async (req, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized',
      });
    }

    const [users] = await pool.execute('SELECT * FROM users WHERE id = ?', [userId]);
    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    res.json({
      success: true,
      data: {
        user: mapUserResponse(users[0]),
      },
    });
  } catch (error) {
    next(error);
  }
};

const extractSocialProfilePictureUrls = (source) => {
  if (!source) return [];
  if (typeof source === 'string') return normalizeProfilePictureUrls(source);
  if (Array.isArray(source)) return normalizeProfilePictureUrls(source);

  const candidates = [
    source.picture,
    source.pictureUrl,
    source.profilePicture,
    source.profile_picture,
    source.avatar,
    source.photo,
    source.image,
  ];

  return normalizeProfilePictureUrls(candidates.flat().filter(Boolean));
};

/**
 * Create guest user
 * POST /api/auth/guest
 */
const createGuestUser = async (req, res, next) => {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const { device_info } = req.body;
    const userAgent = req.get('user-agent') || '';
    const platform = device_info?.platform || '';

    // Generate guest ID and device ID
    const guestId = generateGuestId();
    const deviceId = generateDeviceId(userAgent, platform);

    // Generate unique referral code
    const referralCode = await generateUniqueReferralCode(connection);

    // Create guest user
    const email = `guest_${Date.now()}@chatface.com`;
    const profilePictureUrls = [];

    const [result] = await connection.execute(
      `INSERT INTO users (email, profile_picture_urls, full_name, auth_provider, is_guest, guest_device_id, provider_id, invitation_code) 
       VALUES (?, ?, ?, 'guest', 1, ?, ?, ?)`,
      [
        email,
        JSON.stringify(profilePictureUrls),
        `Guest ${Date.now()}`,
        deviceId,
        guestId,
        referralCode,
      ]
    );

    const userId = result.insertId;

    // Get created user
    const [users] = await connection.execute(
      'SELECT * FROM users WHERE id = ?',
      [userId]
    );

    const user = users[0];

    // Generate tokens
    const tokens = generateTokenPair(user);

    // Store refresh token
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
    await connection.execute(
      'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)',
      [userId, tokens.refreshToken, expiresAt]
    );

    await connection.commit();

    res.status(201).json({
      success: true,
      message: 'Guest user created successfully',
      data: {
        user: {
          id: user.id,
          email: user.email,
          fullName: user.full_name,
          profilePictureUrls: normalizeProfilePictureUrls(user.profile_picture_urls),
          isGuest: true,
          authProvider: 'guest',
          onboardingCompleted: false
        },
        tokens: {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresIn: '7d'
        }
      }
    });

  } catch (error) {
    await connection.rollback();
    console.error('[createGuestUser] Error creating guest user:', error);

    // Add context to the error
    error.context = {
      operation: 'createGuestUser',
      reason: 'Failed to create guest user account',
      suggestion: 'This is likely a temporary server issue. Please try again.'
    };

    next(error);
  } finally {
    connection.release();
  }
};

/**
 * Refresh access token using refresh token
 * POST /api/auth/refresh
 */
const refreshAccessToken = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({
        success: false,
        message: 'Refresh Token Required',
        error: {
          type: 'MISSING_REFRESH_TOKEN',
          reason: 'The refreshToken field was not provided in the request body.',
          details: {
            requiredField: 'refreshToken',
            location: 'body',
            expectedType: 'string (JWT)'
          },
          suggestion: 'Please include the refresh token that was received during login.',
          action: 'Add refreshToken field to your request body with the token value stored from login.'
        }
      });
    }

    // Verify refresh token from database
    const [tokens] = await pool.execute(
      'SELECT * FROM refresh_tokens WHERE token = ? AND expires_at > NOW()',
      [refreshToken]
    );

    if (tokens.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid or Expired Refresh Token',
        error: {
          type: 'INVALID_REFRESH_TOKEN',
          reason: 'The provided refresh token was not found in the database or has expired.',
          details: {
            tokenStatus: 'Either not found or expired'
          },
          suggestion: 'Your refresh token is no longer valid. This can happen if the token has expired (after 30 days) or if you logged out from all devices.',
          action: 'Please login again to obtain new authentication tokens.'
        },
        requiresReLogin: true
      });
    }

    const tokenData = tokens[0];

    // Get user
    const [users] = await pool.execute(
      'SELECT * FROM users WHERE id = ?',
      [tokenData.user_id]
    );

    if (users.length === 0 || !users[0].is_active) {
      const isInactive = users.length > 0 && !users[0].is_active;
      return res.status(404).json({
        success: false,
        message: isInactive ? 'User Account Inactive' : 'User Not Found',
        error: {
          type: isInactive ? 'ACCOUNT_INACTIVE' : 'USER_NOT_FOUND',
          reason: isInactive
            ? 'Your user account has been deactivated.'
            : 'The user associated with this refresh token no longer exists in the database.',
          details: {
            userId: tokenData.user_id,
            accountStatus: isInactive ? 'inactive' : 'deleted'
          },
          suggestion: isInactive
            ? 'Your account may have been deactivated. Please contact support to reactivate your account.'
            : 'The user account may have been deleted. Please create a new account.',
          action: 'Please contact support or create a new account.'
        },
        requiresReLogin: true
      });
    }

    const user = users[0];

    // Generate new token pair
    const newTokens = generateTokenPair(user);

    // Delete old refresh token and store new one
    await pool.execute('DELETE FROM refresh_tokens WHERE token = ?', [refreshToken]);

    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await pool.execute(
      'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)',
      [user.id, newTokens.refreshToken, expiresAt]
    );

    res.json({
      success: true,
      message: 'Token refreshed successfully',
      data: {
        tokens: {
          accessToken: newTokens.accessToken,
          refreshToken: newTokens.refreshToken,
          expiresIn: '7d'
        }
      }
    });

  } catch (error) {
    next(error);
  }
};

/**
 * Logout user
 * POST /api/auth/logout
 */
const logout = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    const userId = req.user.id;

    // Delete refresh token(s)
    if (refreshToken) {
      await pool.execute('DELETE FROM refresh_tokens WHERE token = ?', [refreshToken]);
    } else {
      // Delete all refresh tokens for this user
      await pool.execute('DELETE FROM refresh_tokens WHERE user_id = ?', [userId]);
    }

    // Clear OneSignal player ID (user won't receive notifications)
    await pool.execute(
      'UPDATE users SET onesignal_player_id = NULL WHERE id = ?',
      [userId]
    );

    res.json({
      success: true,
      message: 'Logged out successfully'
    });

  } catch (error) {
    next(error);
  }
};



/**
 * Google Sign-In 
 * POST /api/auth/google
 */
const googleSignIn = async (req, res, next) => {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const { idToken } = req.body;

    if (!idToken) {
      return res.status(400).json({
        success: false,
        message: 'Google ID Token Required',
        error: {
          type: 'MISSING_ID_TOKEN',
          reason: 'The idToken field is required for Google Sign-In but was not provided.',
          details: {
            requiredField: 'idToken',
            location: 'body',
            expectedType: 'string (JWT from Google Sign-In SDK)'
          },
          suggestion: 'You must obtain the ID token from Google Sign-In SDK on your mobile app or web application.',
          action: 'Use Google Sign-In SDK to authenticate the user and send the idToken in your request body.'
        }
      });
    }

    // Google OAuth2Client oluştur
    const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

    // ID Token'ı doğrula (Client Secret GEREKMEZ)
    let ticket;
    try {
      ticket = await client.verifyIdToken({
        idToken: idToken,
        audience: [
          process.env.GOOGLE_CLIENT_ID,           // Web
          process.env.GOOGLE_ANDROID_CLIENT_ID,   // Android
          process.env.GOOGLE_IOS_CLIENT_ID        // iOS
        ]
      });
    } catch (error) {
      return res.status(401).json({
        success: false,
        message: 'Invalid Google ID Token',
        error: {
          type: 'GOOGLE_TOKEN_VERIFICATION_FAILED',
          reason: 'The Google ID token verification failed.',
          details: {
            googleError: error.message,
            possibleCauses: [
              'Token has expired',
              'Token was not issued by Google',
              'Token audience (client ID) does not match server configuration',
              'Token signature is invalid'
            ]
          },
          suggestion: 'The token from Google Sign-In SDK could not be verified. This usually means the token is expired or invalid.',
          action: 'Please try signing in with Google again to get a fresh ID token.'
        }
      });
    }

    const payload = ticket.getPayload();
    const googleId = payload.sub;
    const email = payload.email;
    const fullName = payload.name;
    const profilePictureUrls = extractSocialProfilePictureUrls(payload);

    // Kullanıcı var mı kontrol et
    const [existingUsers] = await connection.execute(
      'SELECT * FROM users WHERE provider_id = ? AND auth_provider = ?',
      [googleId, 'google']
    );

    let user;
    let isNewUser = false;

    if (existingUsers.length > 0) {
      // Mevcut kullanıcı - bilgileri güncelle
      user = existingUsers[0];
      const existingUrls = normalizeProfilePictureUrls(user.profile_picture_urls);
      const nextProfilePictureUrls =
        profilePictureUrls.length > 0
          ? profilePictureUrls
          : existingUrls.length > 0
            ? existingUrls
            : [];

      await connection.execute(
        `UPDATE users 
         SET email = ?, full_name = ?, profile_picture_urls = ?, last_login_at = NOW() 
         WHERE id = ?`,
        [
          email,
          fullName,
          JSON.stringify(nextProfilePictureUrls),
          user.id,
        ]
      );

      user = {
        ...user,
        email,
        full_name: fullName,
        profile_picture_urls: JSON.stringify(nextProfilePictureUrls),
      };
    } else {
      // Yeni kullanıcı oluştur
      // Generate unique referral code
      const referralCode = await generateUniqueReferralCode(connection);
      const newProfilePictureUrls = profilePictureUrls;

      const [result] = await connection.execute(
        `INSERT INTO users (email, full_name, auth_provider, provider_id, profile_picture_urls, is_guest, invitation_code) 
         VALUES (?, ?, 'google', ?, ?, 0, ?)`,
        [
          email,
          fullName,
          googleId,
          JSON.stringify(newProfilePictureUrls),
          referralCode,
        ]
      );

      const userId = result.insertId;

      // Yeni kullanıcıyı getir
      const [newUsers] = await connection.execute(
        'SELECT * FROM users WHERE id = ?',
        [userId]
      );
      user = newUsers[0];
      isNewUser = true;
    }

    // Token oluştur
    const tokens = generateTokenPair(user);

    // Refresh token'ı kaydet
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await connection.execute(
      'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)',
      [user.id, tokens.refreshToken, expiresAt]
    );

    await connection.commit();

    res.status(isNewUser ? 201 : 200).json({
      success: true,
      message: isNewUser ? 'User registered successfully' : 'Login successful',
      data: {
        user: {
          id: user.id,
          email: user.email,
          fullName: user.full_name,
          profilePictureUrls: normalizeProfilePictureUrls(user.profile_picture_urls),
          authProvider: 'google',
          isGuest: false,
          onboardingCompleted: !!user.onboarding_completed
        },
        tokens: {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresIn: '7d'
        },
        isNewUser
      }
    });

  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
};

/**
 * Apple Sign-In 
 * POST /api/auth/apple
 */
const appleSignIn = async (req, res, next) => {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const { identityToken, user: appleUserInfo } = req.body;

    if (!identityToken) {
      return res.status(400).json({
        success: false,
        message: 'Apple Identity Token Required',
        error: {
          type: 'MISSING_IDENTITY_TOKEN',
          reason: 'The identityToken field is required for Apple Sign-In but was not provided.',
          details: {
            requiredField: 'identityToken',
            location: 'body',
            expectedType: 'string (JWT from Apple Sign In)'
          },
          suggestion: 'You must obtain the identity token from Apple Sign In on your iOS app.',
          action: 'Use Apple Sign In SDK to authenticate the user and send the identityToken in your request body.'
        }
      });
    }

    // Apple Identity Token'dan bilgileri decode et (JWT)
    const jwt = require('jsonwebtoken');
    let decodedToken;

    try {
      // Apple'ın public key'i ile doğrula (otomatik)
      // NOT: Apple'ın public key'i jwt kütüphanesi tarafından otomatik alınır
      decodedToken = jwt.decode(identityToken);

      if (!decodedToken || !decodedToken.sub) {
        throw new Error('Invalid token structure');
      }
    } catch (error) {
      return res.status(401).json({
        success: false,
        message: 'Invalid Apple Identity Token',
        error: {
          type: 'APPLE_TOKEN_DECODE_FAILED',
          reason: 'Failed to decode or verify the Apple identity token.',
          details: {
            decodeError: error.message,
            possibleCauses: [
              'Token format is invalid',
              'Token has expired',
              'Token structure is malformed'
            ]
          },
          suggestion: 'The identity token from Apple Sign In could not be verified.',
          action: 'Please try signing in with Apple again to get a fresh identity token.'
        }
      });
    }

    const appleId = decodedToken.sub; // Apple User ID
    const email = decodedToken.email; // Email (gizlenmiş olabilir)

    // Apple kullanıcı bilgilerini sadece ilk girişte gönderir
    // Bu bilgiler req.body.user içinde gelir
    let fullName = 'Apple User';
    if (appleUserInfo) {
      const firstName = appleUserInfo.name?.firstName || '';
      const lastName = appleUserInfo.name?.lastName || '';
      fullName = `${firstName} ${lastName}`.trim() || 'Apple User';
    }

    // Kullanıcı var mı kontrol et
    const [existingUsers] = await connection.execute(
      'SELECT * FROM users WHERE provider_id = ? AND auth_provider = ?',
      [appleId, 'apple']
    );

    let user;
    let isNewUser = false;

    if (existingUsers.length > 0) {
      // Mevcut kullanıcı
      user = existingUsers[0];
      const appleProfilePictureUrls = extractSocialProfilePictureUrls({
        ...decodedToken,
        ...appleUserInfo,
      });
      const existingUrls = normalizeProfilePictureUrls(user.profile_picture_urls);
      const nextProfilePictureUrls =
        appleProfilePictureUrls.length > 0
          ? appleProfilePictureUrls
          : existingUrls.length > 0
            ? existingUrls
            : [];

      await connection.execute(
        `UPDATE users SET profile_picture_urls = ?, last_login_at = NOW() WHERE id = ?`,
        [JSON.stringify(nextProfilePictureUrls), user.id]
      );

      user = {
        ...user,
        profile_picture_urls: JSON.stringify(nextProfilePictureUrls),
      };
    } else {
      // Yeni kullanıcı oluştur
      // Generate unique referral code
      const referralCode = await generateUniqueReferralCode(connection);
      const profilePictureUrls = extractSocialProfilePictureUrls({
        ...decodedToken,
        ...appleUserInfo,
      });

      const [result] = await connection.execute(
        `INSERT INTO users (email, full_name, profile_picture_urls, auth_provider, provider_id, is_guest, invitation_code) 
         VALUES (?, ?, ?, 'apple', ?, 0, ?)`,
        [
          email,
          fullName,
          JSON.stringify(profilePictureUrls),
          appleId,
          referralCode,
        ]
      );

      const userId = result.insertId;

      const [newUsers] = await connection.execute(
        'SELECT * FROM users WHERE id = ?',
        [userId]
      );
      user = newUsers[0];
      isNewUser = true;
    }

    // Token oluştur
    const tokens = generateTokenPair(user);

    // Refresh token kaydet
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await connection.execute(
      'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)',
      [user.id, tokens.refreshToken, expiresAt]
    );

    await connection.commit();

    res.status(isNewUser ? 201 : 200).json({
      success: true,
      message: isNewUser ? 'User registered successfully' : 'Login successful',
      data: {
        user: {
          id: user.id,
          email: user.email,
          fullName: user.full_name,
          profilePictureUrls: normalizeProfilePictureUrls(user.profile_picture_urls),
          authProvider: 'apple',
          isGuest: false,
          onboardingCompleted: !!user.onboarding_completed
        },
        tokens: {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresIn: '7d'
        },
        isNewUser
      }
    });

  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
};

module.exports = {
  createGuestUser,
  refreshAccessToken,
  logout,
  googleSignIn,
  appleSignIn,
  getCurrentUser,
};
