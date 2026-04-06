const { pool } = require("../config/database");
const { uploadBuffer } = require("../utils/bunny");
const sharp = require("sharp");

const normalizeProfilePictureUrls = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter((url) => typeof url === "string" && url.trim());

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.filter((url) => typeof url === "string" && url.trim());
      }
      return value.trim() ? [value] : [];
    } catch (_) {
      return value.trim() ? [value] : [];
    }
  }

  return [];
};

/**
 * Get user profile
 * GET /api/user/profile
 */
const getUserProfile = async (req, res, next) => {
  try {
    const userId = req.user.id;

    // Get user with profile
    const [users] = await pool.execute(
      `SELECT * FROM users WHERE id = ?`,
      [userId],
    );

    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const userData = users[0];
    const profilePictureUrls = normalizeProfilePictureUrls(userData.profile_picture_urls);


    res.json({
      success: true,
      data: {
        user: {
          id: userData.id,
          email: userData.email,
          fullName: userData.full_name,
          aboutMe: userData.about_me,
          authProvider: userData.auth_provider,
          isGuest: !!userData.is_guest,
          country: userData.country,
          gender: userData.gender,
          isPremium: !!userData.is_premium,
          onboardingCompleted: !!userData.onboarding_completed,
          preferredLanguage: userData.preferred_language || "en",
          profilePictureUrls,
          invitationCode: userData.invitation_code,
          lastLoginAt: userData.last_login_at,
          createdAt: userData.created_at,
          updatedAt: userData.updated_at,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Update user profile
 * PUT /api/user/profile
 */
const updateUserProfile = async (req, res, next) => {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const userId = req.user.id;
    const {
      full_name,
      preferred_language,
      profile_picture_urls,
      about_me,
      gender,
      country,
    } = req.body;


    // Prepare arrays for updating users table
    const userUpdates = [];
    const userValues = [];

    if (full_name !== undefined) {
      userUpdates.push("full_name = ?");
      userValues.push(full_name);
    }
    if (preferred_language !== undefined) {
      userUpdates.push("preferred_language = ?");
      userValues.push(preferred_language);
    }

    if (profile_picture_urls !== undefined) {
      const normalizedUrls = normalizeProfilePictureUrls(profile_picture_urls);

      userUpdates.push("profile_picture_urls = ?");
      userValues.push(JSON.stringify(normalizedUrls));
    }

    if (about_me !== undefined) {
      userUpdates.push("about_me = ?");
      userValues.push(about_me);
    }
    if (gender !== undefined) {
      userUpdates.push("gender = ?");
      userValues.push(gender);
    }

    if (country !== undefined) {
      userUpdates.push("country = ?");
      userValues.push(country);
    }


    if (userUpdates.length > 0) {
      userValues.push(userId);
      await connection.execute(
        `UPDATE users SET ${userUpdates.join(", ")} WHERE id = ?`,
        userValues,
      );
    }

    await connection.commit();

    res.json({
      success: true,
      message: "Profile updated successfully",
    });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
};

/**
 * Save OneSignal player ID
 * POST /api/user/onesignal
 */
const saveOneSignalPlayerId = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { player_id } = req.body;

    if (!player_id) {
      return res.status(400).json({
        success: false,
        message: "OneSignal player ID is required",
      });
    }

    await pool.execute(
      "UPDATE users SET onesignal_player_id = ? WHERE id = ?",
      [player_id, userId],
    );

    res.json({
      success: true,
      message: "OneSignal player ID saved successfully",
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Upload profile photos
 * POST /api/user/profile/photo
 */
const uploadProfilePhoto = async (req, res, next) => {
  try {
    const userId = req.user.id;

    const incomingFiles = Array.isArray(req.files)
      ? req.files
      : Array.isArray(req.files?.photos)
        ? req.files.photos
        : Array.isArray(req.files?.photo)
          ? req.files.photo
          : req.file
            ? [req.file]
            : [];

    if (incomingFiles.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No file uploaded",
      });
    }

    // Compression + conversion settings
    const TARGET_BYTES = 200 * 1024; // ~200KB target size
    const MAX_WIDTH = 1024;
    const qualitySteps = [80, 70, 60, 50, 40, 30];

    const uploadedPicturePaths = [];

    for (const file of incomingFiles) {
      if (!file || !file.buffer) continue;

      let optimizedBuffer = null;

      for (const q of qualitySteps) {
        optimizedBuffer = await sharp(file.buffer)
          .rotate()
          .resize({ width: MAX_WIDTH, withoutEnlargement: true })
          .webp({ quality: q, effort: 6 })
          .toBuffer();

        if (optimizedBuffer.length <= TARGET_BYTES) break;
      }

      const filePath = `/${userId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.webp`;
      const destPath = `user${filePath}`;

      await uploadBuffer(optimizedBuffer, destPath, "image/webp");
      uploadedPicturePaths.push(filePath);
    }

    if (uploadedPicturePaths.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid image file uploaded",
      });
    }

    const [rows] = await pool.execute(
      "SELECT profile_picture_urls FROM users WHERE id = ?",
      [userId],
    );

    const existingUrls = rows.length
      ? normalizeProfilePictureUrls(rows[0].profile_picture_urls)
      : [];
    const mergedUrls = Array.from(new Set([...existingUrls, ...uploadedPicturePaths]));

    await pool.execute(
      "UPDATE users SET profile_picture_urls = ? WHERE id = ?",
      [JSON.stringify(mergedUrls), userId],
    );

    res.json({
      success: true,
      profilePictureUrls: mergedUrls,
      message: "Profile photos uploaded successfully",
    });
  } catch (error) {
    next(error);
  }
};



/**
 * Save user onboarding preferences
 * POST /api/user/preferences
 */
const savePreferences = async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const userId = req.user.id;
    const {
      preferred_language,
      full_name,
      age,
      gender,
    } = req.body;

    const preferredLanguageValue = preferred_language;
    const fullNameValue = full_name;

    const userUpdates = ["onboarding_completed = 1"];
    const userValues = [];

    if (preferredLanguageValue !== undefined) {
      userUpdates.push("preferred_language = ?");
      userValues.push(preferredLanguageValue);
    }

    if (fullNameValue !== undefined) {
      userUpdates.push("full_name = ?");
      userValues.push(fullNameValue);
    }

    if (age !== undefined) {
      userUpdates.push("age = ?");
      userValues.push(age);
    }

    if (gender !== undefined) {
      userUpdates.push("gender = ?");
      userValues.push(gender);
    }

    userValues.push(userId);

    await connection.execute(
      `UPDATE users SET ${userUpdates.join(", ")} WHERE id = ?`,
      userValues,
    );

    await connection.commit();

    res.json({
      success: true,
      message: "Preferences saved successfully",
    });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
};

/**
 * Delete user account
 * DELETE /api/user/account
 */
const deleteAccount = async (req, res, next) => {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const userId = req.user.id;

    await connection.execute("DELETE FROM users WHERE id = ?", [userId]);

    await connection.commit();

    res.json({
      success: true,
      message: "Account deleted successfully",
    });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
};


module.exports = {
  getUserProfile,
  updateUserProfile,
  saveOneSignalPlayerId,
  deleteAccount,
  uploadProfilePhoto,
  savePreferences,
};
