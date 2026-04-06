const OneSignal = require('onesignal-node');
require('dotenv').config();

// OneSignal client configuration
// v3.4.0 compatible initialization
const client = new OneSignal.Client(process.env.ONESIGNAL_APP_ID, process.env.ONESIGNAL_API_KEY);

// Desteklenen diller
const SUPPORTED_LANGUAGES = ['tr', 'en', 'de', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'hi', 'it'];

/**
 * Send push notification to a user
 * @param {String} playerId - OneSignal player ID
 * @param {String} title - Notification title
 * @param {String} message - Notification message
 * @param {Object} data - Additional data (optional)
 * @param {String} language - User's preferred language (optional)
 */
const sendNotification = async (playerId, title, message, data = {}, language = 'en') => {
  try {
    // Tüm desteklenen dillere aynı mesajı ekle (OneSignal otomatik seçer)
    const contents = {};
    const headings = {};

    SUPPORTED_LANGUAGES.forEach(lang => {
      contents[lang] = message;
      headings[lang] = title;
    });

    const notification = {
      contents,
      headings,
      include_player_ids: [playerId],
      data: {
        ...data,
        language
      },
      // iOS için özel ayarlar
      ios_badgeType: 'Increase',
      ios_badgeCount: 1,
      // Android için özel ayarlar
      android_channel_id: process.env.ONESIGNAL_ANDROID_CHANNEL_ID || undefined,
      app_id: process.env.ONESIGNAL_APP_ID
    };


    const response = await client.createNotification(notification);
    console.log('✅ Push notification sent:', response.body.id);
    return response;
  } catch (error) {
    console.error('❌ Failed to send push notification:', error.message);
    throw error;
  }
};

/**
 * Send notification to multiple users
 * @param {Array} playerIds - Array of OneSignal player IDs
 * @param {String} title - Notification title
 * @param {String} message - Notification message
 * @param {Object} data - Additional data (optional)
 */
const sendBulkNotification = async (playerIds, title, message, data = {}) => {
  try {
    if (!playerIds || playerIds.length === 0) {
      console.log('No player IDs provided for bulk notification');
      return null;
    }

    // Tüm desteklenen dillere aynı mesajı ekle
    const contents = {};
    const headings = {};

    SUPPORTED_LANGUAGES.forEach(lang => {
      contents[lang] = message;
      headings[lang] = title;
    });

    const notification = {
      contents,
      headings,
      include_player_ids: playerIds,
      data: data,
      ios_badgeType: 'Increase',
      ios_badgeCount: 1,
      app_id: process.env.ONESIGNAL_APP_ID
    };

    const response = await client.createNotification(notification);
    console.log('✅ Bulk push notification sent:', response.body.id, `to ${playerIds.length} users`);
    return response;
  } catch (error) {
    console.error('❌ Failed to send bulk push notification:', error.message);
    throw error;
  }
};

/**
 * Send notification to a segment
 * @param {String} segment - OneSignal segment name
 * @param {String} title - Notification title
 * @param {String} message - Notification message
 * @param {Object} data - Additional data (optional)
 */
const sendSegmentNotification = async (segment, title, message, data = {}) => {
  try {
    const contents = {};
    const headings = {};

    SUPPORTED_LANGUAGES.forEach(lang => {
      contents[lang] = message;
      headings[lang] = title;
    });

    const notification = {
      contents,
      headings,
      included_segments: [segment],
      data: data,
      app_id: process.env.ONESIGNAL_APP_ID
    };

    const response = await client.createNotification(notification);
    console.log('✅ Segment notification sent:', response.body.id, `to segment: ${segment}`);
    return response;
  } catch (error) {
    console.error('❌ Failed to send segment notification:', error.message);
    throw error;
  }
};

/**
 * Cancel a scheduled notification
 * @param {String} notificationId - OneSignal notification ID
 */
const cancelNotification = async (notificationId) => {
  try {
    await client.cancelNotification(notificationId);
    console.log('✅ Notification cancelled:', notificationId);
    return true;
  } catch (error) {
    console.error('❌ Failed to cancel notification:', error.message);
    throw error;
  }
};

module.exports = {
  client,
  sendNotification,
  sendBulkNotification,
  sendSegmentNotification,
  cancelNotification,
  SUPPORTED_LANGUAGES
};
