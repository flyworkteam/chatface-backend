const { pool } = require("../config/database");



/**
 * Get onboarding status
 * GET /api/onboarding/status
 */
const getOnboardingStatus = async (req, res, next) => {
  try {
    const userId = req.user.id;

    // Get user
    const [users] = await pool.execute(
      "SELECT onboarding_completed FROM users WHERE id = ?",
      [userId],
    );

    // Get profile
    const [profiles] = await pool.execute(
      "SELECT * FROM user_profiles WHERE user_id = ?",
      [userId],
    );

    // Get skin concerns count
    const [concernsCount] = await pool.execute(
      "SELECT COUNT(*) as count FROM user_skin_concerns WHERE user_id = ?",
      [userId],
    );

    // Get objectives count
    const [objectivesCount] = await pool.execute(
      "SELECT COUNT(*) as count FROM user_objectives WHERE user_id = ?",
      [userId],
    );

    // Get improvement areas count
    const [areasCount] = await pool.execute(
      "SELECT COUNT(*) as count FROM user_improvement_areas WHERE user_id = ?",
      [userId],
    );

    const profile = profiles[0] || {};

    res.json({
      success: true,
      data: {
        completed: !!users[0].onboarding_completed,
        steps: {
          basicInfo: !!(profile.gender && profile.age),
          physicalInfo: !!(profile.weight && profile.height),
          skinConcerns: concernsCount[0].count > 0,
          skinType: !!profile.skin_type,
          botoxHistory: profile.has_botox !== null,
          faceShape: !!profile.target_face_shape,
          makeupFrequency: !!profile.makeup_frequency,
          objectives: objectivesCount[0].count > 0,
          improvementAreas: areasCount[0].count > 0,
        },
      },
    });
  } catch (error) {
    console.error(
      "[getOnboardingStatus] Error fetching onboarding status:",
      error,
    );

    error.context = {
      operation: "getOnboardingStatus",
      reason: "Failed to retrieve onboarding status from database",
      details: {
        userId: req.user?.id,
      },
      suggestion:
        "Database query failed while checking onboarding completion status.",
      action: "Ensure user is authenticated and database is accessible.",
    };

    next(error);
  }
};

module.exports = {
  getOnboardingStatus,
};
