const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');

/**
 * @route   GET /api/languages
 * @desc    Get all available languages
 * @access  Public
 */
router.get('/', async (req, res, next) => {
  try {
    const [languages] = await pool.execute(
      'SELECT code, name, is_active FROM languages WHERE is_active = 1 ORDER BY name ASC'
    );

    res.json({
      success: true,
      data: {
        languages: languages.map(lang => ({
          code: lang.code,
          name: lang.name
        }))
      }
    });

  } catch (error) {
    next(error);
  }
});

module.exports = router;
