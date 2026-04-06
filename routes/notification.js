/**
 * ChatFace Notification Routes
 * 
 * Bildirim API rotaları
 */

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const notificationController = require('../controllers/notificationController');

// Tüm rotalar için authentication gerekli
router.use(authenticateToken);

// ============================================
// Bildirim Ayarları
// ============================================

/**
 * @route   GET /api/notifications/settings
 * @desc    Kullanıcının bildirim ayarlarını getir
 * @access  Private
 */
router.get('/settings', notificationController.getNotificationSettings);

/**
 * @route   PUT /api/notifications/settings
 * @desc    Bildirim ayarlarını güncelle
 * @access  Private
 * @body    {notificationsEnabled, reminderInterval, quietHoursEnabled, quietHoursStart, quietHoursEnd, timezone}
 */
router.put('/settings', notificationController.updateNotificationSettings);

/**
 * @route   POST /api/notifications/toggle
 * @desc    Bildirimleri aç/kapat
 * @access  Private
 * @body    {enabled: boolean}
 */
router.post('/toggle', notificationController.toggleNotifications);

/**
 * @route   POST /api/notifications/interval
 * @desc    Bildirim aralığını güncelle
 * @access  Private
 * @body    {interval: '6h' | 'off'}
 */
router.post('/interval', notificationController.updateReminderInterval);

// ============================================
// Bildirim Aralıkları
// ============================================

/**
 * @route   GET /api/notifications/intervals
 * @desc    Mevcut bildirim aralıklarını ve açıklamalarını getir
 * @access  Private
 */
router.get('/intervals', notificationController.getAvailableIntervals);

// ============================================
// Egzersiz Aktivitesi
// ============================================

/**
 * @route   GET /api/notifications/activity
 * @desc    Kullanıcının egzersiz aktivitesini getir (streak, toplam vb.)
 * @access  Private
 */
router.get('/activity', notificationController.getExerciseActivity);

/**
 * @route   POST /api/notifications/exercise-completed
 * @desc    Egzersiz tamamlandığını kaydet
 * @access  Private
 */
router.post('/exercise-completed', notificationController.exerciseCompleted);

// ============================================
// Bildirim Geçmişi
// ============================================

/**
 * @route   GET /api/notifications/history
 * @desc    Bildirim geçmişini getir
 * @access  Private
 * @query   limit (default: 20, max: 100)
 */
router.get('/history', notificationController.getNotificationHistory);

// ============================================
// Bildirim Yönetimi (Read/Delete)
// ============================================

/**
 * @route   PATCH /api/notifications/:id/read
 * @desc    Bildirimi okundu olarak işaretle
 * @access  Private
 */
router.patch('/:id/read', notificationController.markAsRead);

/**
 * @route   PATCH /api/notifications/read-all
 * @desc    Tüm bildirimleri okundu olarak işaretle
 * @access  Private
 */
router.patch('/read-all', notificationController.markAllAsRead);

/**
 * @route   DELETE /api/notifications/all
 * @desc    Tüm bildirimleri sil
 * @access  Private
 */
router.delete('/all', notificationController.deleteAllNotifications);

/**
 * @route   DELETE /api/notifications/:id
 * @desc    Tek bildirimi sil
 * @access  Private
 */
router.delete('/:id', notificationController.deleteNotification);

/**
 * @route   GET /api/notifications/unread-count
 * @desc    Okunmamış bildirim sayısını getir
 * @access  Private
 */
router.get('/unread-count', notificationController.getUnreadCount);

// ============================================
// Test & Admin
// ============================================

/**
 * @route   POST /api/notifications/test
 * @desc    Test bildirimi gönder (sadece development)
 * @access  Private (development only)
 * @body    {type: 'chatface_conversation_reminder'}
 */
router.post('/test', notificationController.sendTestNotification);

/**
 * @route   POST /api/notifications/trigger-scheduled
 * @desc    Zamanlanmış bildirimleri manuel tetikle (admin only)
 * @access  Admin
 * @headers X-Admin-Key
 * @body    {interval: '6h'}
 */
router.post('/trigger-scheduled', notificationController.triggerScheduledNotifications);

module.exports = router;
