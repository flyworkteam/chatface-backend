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
  uploadImageAttachment,
  startCall,
  endCall,
  getSessionCallState,
  getSessionFillerAudio
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

// Call lifecycle — must be invoked before / after WS stream attach.
// See REWRITE_ARCHITECTURE.md §4.
router.post('/session/:sessionId/call/start', startCall);
router.post('/session/:sessionId/call/end', endCall);
router.get('/session/:sessionId/call/state', getSessionCallState);
router.get('/session/:sessionId/call/filler-audio', getSessionFillerAudio);

module.exports = router;
