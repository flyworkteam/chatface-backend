const { validationResult } = require('express-validator');

/**
 * Get a human-readable description of the constraint based on validation error
 */
const getConstraintDescription = (error) => {
  const { msg, path } = error;
  
  // Extract constraint from the message if possible
  if (msg.includes('must be between')) {
    const match = msg.match(/between (\d+)(?:-| and )(\d+)/);
    if (match) {
      return `Value must be between ${match[1]} and ${match[2]}`;
    }
  }
  
  if (msg.includes('must be one of') || msg.includes('must be')) {
    return msg;
  }
  
  return 'Value does not meet validation requirements';
};

/**
 * Get helpful suggestion based on the field and error type
 */
const getFieldSuggestion = (field, error) => {
  const suggestions = {
    age: 'Please provide a realistic age value between 13 and 120 years for accurate health recommendations.',
    weight: 'Please provide weight in kilograms (kg) between 30 and 300 for safe exercise intensity calculations.',
    height: 'Please provide height in centimeters (cm) between 100 and 250.',
    gender: 'Gender is required for personalized exercise recommendations. Valid options: male, female, other.',
    skin_type: 'Skin type helps customize your face yoga program. Valid options: normal, oily, dry, combination, sensitive.',
    target_face_shape: 'Select your desired face shape to get targeted exercises. Valid options: heart, oval, square, round, diamond.',
    makeup_frequency: 'This helps personalize your skincare routine. Valid options: every_day, few_days_week, occasionally, never.',
    concerns: 'Skin concerns help us recommend the right exercises. Valid options: acne, redness, swelling, wrinkles, neck_lines.',
    objectives: 'Select your fitness goals. Valid options: reduce_wrinkles, tighten_skin, lift_eyelids, eliminate_double_chin, brighten_tone, all.',
    areas: 'Choose areas you want to improve. Valid options: forehead, eyes, nose, cheeks, lips, jawline, neck.',
    idToken: 'Google ID token must be obtained from Google Sign-In SDK. This is a JWT string.',
    accessToken: 'Facebook access token must be obtained from Facebook Login SDK.',
    identityToken: 'Apple identity token must be obtained from Apple Sign In SDK.',
    refreshToken: 'Refresh token is required to obtain a new access token. This should be stored securely on the client.',
    has_botox: 'Please specify whether you have had Botox treatment. Valid values: true or false.'
  };
  
  // Handle array fields
  if (field.includes('*')) {
    const baseField = field.split('.')[0];
    return suggestions[baseField] || 'Please check the array values and ensure they match the accepted options.';
  }
  
  return suggestions[field] || 'Please review the field value and ensure it meets the required format.';
};

/**
 * Get the reason why validation failed
 */
const getFailureReason = (error) => {
  const { msg, value, path } = error;
  
  if (value === undefined || value === null || value === '') {
    return `The field '${path}' is required but was not provided in the request.`;
  }
  
  if (msg.includes('must be') && msg.includes('array')) {
    if (!Array.isArray(value)) {
      return `Expected an array for '${path}', but received ${typeof value}: '${value}'.`;
    }
    return `Array validation failed for '${path}'.`;
  }
  
  if (msg.includes('boolean')) {
    return `Expected a boolean (true/false) for '${path}', but received ${typeof value}: '${value}'.`;
  }
  
  if (msg.includes('must be between')) {
    return `The value '${value}' for '${path}' is outside the acceptable range.`;
  }
  
  if (msg.includes('must be one of') || msg.includes('Invalid')) {
    return `The value '${value}' is not a valid option for '${path}'.`;
  }
  
  if (msg.includes('at least')) {
    return `The value '${value}' for '${path}' is too short or too small.`;
  }
  
  return `Validation failed for '${path}' with value: '${value}'.`;
};

/**
 * Enhanced middleware to handle validation errors with detailed context
 */
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  
  if (!errors.isEmpty()) {
    const errorArray = errors.array();
    const detailedErrors = errorArray.map(err => ({
      field: err.path || err.param,
      location: err.location || 'body',
      receivedValue: err.value !== undefined ? err.value : 'undefined',
      expectedConstraint: getConstraintDescription(err),
      reason: getFailureReason(err),
      message: err.msg,
      suggestion: getFieldSuggestion(err.path || err.param, err)
    }));
    
    return res.status(400).json({
      success: false,
      message: `Validation failed: ${errorArray.length} error(s) found`,
      errorCount: errorArray.length,
      errors: detailedErrors,
      timestamp: new Date().toISOString(),
      hint: 'Please review the errors below and correct the field values according to the suggestions provided.'
    });
  }
  
  next();
};

module.exports = {
  handleValidationErrors
};
