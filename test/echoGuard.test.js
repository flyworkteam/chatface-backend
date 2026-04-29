const test = require('node:test');
const assert = require('node:assert/strict');

const {
  rememberAssistantSpeech,
  findEchoMatch,
  clearSessionSpeech
} = require('../services/ai/echoGuard');

test('echoGuard does not suppress short subset after grace window', () => {
  const sessionId = 'echo-session-1';
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;

  try {
    rememberAssistantSpeech({
      sessionId,
      text: "I am doing well, thank you. How are you?",
      playbackId: 'pb-1'
    });

    now += 18_000;

    const match = findEchoMatch({
      sessionId,
      transcript: 'How are you?'
    });

    assert.equal(match, null);
  } finally {
    clearSessionSpeech(sessionId);
    Date.now = realNow;
  }
});

test('echoGuard still suppresses near-full repeat after grace window', () => {
  const sessionId = 'echo-session-2';
  const realNow = Date.now;
  let now = 2_000_000;
  Date.now = () => now;

  try {
    rememberAssistantSpeech({
      sessionId,
      text: "I am doing well, thank you. How are you?",
      playbackId: 'pb-2'
    });

    now += 18_000;

    const match = findEchoMatch({
      sessionId,
      transcript: "I am doing well, thank you. How are you?"
    });

    assert.ok(match);
    assert.equal(match.reason, 'full_match');
  } finally {
    clearSessionSpeech(sessionId);
    Date.now = realNow;
  }
});
