const { pool } = require('../config/database');

/**
 * Handle RevenueCat Webhook Events
 * POST /api/webhooks/revenuecat
 */
const handleWebhook = async (req, res) => {
  try {
    const { event } = req.body;
    console.log(event, "event");

    if (!event) {
      return res.status(400).json({ success: false, message: 'Invalid payload' });
    }

    const { type, app_user_id, expiration_at_ms, period_type } = event;

    // We assume app_user_id is our database user ID (integer)
    // If RevenueCat sends it as a string, ensure it matches our ID format
    const userId = parseInt(app_user_id);

    if (isNaN(userId)) {
      console.error(`[RevenueCat] Invalid user ID: ${app_user_id}`);
      return res.status(200).send('Invalid User ID'); // Return 200 to acknowledge receipt
    }

    console.log(`[RevenueCat] Received event: ${type} for User ID: ${userId}`);

    // Events that grant premium access
    const GRANT_ACCESS_EVENTS = [
      'INITIAL_PURCHASE',
      'RENEWAL',
      'PRODUCT_CHANGE',
      'UNCANCELLATION'
    ];

    // Events that revoke premium access
    const REVOKE_ACCESS_EVENTS = [
      'EXPIRATION'
    ];

    // Connect to database
    const connection = await pool.getConnection();

    try {
      if (GRANT_ACCESS_EVENTS.includes(type)) {
        // Calculate expiration date
        // expiration_at_ms comes in milliseconds
        const premiumEndTime = new Date(expiration_at_ms);

        await connection.execute(
          `UPDATE users 
           SET is_premium = 1, 
               premium_endtime = ? 
           WHERE id = ?`,
          [premiumEndTime, userId]
        );

        console.log(`[RevenueCat] Granted premium to User ${userId} until ${premiumEndTime}`);

      } else if (REVOKE_ACCESS_EVENTS.includes(type)) {
        // Revoke access immediately (or keep until end date if logic differs)
        // For EXPIRATION, it usually means the time has passed

        await connection.execute(
          `UPDATE users 
           SET is_premium = 0 
           WHERE id = ?`,
          [userId]
        );

        console.log(`[RevenueCat] Revoked premium for User ${userId}`);
      } else {
        // Other events: CANCELLATION, BILLING_ISSUE, etc.
        // For CANCELLATION, user typically keeps access until end of period
        // So we don't change is_premium immediately, we let the scheduler or EXPIRATION event handle it
        console.log(`[RevenueCat] Event ${type} logged, no immediate action taken.`);
      }

    } finally {
      connection.release();
    }

    // Always return 200 OK to RevenueCat to acknowledge receipt
    res.status(200).send('Webhook received');

  } catch (error) {
    console.error('[RevenueCat] Webhook error:', error);
    // Return 500 only if there's a system error, so RevenueCat retries later
    res.status(500).send('Internal Server Error');
  }
};

module.exports = {
  handleWebhook
};
