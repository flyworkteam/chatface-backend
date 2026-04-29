const { createVoiceGateway, isVoiceStreamingEnabled } = require('./voiceGateway');
const { createVideoGateway, isVideoCallEnabled } = require('./videoGateway');
const { createVisemeRouter } = require('./visemeRouter');

module.exports = {
  createVoiceGateway,
  createVideoGateway,
  createVisemeRouter,
  isVoiceStreamingEnabled,
  isVideoCallEnabled
};
