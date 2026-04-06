/**
 * Extract field information from MySQL duplicate entry error
 */
const parseDuplicateEntryError = (err) => {
  const message = err.message || '';
  
  // Try to extract the duplicate value and key
  const valueMatch = message.match(/Duplicate entry '([^']+)'/);
  const keyMatch = message.match(/for key '([^']+)'/);
  
  const duplicateValue = valueMatch ? valueMatch[1] : 'unknown';
  const keyName = keyMatch ? keyMatch[1] : 'unknown';
  
  // Determine which field based on key name
  let field = 'unknown';
  let suggestion = 'This record already exists in the database.';
  
  if (keyName.includes('provider_id')) {
    field = 'provider_id';
    suggestion = 'This account is already registered. Please use the login flow instead, or try a different authentication method.';
  } else if (keyName.includes('email')) {
    field = 'email';
    suggestion = 'This email address is already registered. Please login with your existing account.';
  } else if (keyName.includes('onesignal')) {
    field = 'onesignal_player_id';
    suggestion = 'This device is already registered for push notifications.';
  }
  
  return {
    field,
    value: duplicateValue,
    keyName,
    suggestion
  };
};

/**
 * Extract information from foreign key error
 */
const parseForeignKeyError = (err) => {
  const message = err.message || '';
  
  let suggestion = 'The referenced resource does not exist. Please ensure the parent record exists before creating this record.';
  let context = {};
  
  if (message.includes('user_profiles') && message.includes('user_id')) {
    suggestion = 'User profile cannot be created or updated because the user does not exist. Please ensure the user is created first.';
    context = {
      table: 'user_profiles',
      foreignKey: 'user_id',
      referencedTable: 'users'
    };
  } else if (message.includes('user_skin_concerns')) {
    suggestion = 'Cannot save skin concerns because the user profile does not exist. Please complete basic information first.';
    context = {
      table: 'user_skin_concerns',
      foreignKey: 'user_id',
      referencedTable: 'users'
    };
  }
  
  return { suggestion, context };
};

/**
 * Global error handling middleware with detailed error messages
 * Catches all errors and returns consistent, informative error responses
 */
const errorHandler = (err, req, res, next) => {
  console.error('❌ Error:', err);

  // Default error response structure
  let statusCode = err.statusCode || 500;
  let message = err.message || 'Internal server error';
  let errorDetails = null;

  // ============================================
  // MySQL / Database Errors
  // ============================================
  
  if (err.code === 'ER_DUP_ENTRY') {
    statusCode = 409;
    const dupInfo = parseDuplicateEntryError(err);
    
    message = 'Database Constraint Violation: Duplicate Entry';
    errorDetails = {
      type: 'DUPLICATE_ENTRY',
      reason: `A record with this ${dupInfo.field} already exists in the database.`,
      details: {
        field: dupInfo.field,
        attemptedValue: dupInfo.value,
        constraint: `UNIQUE constraint on ${dupInfo.keyName}`
      },
      suggestion: dupInfo.suggestion,
      action: 'Please verify your data or use a different value for this field.'
    };
  }

  else if (err.code === 'ER_NO_REFERENCED_ROW_2') {
    statusCode = 400;
    const fkInfo = parseForeignKeyError(err);
    
    message = 'Database Constraint Violation: Foreign Key Error';
    errorDetails = {
      type: 'FOREIGN_KEY_VIOLATION',
      reason: 'The referenced parent record does not exist in the database.',
      details: fkInfo.context,
      suggestion: fkInfo.suggestion,
      action: 'Ensure the parent record exists before attempting this operation.'
    };
  }

  else if (err.code === 'ER_BAD_NULL_ERROR') {
    const fieldMatch = err.message.match(/Column '([^']+)'/);
    const field = fieldMatch ? fieldMatch[1] : 'unknown';
    
    statusCode = 400;
    message = 'Database Constraint Violation: Required Field Missing';
    errorDetails = {
      type: 'NULL_CONSTRAINT_VIOLATION',
      reason: `The required field '${field}' was not provided or is null.`,
      details: {
        field: field,
        constraint: 'NOT NULL'
      },
      suggestion: `Please provide a valid value for the '${field}' field.`,
      action: 'Check your request payload and ensure all required fields are included.'
    };
  }

  else if (err.code === 'ER_DATA_TOO_LONG') {
    const fieldMatch = err.message.match(/column '([^']+)'/);
    const field = fieldMatch ? fieldMatch[1] : 'unknown';
    
    statusCode = 400;
    message = 'Database Constraint Violation: Data Too Long';
    errorDetails = {
      type: 'DATA_TOO_LONG',
      reason: `The data provided for '${field}' exceeds the maximum allowed length.`,
      details: {
        field: field
      },
      suggestion: `Please reduce the length of the '${field}' value.`,
      action: 'Check the field constraints and trim your data accordingly.'
    };
  }

  else if (err.code === 'ECONNREFUSED' || err.code === 'PROTOCOL_CONNECTION_LOST') {
    statusCode = 503;
    message = 'Database Connection Error';
    errorDetails = {
      type: 'DATABASE_CONNECTION_ERROR',
      reason: 'Unable to establish or maintain connection to the database.',
      details: {
        code: err.code,
        fatal: err.fatal
      },
      suggestion: 'This is a temporary server issue. Please try again in a few moments.',
      action: 'If the problem persists, please contact support.'
    };
  }

  else if (err.code === 'ER_LOCK_WAIT_TIMEOUT') {
    statusCode = 408;
    message = 'Database Lock Timeout';
    errorDetails = {
      type: 'LOCK_TIMEOUT',
      reason: 'The operation took too long due to database locks.',
      suggestion: 'Another operation is in progress. Please try again.',
      action: 'Wait a moment and retry your request.'
    };
  }

  // ============================================
  // JWT / Authentication Errors
  // ============================================
  
  else if (err.name === 'JsonWebTokenError') {
    statusCode = 401;
    message = 'Authentication Error: Invalid Token';
    errorDetails = {
      type: 'INVALID_TOKEN',
      reason: 'The authentication token provided is malformed or has an invalid signature.',
      details: {
        error: err.message
      },
      suggestion: 'The token format is incorrect or has been tampered with.',
      action: 'Please login again to obtain a new valid token.',
      requiresReLogin: true
    };
  }

  else if (err.name === 'TokenExpiredError') {
    statusCode = 401;
    message = 'Authentication Error: Token Expired';
    errorDetails = {
      type: 'TOKEN_EXPIRED',
      reason: 'Your authentication token has expired and is no longer valid.',
      details: {
        expiredAt: err.expiredAt
      },
      suggestion: 'Use your refresh token to obtain a new access token.',
      action: 'Call POST /api/auth/refresh with your refresh token to get a new access token.',
      requiresTokenRefresh: true
    };
  }

  else if (err.name === 'NotBeforeError') {
    statusCode = 401;
    message = 'Authentication Error: Token Not Yet Valid';
    errorDetails = {
      type: 'TOKEN_NOT_BEFORE',
      reason: 'The token is not yet valid and cannot be used.',
      details: {
        date: err.date
      },
      suggestion: 'The token has a future activation date.',
      action: 'Please check your system time or obtain a new token.'
    };
  }

  // ============================================
  // Validation Errors
  // ============================================
  
  else if (err.name === 'ValidationError') {
    statusCode = 400;
    message = 'Validation Error';
    errorDetails = {
      type: 'VALIDATION_ERROR',
      reason: err.message,
      suggestion: 'Please check your input data and ensure it meets the required format.',
      action: 'Review the validation rules and correct your request.'
    };
  }

  // ============================================
  // Custom Application Errors
  // ============================================
  
  else if (err.code === 'TRANSACTION_ROLLBACK') {
    statusCode = 500;
    message = 'Transaction Failed';
    errorDetails = {
      type: 'TRANSACTION_ROLLBACK',
      reason: 'The database transaction was rolled back due to an error.',
      details: {
        originalError: err.originalError?.message || 'Unknown error'
      },
      suggestion: 'A critical error occurred during the operation. No changes were saved.',
      action: 'Please verify your data and try again. If the problem persists, contact support.'
    };
  }

  // ============================================
  // Build Response
  // ============================================
  
  const response = {
    success: false,
    message,
    timestamp: new Date().toISOString(),
    ...(errorDetails && { error: errorDetails })
  };

  // Add stack trace in development mode
  if (process.env.NODE_ENV === 'development') {
    response.stack = err.stack;
    response.rawError = {
      code: err.code,
      errno: err.errno,
      sqlMessage: err.sqlMessage,
      sql: err.sql
    };
  }

  res.status(statusCode).json(response);
};

/**
 * 404 Not Found handler
 */
const notFoundHandler = (req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.originalUrl} not found`
  });
};

module.exports = {
  errorHandler,
  notFoundHandler
};
