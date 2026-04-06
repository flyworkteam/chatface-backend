require('dotenv').config();

/**
 * n8n Webhook Configuration
 * This will be configured later when n8n webhook URLs are available
 */

const n8nConfig = {
  baseUrl: process.env.N8N_WEBHOOK_BASE_URL || '',
  webhookSecret: process.env.N8N_WEBHOOK_SECRET || '',
  
  // Webhook endpoints (to be configured)
  webhooks: {
    userRegistered: '/user-registered',
    onboardingCompleted: '/onboarding-completed',
    faceScanCompleted: '/face-scan-completed'
  }
};

/**
 * Check if n8n is configured
 * @returns {Boolean}
 */
const isN8nConfigured = () => {
  return !!(n8nConfig.baseUrl && n8nConfig.webhookSecret);
};

/**
 * Get full webhook URL
 * @param {String} webhookPath - Webhook path from config
 * @returns {String} Full webhook URL
 */
const getWebhookUrl = (webhookPath) => {
  if (!isN8nConfigured()) {
    console.warn('⚠️ n8n is not configured yet');
    return null;
  }
  return `${n8nConfig.baseUrl}${webhookPath}`;
};

module.exports = {
  n8nConfig,
  isN8nConfigured,
  getWebhookUrl
};
