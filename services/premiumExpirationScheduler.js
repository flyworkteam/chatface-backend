const cron = require('node-cron');
const { pool } = require('../config/database');

/**
 * Cron job to automatically expire premium subscriptions
 * Runs every hour and sets is_premium = 0 for users whose premium_endtime has passed
 */
const expirePremiumSubscriptions = async () => {
  try {
    console.log('[Premium Expiration] Running scheduled check...');

    const [result] = await pool.execute(
      `UPDATE users 
       SET is_premium = 0 
       WHERE is_premium = 1 
       AND premium_endtime IS NOT NULL 
       AND premium_endtime < NOW()`
    );

    if (result.affectedRows > 0) {
      console.log(`[Premium Expiration] ✅ Expired premium for ${result.affectedRows} user(s)`);
    } else {
      console.log('[Premium Expiration] No premium subscriptions to expire');
    }
  } catch (error) {
    console.error('[Premium Expiration] ❌ Error expiring premium subscriptions:', error);
  }
};

/**
 * Start the premium expiration cron job
 * Runs every hour at minute 0 (e.g., 1:00, 2:00, 3:00, etc.)
 */
const startPremiumExpirationScheduler = () => {
  // Run every hour (at the start of each hour: XX:00)
  const task = cron.schedule('0 * * * *', expirePremiumSubscriptions, {
    scheduled: true,
    timezone: 'Europe/Istanbul' // Turkey timezone
  });

  console.log('⏰ Premium expiration scheduler started (runs every hour)');
  
  // Run once immediately on startup to catch any expired subscriptions
  expirePremiumSubscriptions();

  return task;
};

/**
 * Stop the premium expiration cron job
 */
const stopPremiumExpirationScheduler = (task) => {
  if (task) {
    task.stop();
    console.log('⏰ Premium expiration scheduler stopped');
  }
};

module.exports = {
  startPremiumExpirationScheduler,
  stopPremiumExpirationScheduler,
  expirePremiumSubscriptions
};
