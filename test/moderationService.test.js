const test = require('node:test');
const assert = require('node:assert/strict');

const { summarizeModerationResult } = require('../services/ai/moderationService');
const {
  buildModerationErrorPayload,
  buildModerationLogPayload
} = require('../services/ai/chatOrchestrator');

test('moderation summary returns reason, flagged categories, and rounded scores', () => {
  const summary = summarizeModerationResult({
    categories: {
      harassment: true,
      violence: false,
      sexual: true
    },
    category_scores: {
      harassment: 0.924391,
      violence: 0.04711,
      sexual: 0.22129,
      self_harm: 0.11223
    }
  });

  assert.equal(summary.reason, 'harassment, sexual');
  assert.deepEqual(summary.flaggedCategories, ['harassment', 'sexual']);
  assert.deepEqual(summary.categoryScores, {
    harassment: 0.9244,
    sexual: 0.2213,
    self_harm: 0.1122
  });
});

test('moderation blocked payloads keep generic client copy with structured diagnostics', () => {
  const moderationResult = {
    blocked: true,
    reason: 'harassment',
    flaggedCategories: ['harassment'],
    categoryScores: { harassment: 0.91 }
  };
  const session = { id: 'session-1' };
  const user = { id: 9 };
  const metadata = { transcriptId: 'transcript-1' };

  const logPayload = buildModerationLogPayload({
    session,
    user,
    sessionMode: 'video_call',
    text: 'Please tell me a long story.',
    metadata,
    moderationResult
  });
  const errorPayload = buildModerationErrorPayload(moderationResult);

  assert.deepEqual(logPayload, {
    sessionId: 'session-1',
    userId: 9,
    transcriptId: 'transcript-1',
    mode: 'video_call',
    textPreview: 'Please tell me a long story.',
    reason: 'harassment',
    flaggedCategories: ['harassment'],
    categoryScores: { harassment: 0.91 }
  });
  assert.deepEqual(errorPayload, {
    type: 'moderation',
    code: 'moderation',
    message: 'Message blocked',
    reason: 'harassment'
  });
});
