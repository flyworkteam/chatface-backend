/**
 * ChatFace Notification Service
 *
 * OneSignal ile entegre çalışan bildirim servisi
 * 3 Kullanıcı Aktivite Katmanı:
 *   aktif      → bugün uygulamayı açmış        → 1 bildirim (akşam, haftada 3-4 gün)
 *   yari_aktif → 24-48 saattir açılmamış       → 2 bildirim (öğleden sonra + akşam)
 *   pasif      → 3-5 gündür açılmamış          → 1 bildirim (sadece akşam, yumuşak ton)
 */

const { pool } = require('../config/database');
const { sendNotification } = require('../config/onesignal');
const notificationMessages = require('./notificationMessages');

// Desteklenen diller
const SUPPORTED_LANGUAGES = ['tr', 'en', 'de', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'hi', 'it', 'zh'];
const DEFAULT_LANGUAGE = 'en';
const DEFAULT_NOTIFICATION_TYPE = 'custom';

const normalizeNotificationTypeForStorage = (notificationType) => {
  if (notificationType === 'chatface_conversation_reminder') {
    return 'custom';
  }
  return notificationType;
};

const resolveMessagePoolType = (notificationType) => {
  if (notificationType === 'chatface_conversation_reminder') {
    return 'chatface_conversation_reminder';
  }
  if (notificationMessages[notificationType]) {
    return notificationType;
  }
  return 'chatface_conversation_reminder';
};

/**
 * Kullanıcının tercih ettiği dili al
 */
const getUserLanguage = (preferredLanguage) => {
  if (preferredLanguage && SUPPORTED_LANGUAGES.includes(preferredLanguage)) {
    return preferredLanguage;
  }
  return DEFAULT_LANGUAGE;
};

/**
 * Quiet hours kontrolü (22:00–08:00 varsayılan)
 */
const isQuietHours = (timezone = 'Europe/Istanbul', quietStart = '22:00', quietEnd = '08:00') => {
  try {
    const now = new Date().toLocaleString('en-US', { timeZone: timezone });
    const currentTime = new Date(now);
    const currentHours = currentTime.getHours();
    const currentMinutes = currentTime.getMinutes();

    const [startHour, startMin] = quietStart.split(':').map(Number);
    const [endHour, endMin] = quietEnd.split(':').map(Number);

    const startMinutes = startHour * 60 + startMin;
    const endMinutes = endHour * 60 + endMin;
    const currentMinutesTotal = currentHours * 60 + currentMinutes;

    if (startMinutes > endMinutes) {
      return currentMinutesTotal >= startMinutes || currentMinutesTotal < endMinutes;
    }
    return currentMinutesTotal >= startMinutes && currentMinutesTotal < endMinutes;
  } catch (error) {
    console.error('Timezone error:', error);
    return false;
  }
};

/**
 * Son gonderilen metni al
 */
const getLastSentMessage = async (userId, notificationType, language) => {
  try {
    const [rows] = await pool.execute(
      `SELECT title, message
       FROM notification_history
       WHERE user_id = ?
         AND notification_type = ?
         AND language = ?
         AND status = 'sent'
         AND deleted_at IS NULL
       ORDER BY sent_at DESC
       LIMIT 1`,
      [userId, notificationType, language]
    );

    return rows[0] || null;
  } catch (error) {
    console.error('Error reading last notification message:', error);
    return null;
  }
};

/**
 * Rastgele mesaj seç (Ayni mesajin art arda secilmemesi icin onceki metin dislanir)
 */
const getRandomMessage = async (userId, notificationType, language) => {
  const messagePoolType = resolveMessagePoolType(notificationType);
  const storageType = normalizeNotificationTypeForStorage(notificationType);
  const lang = getUserLanguage(language);
  const messages = notificationMessages[messagePoolType];

  if (!messages) {
    console.error(`Unknown notification type: ${notificationType}`);
    return null;
  }

  const langMessages = messages[lang] || messages[DEFAULT_LANGUAGE];

  if (!langMessages || langMessages.length === 0) {
    console.error(`No messages found for type: ${notificationType}, lang: ${lang}`);
    return null;
  }

  if (langMessages.length === 1) {
    return langMessages[0];
  }

  const lastSentMessage = await getLastSentMessage(userId, storageType, lang);
  const filteredMessages = lastSentMessage
    ? langMessages.filter(m => !(m.title === lastSentMessage.title && m.message === lastSentMessage.message))
    : langMessages;

  const candidates = filteredMessages.length > 0 ? filteredMessages : langMessages;
  const randomIndex = Math.floor(Math.random() * candidates.length);
  return candidates[randomIndex];
};

/**
 * Bildirim geçmişine kaydet
 */
const logNotification = async (
  userId, notificationType, title, message, language,
  onesignalId = null, status = 'sent', errorMessage = null
) => {
  try {
    await pool.execute(
      `INSERT INTO notification_history
       (user_id, notification_type, title, message, language, onesignal_notification_id, status, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, notificationType, title, message, language, onesignalId, status, errorMessage]
    );
  } catch (error) {
    console.error('Error logging notification:', error);
  }
};

/**
 * Son bildirim zamanını güncelle
 */
const updateLastNotificationTime = async (userId) => {
  try {
    await pool.execute(
      'UPDATE notification_settings SET last_notification_at = NOW() WHERE user_id = ?',
      [userId]
    );
  } catch (error) {
    console.error('Error updating last notification time:', error);
  }
};

/**
 * Bildirim ayarlarını oluştur (yeni kullanıcı için)
 */
const createNotificationSettings = async (userId, settings = {}) => {
  try {
    const {
      notificationsEnabled = true,
      reminderInterval = '6h',
      quietHoursEnabled = true,
      quietHoursStart = '22:00:00',
      quietHoursEnd = '08:00:00',
      timezone = 'Europe/Istanbul'
    } = settings;

    await pool.execute(
      `INSERT INTO notification_settings
       (user_id, notifications_enabled, reminder_interval, quiet_hours_enabled,
        quiet_hours_start, quiet_hours_end, timezone)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
       notifications_enabled = VALUES(notifications_enabled),
       reminder_interval = VALUES(reminder_interval),
       quiet_hours_enabled = VALUES(quiet_hours_enabled),
       quiet_hours_start = VALUES(quiet_hours_start),
       quiet_hours_end = VALUES(quiet_hours_end),
       timezone = VALUES(timezone)`,
      [userId, notificationsEnabled, reminderInterval, quietHoursEnabled,
        quietHoursStart, quietHoursEnd, timezone]
    );

    return true;
  } catch (error) {
    console.error('Error creating notification settings:', error);
    throw error;
  }
};

/**
 * Bildirim ayarlarını güncelle
 */
const updateNotificationSettings = async (userId, settings) => {
  try {
    const updateFields = [];
    const values = [];

    if (settings.notificationsEnabled !== undefined) {
      updateFields.push('notifications_enabled = ?');
      values.push(settings.notificationsEnabled ? 1 : 0);
    }
    if (settings.quietHoursEnabled !== undefined) {
      updateFields.push('quiet_hours_enabled = ?');
      values.push(settings.quietHoursEnabled ? 1 : 0);
    }
    if (settings.reminderInterval !== undefined) {
      updateFields.push('reminder_interval = ?');
      values.push(settings.reminderInterval);
    }
    if (settings.quietHoursStart !== undefined) {
      updateFields.push('quiet_hours_start = ?');
      values.push(settings.quietHoursStart);
    }
    if (settings.quietHoursEnd !== undefined) {
      updateFields.push('quiet_hours_end = ?');
      values.push(settings.quietHoursEnd);
    }
    if (settings.timezone !== undefined) {
      updateFields.push('timezone = ?');
      values.push(settings.timezone);
    }

    if (updateFields.length === 0) return false;

    values.push(userId);
    await pool.execute(
      `UPDATE notification_settings SET ${updateFields.join(', ')} WHERE user_id = ?`,
      values
    );

    return true;
  } catch (error) {
    console.error('Error updating notification settings:', error);
    throw error;
  }
};

/**
 * Kullanıcının bildirim ayarlarını al
 */
const getNotificationSettings = async (userId) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM notification_settings WHERE user_id = ?',
      [userId]
    );

    if (rows.length === 0) {
      await createNotificationSettings(userId);
      const [newRows] = await pool.execute(
        'SELECT * FROM notification_settings WHERE user_id = ?',
        [userId]
      );
      return newRows[0] || null;
    }

    return rows[0];
  } catch (error) {
    console.error('Error getting notification settings:', error);
    throw error;
  }
};

/**
 * Tek kullanıcıya bildirim gönder
 */
const sendUserNotification = async (userId, notificationType, customMessage = null) => {
  try {
    const storageNotificationType = normalizeNotificationTypeForStorage(notificationType);

    const [users] = await pool.execute(
      `SELECT u.id, u.onesignal_player_id, u.preferred_language, ns.*
       FROM users u
       LEFT JOIN notification_settings ns ON u.id = ns.user_id
       WHERE u.id = ? AND u.is_active = 1`,
      [userId]
    );

    if (users.length === 0) {
      return { success: false, reason: 'user_not_found' };
    }

    const user = users[0];

    if (!user.onesignal_player_id) {
      return { success: false, reason: 'no_player_id' };
    }

    if (user.notifications_enabled === 0) {
      return { success: false, reason: 'notifications_disabled' };
    }

    if (user.quiet_hours_enabled &&
      isQuietHours(user.timezone, user.quiet_hours_start, user.quiet_hours_end)) {
      await logNotification(userId, storageNotificationType, '', '', user.preferred_language, null, 'skipped', 'Quiet hours');
      return { success: false, reason: 'quiet_hours' };
    }

    const language = getUserLanguage(user.preferred_language);
    const messageData = customMessage || await getRandomMessage(userId, notificationType, language);

    if (!messageData) {
      return { success: false, reason: 'no_message' };
    }

    try {
      const response = await sendNotification(
        user.onesignal_player_id,
        messageData.title,
        messageData.message,
        { type: notificationType, userId }
      );

      await logNotification(
        userId, storageNotificationType, messageData.title, messageData.message,
        language, response?.body?.id || null, 'sent'
      );
      await updateLastNotificationTime(userId);

      console.log(`✅ Bildirim gönderildi → Kullanıcı ${userId}: ${messageData.message}`);
      return { success: true, messageId: response?.body?.id };

    } catch (error) {
      await logNotification(
        userId, storageNotificationType, messageData.title, messageData.message,
        language, null, 'failed', error.message
      );
      console.error(`❌ Bildirim başarısız → Kullanıcı ${userId}:`, error.message);
      return { success: false, reason: 'send_failed', error: error.message };
    }
  } catch (error) {
    console.error('sendUserNotification hatası:', error);
    return { success: false, reason: 'error', error: error.message };
  }
};

/**
 * Kullanıcının aktivite katmanını belirle
 *
 * @returns {'active' | 'semi_active' | 'passive' | 'very_passive' | null}
 *   active       → bugün açmış
 *   semi_active  → 24-48 saat açılmamış
 *   passive      → 3-5 gün açılmamış
 *   very_passive → 5+ gün (bildirim gönderilmez)
 *   null         → kayıt yok veya veri eksik
 */
const getUserActivityTier = (lastOpenAt) => {
  if (!lastOpenAt) return null;

  const now = new Date();
  const lastOpen = new Date(lastOpenAt);
  const diffHours = (now - lastOpen) / (1000 * 60 * 60);

  if (diffHours < 24) return 'active';
  if (diffHours < 48) return 'semi_active';
  if (diffHours < 120) return 'passive'; // 5 gün
  return 'very_passive';
};

/**
 * Bildirim gonderilecek kullanicilari al (6 saatlik dongu)
 */
const getSixHourEligibleUsers = async () => {
  const [users] = await pool.execute(
    `SELECT u.id, u.onesignal_player_id, u.preferred_language,
            ns.notifications_enabled, ns.reminder_interval,
            ns.quiet_hours_enabled, ns.quiet_hours_start,
            ns.quiet_hours_end, ns.timezone
     FROM users u
     INNER JOIN notification_settings ns ON u.id = ns.user_id
     WHERE u.is_active = 1
       AND u.onesignal_player_id IS NOT NULL
       AND ns.notifications_enabled = 1
       AND (ns.reminder_interval = '6h' OR ns.reminder_interval IS NULL)`
  );

  return users;
};

/**
 * Her 6 saatte bir tum uygun kullanicilara sohbet odakli bildirim gonder
 */
const sendSixHourConversationNotifications = async () => {
  try {
    console.log('🔔 [chatface_6h] 6 saatlik ChatFace bildirimleri basliyor...');
    const users = await getSixHourEligibleUsers();
    console.log(`6 saatlik uygun kullanici sayisi: ${users.length}`);
    return await _sendBatch(users, DEFAULT_NOTIFICATION_TYPE);

  } catch (error) {
    console.error('sendSixHourConversationNotifications hatasi:', error);
    return { error: error.message };
  }
};

/**
 * Geriye donuk uyumluluk icin eski fonksiyon isimleri
 */
const sendActiveEveningNotifications = async () => sendSixHourConversationNotifications();
const sendSemiActiveAfternoonNotifications = async () => sendSixHourConversationNotifications();
const sendSemiActiveEveningNotifications = async () => sendSixHourConversationNotifications();
const sendPassiveEveningNotifications = async () => sendSixHourConversationNotifications();

/**
 * Manuel tetikleme endpoint'i icin zamanlanmis bildirim gonderimi
 */
const sendScheduledReminders = async (interval = '6h') => {
  if (interval !== '6h') {
    return {
      success: false,
      message: 'Only 6h interval is supported',
      sent: 0,
      skipped: 0,
      failed: 0,
      total: 0
    };
  }

  const result = await sendSixHourConversationNotifications();
  return {
    success: !result.error,
    ...result
  };
};

/**
 * Toplu bildirim gönderme yardımcısı
 */
const _sendBatch = async (users, notificationType) => {
  let sent = 0, skipped = 0, failed = 0;

  for (const user of users) {
    if (user.quiet_hours_enabled &&
      isQuietHours(user.timezone, user.quiet_hours_start, user.quiet_hours_end)) {
      skipped++;
      continue;
    }

    const result = await sendUserNotification(user.id, notificationType);

    if (result.success) sent++;
    else if (result.reason === 'quiet_hours') skipped++;
    else failed++;

    // Rate limiting: her 10 bildirimde 1 saniye bekle
    if ((sent + skipped + failed) % 10 === 0) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  console.log(`📊 [${notificationType}] Gönderildi=${sent}, Atlandı=${skipped}, Başarısız=${failed}`);
  return { sent, skipped, failed, total: users.length };
};

/**
 * Uygulama açılışında aktiviteyi kaydet
 */
const recordAppOpen = async (userId) => {
  try {
    await pool.execute(
      `INSERT IGNORE INTO user_activity_logs (user_id, activity_date)
       VALUES (?, CURRENT_DATE())`,
      [userId]
    );
    return true;
  } catch (error) {
    console.error('recordAppOpen hatası:', error);
    throw error;
  }
};

/**
 * Bildirim geçmişini al
 */
const getNotificationHistory = async (userId, limit = 20) => {
  try {
    const [rows] = await pool.execute(
      `SELECT * FROM notification_history
       WHERE user_id = ? AND deleted_at IS NULL
       ORDER BY sent_at DESC
       LIMIT ?`,
      [userId, limit]
    );
    return rows;
  } catch (error) {
    console.error('getNotificationHistory hatası:', error);
    return [];
  }
};

/**
 * Bildirimi okundu olarak işaretle
 */
const markNotificationAsRead = async (notificationId, userId) => {
  try {
    const [result] = await pool.execute(
      `UPDATE notification_history
       SET is_read = 1, read_at = NOW()
       WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
      [notificationId, userId]
    );
    if (result.affectedRows === 0) {
      return { success: false, message: 'Notification not found or already deleted' };
    }
    return { success: true };
  } catch (error) {
    console.error('markNotificationAsRead hatası:', error);
    throw error;
  }
};

/**
 * Tüm bildirimleri okundu olarak işaretle
 */
const markAllNotificationsAsRead = async (userId) => {
  try {
    const [result] = await pool.execute(
      `UPDATE notification_history
       SET is_read = 1, read_at = NOW()
       WHERE user_id = ? AND is_read = 0 AND deleted_at IS NULL`,
      [userId]
    );
    return { success: true, markedCount: result.affectedRows };
  } catch (error) {
    console.error('markAllNotificationsAsRead hatası:', error);
    throw error;
  }
};

/**
 * Tek bildirimi sil (soft delete)
 */
const deleteNotification = async (notificationId, userId) => {
  try {
    const [result] = await pool.execute(
      `UPDATE notification_history
       SET deleted_at = NOW()
       WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
      [notificationId, userId]
    );
    if (result.affectedRows === 0) {
      return { success: false, message: 'Notification not found or already deleted' };
    }
    return { success: true };
  } catch (error) {
    console.error('deleteNotification hatası:', error);
    throw error;
  }
};

/**
 * Kullanıcının tüm bildirimlerini sil (soft delete)
 */
const deleteAllNotifications = async (userId) => {
  try {
    const [result] = await pool.execute(
      `UPDATE notification_history
       SET deleted_at = NOW()
       WHERE user_id = ? AND deleted_at IS NULL`,
      [userId]
    );
    return { success: true, deletedCount: result.affectedRows };
  } catch (error) {
    console.error('deleteAllNotifications hatası:', error);
    throw error;
  }
};

/**
 * Okunmamış bildirim sayısını getir
 */
const getUnreadCount = async (userId) => {
  try {
    const [rows] = await pool.execute(
      `SELECT COUNT(*) as unread_count
       FROM notification_history
       WHERE user_id = ? AND is_read = 0 AND deleted_at IS NULL`,
      [userId]
    );
    return rows[0].unread_count;
  } catch (error) {
    console.error('getUnreadCount hatası:', error);
    throw error;
  }
};

module.exports = {
  // Ayarlar
  createNotificationSettings,
  updateNotificationSettings,
  getNotificationSettings,
  // Tekil gönderim
  sendUserNotification,
  sendScheduledReminders,
  // Katman bazlı toplu gönderim
  sendSixHourConversationNotifications,
  sendActiveEveningNotifications,
  sendSemiActiveAfternoonNotifications,
  sendSemiActiveEveningNotifications,
  sendPassiveEveningNotifications,
  // Aktivite takibi
  recordAppOpen,
  getUserActivityTier,
  // Bildirim geçmişi
  getNotificationHistory,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  deleteNotification,
  deleteAllNotifications,
  getUnreadCount,
  // Yardımcılar
  isQuietHours,
  getUserLanguage,
  SUPPORTED_LANGUAGES
};
