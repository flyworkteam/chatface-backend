require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { testConnection } = require('./config/database');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const {
  assertRuntimeN8nConfig,
  runN8nStartupSmokeChecks
} = require('./config/n8n');

// Import routes
const authRoutes = require('./routes/auth');
const onboardingRoutes = require('./routes/onboarding');
const userRoutes = require('./routes/user');
const languageRoutes = require('./routes/language');
const notificationRoutes = require('./routes/notification');
const webhookRoutes = require('./routes/webhook');
const aiSessionRoutes = require('./routes/aiSession');
const internalRoutes = require('./routes/internal');
const {
  getLiveTtsAudio,
  getTtsCacheAudio
} = require('./controllers/aiSessionController');
const { initializeRealtimeGateway } = require('./websocket/realtimeGateway');
const http = require('http');


const { startScheduler, stopScheduler } = require('./services/notificationScheduler');
const { startPremiumExpirationScheduler, stopPremiumExpirationScheduler } = require('./services/premiumExpirationScheduler');



// Initialize Express app
const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// ============================================
// Middleware Configuration
// ============================================

// Security headers
app.use(helmet());

// CORS configuration
const corsOptions = {
  origin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:3000'],
  credentials: true,
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));

// Body parsers
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// HTTP request logger (only in development)
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}

// ============================================
// Routes
// ============================================

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'ChatFace API is running',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/onboarding', onboardingRoutes);
app.use('/api/user', userRoutes);
app.use('/api/languages', languageRoutes);
app.use('/api/ai/internal', internalRoutes); // n8n callback routes (no JWT)
app.use('/api/notifications', notificationRoutes);
app.use('/api/webhooks', webhookRoutes);
app.get('/api/ai/tts/cache/:cacheKey', getTtsCacheAudio);
app.get('/api/ai/tts/live/:streamId', getLiveTtsAudio);
app.use('/api/ai', aiSessionRoutes);


// ============================================
// Error Handling
// ============================================

// 404 handler
app.use(notFoundHandler);

// Global error handler
app.use(errorHandler);

// ============================================
// Server Initialization
// ============================================

const startServer = async () => {
  try {
    assertRuntimeN8nConfig();

    // Test database connection
    const dbConnected = await testConnection();

    if (!dbConnected) {
      console.error('❌ Failed to connect to database. Server not started.');
      process.exit(1);
    }
    startScheduler();
    startPremiumExpirationScheduler();

    // Start server
    initializeRealtimeGateway(server);

    server.listen(PORT, () => {
      console.log('');
      console.log('========================================');
      console.log('  🚀 CHATFACEAPP Backend Server');
      console.log('========================================');
      console.log(`  Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`  Port: ${PORT}`);
      console.log(`  URL: http://localhost:${PORT}`);
      console.log('========================================');
      console.log('');
      console.log('📡 Available endpoints:');
      console.log('  GET  /                           - Health check');
      console.log('  POST /api/auth/guest             - Create guest user');
      console.log('  POST /api/auth/refresh           - Refresh token');
      console.log('  POST /api/auth/logout            - Logout');
      console.log('  GET  /api/auth/me                - Get current user');
      console.log('  GET  /api/languages              - Get available languages');
      console.log('  POST /api/onboarding/*           - Onboarding endpoints');
      console.log('  GET  /api/onboarding/status      - Onboarding status');
      console.log('  GET  /api/user/profile           - Get profile');
      console.log('  PUT  /api/user/profile           - Update profile');
      console.log('  POST /api/user/onesignal         - Save OneSignal ID');
      console.log('  DELETE /api/user/account         - Delete account');
      console.log('  GET  /api/notifications/settings - Get notification settings');
      console.log('  PUT  /api/notifications/settings - Update notification settings');
      console.log('  POST /api/notifications/toggle   - Toggle notifications');
      console.log('  POST /api/notifications/interval - Update reminder interval');
      console.log('========================================');
      console.log('');

      if (process.env.N8N_STARTUP_SMOKE_TEST === 'true') {
        runN8nStartupSmokeChecks()
          .then((results) => {
            results.forEach((result) => {
              if (result.ok) {
                console.log(`✅ n8n smoke check passed: ${result.key} (${result.status})`);
              } else {
                console.warn(
                  `⚠️  n8n smoke check failed: ${result.key} (${result.status || 'ERR'})${result.error ? ` - ${result.error}` : ''}`
                );
              }
            });
          })
          .catch((error) => {
            console.warn('⚠️  n8n startup smoke checks failed:', error.message);
          });
      }
    });

  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('📴 SIGTERM received. Shutting down gracefully...');
  stopScheduler();
  stopPremiumExpirationScheduler();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('📴 SIGINT received. Shutting down gracefully...');
  stopScheduler();
  stopPremiumExpirationScheduler();
  process.exit(0);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled Promise Rejection:', err);
  process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
  process.exit(1);
});

// Start the server
startServer();

module.exports = app;
