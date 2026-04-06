/**
 * ChatFace Notification Scheduler
 *
 * Cron job ile 6 saatte bir sohbet odakli bildirimleri gonderir.
 */

const cron = require('node-cron');
const notificationService = require('../services/notificationService');

let scheduledJobs = {};

/**
 * Tüm zamanlanmış görevleri başlat
 */
const startScheduler = () => {
  console.log('🕐 ChatFace bildirim scheduler baslatiliyor...');

  // Her 6 saatte bir: 00:00, 06:00, 12:00, 18:00
  scheduledJobs['chatface_6h'] = cron.schedule('0 */6 * * *', async () => {
    console.log('⏰ [chatface_6h] 6 saatlik bildirim gonderimi...');
    try {
      const result = await notificationService.sendSixHourConversationNotifications();
      console.log('✅ [chatface_6h]', result);
    } catch (error) {
      console.error('❌ [chatface_6h]', error.message);
    }
  }, {
    scheduled: true,
    timezone: 'Europe/Istanbul'
  });

  console.log('✅ ChatFace Scheduler aktif:');
  console.log('   - chatface_6h          → Her 6 saatte bir');
};

/**
 * Tüm zamanlanmış görevleri durdur
 */
const stopScheduler = () => {
  console.log('🛑 ChatFace scheduler durduruluyor...');
  Object.keys(scheduledJobs).forEach(key => {
    if (scheduledJobs[key]) {
      scheduledJobs[key].stop();
      console.log(`   - ${key} durduruldu`);
    }
  });
  scheduledJobs = {};
  console.log('✅ Scheduler durduruldu.');
};

/**
 * Belirli bir job'u yeniden başlat
 */
const restartJob = (jobKey) => {
  if (scheduledJobs[jobKey]) {
    scheduledJobs[jobKey].stop();
    scheduledJobs[jobKey].start();
    console.log(`🔄 ${jobKey} yeniden başlatıldı`);
  }
};

/**
 * Scheduler durumunu al
 */
const getSchedulerStatus = () => {
  const status = {};
  Object.keys(scheduledJobs).forEach(key => {
    status[key] = { running: !!scheduledJobs[key] };
  });
  return status;
};

module.exports = {
  startScheduler,
  stopScheduler,
  restartJob,
  getSchedulerStatus
};
