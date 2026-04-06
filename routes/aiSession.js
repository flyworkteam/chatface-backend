const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const multer = require('multer');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});
const {
  createSession,
  listPersonas,
  followPersona,
  unfollowPersona,
  updateSessionLanguagePreference,
  getConversationHistory,
  getConversationMessages,
  uploadImageAttachment
} = require('../controllers/aiSessionController');

router.use(authenticateToken);

router.get('/personas', listPersonas);
router.post('/personas/:personaId/follow', followPersona);
router.delete('/personas/:personaId/follow', unfollowPersona);
router.get('/history', getConversationHistory);
router.get('/history/:sessionId/messages', getConversationMessages);
router.post('/attachments/image', upload.single('file'), uploadImageAttachment);
router.post('/session', createSession);
router.patch('/session/:sessionId/language', updateSessionLanguagePreference);

module.exports = router;
