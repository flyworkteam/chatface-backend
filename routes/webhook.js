const express = require('express');
const router = express.Router();
const revenueCatController = require('../controllers/revenueCatController');

// RevenueCat Webhook Endpoint
// POST /api/webhooks/revenuecat
router.post('/revenuecat', revenueCatController.handleWebhook);


module.exports = router;
