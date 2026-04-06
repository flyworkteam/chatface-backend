const express = require("express");
const router = express.Router();
const { body } = require("express-validator");
const { handleValidationErrors } = require("../middleware/validation");
const { authenticateToken } = require("../middleware/auth");
const multer = require("multer");
// Allow slightly larger uploads (8MB) but still reasonable for profile photos.
const MAX_UPLOAD_SIZE = 15 * 1024 * 1024; // 8MB
const MAX_PROFILE_PHOTO_COUNT = 6;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_SIZE },
  fileFilter: (req, file, cb) => {
    // Only accept image files
    if (!file.mimetype || !file.mimetype.startsWith("image/")) {
      return cb(new Error("Only image files are allowed"));
    }
    cb(null, true);
  },
});
const {
  getUserProfile,
  updateUserProfile,
  saveOneSignalPlayerId,
  deleteAccount,
  uploadProfilePhoto,
} = require("../controllers/userController");
const { applyReferralCode } = require("../controllers/referralController");

/**
 * @route   GET /api/user/profile
 * @desc    Get user profile
 * @access  Private
 */
router.get("/profile", authenticateToken, getUserProfile);

/**
 * @route   PUT /api/user/profile
 * @desc    Update user profile
 * @access  Private
 */
router.put(
  "/profile",
  authenticateToken,
  [
    body("full_name").optional().isString().trim(),
    body("profile_picture_urls")
      .optional()
      .isArray()
      .withMessage("profile_picture_urls must be an array"),
    body("profile_picture_urls.*")
      .optional()
      .isString()
      .trim()
      .withMessage("Each profile picture URL must be a string"),
    body("about_me").optional().isString().trim(),
    body("age").optional().isString().trim(),
    body("gender").optional().isString().trim(),
    body("country").optional().isString().trim(),
    body("preferred_language")
      .optional()
      .isIn(["de", "en", "es", "fr", "hi", "it", "ja", "ko", "pt", "ru", "tr", "zh"])
      .withMessage("Invalid language code"),

  ],
  handleValidationErrors,
  updateUserProfile,
);

/**
 * @route   POST /api/user/onesignal
 * @desc    Save OneSignal player ID
 * @access  Private
 */
router.post(
  "/onesignal",
  authenticateToken,
  [body("player_id").notEmpty().withMessage("OneSignal player ID is required")],
  handleValidationErrors,
  saveOneSignalPlayerId,
);


/**
 * @route   DELETE /api/user/account
 * @desc    Delete user account
 * @access  Private
 */
router.delete("/account", authenticateToken, deleteAccount);

/**
 * @route   POST /api/user/profile/photo
 * @desc    Upload profile photos (multipart/form-data with field `photos`)
 * @access  Private
 */
router.post(
  "/profile/photo",
  authenticateToken,
  upload.fields([
    { name: "photos", maxCount: MAX_PROFILE_PHOTO_COUNT },
    { name: "photo", maxCount: MAX_PROFILE_PHOTO_COUNT },
  ]),
  uploadProfilePhoto,
);

/**
 * @route   POST /api/user/apply-referral-code
 * @desc    Apply a referral/invitation code to get premium
 * @access  Private
 */
router.post(
  "/apply-referral-code",
  authenticateToken,
  [
    body("referral_code")
      .notEmpty()
      .withMessage("Referral code is required")
      .isString()
      .isLength({ min: 8, max: 8 })
      .withMessage("Referral code must be exactly 8 characters"),
  ],
  handleValidationErrors,
  applyReferralCode,
);

/**
 * @route   POST /api/user/preferences
 * @desc    Save onboarding preferences (language, categories)
 * @access  Private
 */
router.post(
  "/preferences",
  authenticateToken,
  [
    body("preferred_language").optional().isString().trim(),
    body("full_name").optional().isString().trim(),
    body("age").optional().isInt({ min: 18, max: 120 }).withMessage("age must be between 18 and 120"),
    body("gender").optional().isString().trim(),
  ],
  handleValidationErrors,
  require("../controllers/userController").savePreferences,
);

module.exports = router;
