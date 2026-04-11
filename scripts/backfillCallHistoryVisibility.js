#!/usr/bin/env node

require('dotenv').config();
const { pool } = require('../config/database');

const BATCH_SIZE = 500;
const CALL_TYPES = new Set(['voice_call', 'video_call']);
const CALL_END_TEXTS = new Set(['Voice call ended', 'Video call ended']);

const parseContent = (raw) => {
  if (!raw) {
    return {};
  }
  if (typeof raw === 'object') {
    return raw;
  }
  try {
    return JSON.parse(raw);
  } catch (_error) {
    return {};
  }
};

const normalizeConversationType = (content = {}) => {
  const metadataType = content?.metadata?.conversationType;
  if (typeof metadataType !== 'string') {
    return null;
  }
  const value = metadataType.trim().toLowerCase();
  return value || null;
};

const normalizeConversationStatus = (content = {}) => {
  const metadataStatus = content?.metadata?.conversationStatus;
  const value = typeof metadataStatus === 'string' ? metadataStatus.trim().toLowerCase() : '';
  return value || 'active';
};

const shouldHideMessage = ({ row, inCallWindow }) => {
  const content = parseContent(row.content_json);
  const type = normalizeConversationType(content);
  const status = normalizeConversationStatus(content);
  const text = typeof content?.text === 'string' ? content.text.trim() : '';

  if (type && CALL_TYPES.has(type)) {
    return {
      hide: true,
      nextInCallWindow: status !== 'ended'
    };
  }

  if (type) {
    return {
      hide: false,
      nextInCallWindow: false
    };
  }

  if (CALL_END_TEXTS.has(text)) {
    return {
      hide: true,
      nextInCallWindow: false
    };
  }

  if (inCallWindow && (row.role === 'user' || row.role === 'assistant')) {
    return {
      hide: true,
      nextInCallWindow: true
    };
  }

  return {
    hide: false,
    nextInCallWindow: false
  };
};

const chunk = (items, size) => {
  const result = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
};

const run = async () => {
  const dryRun = process.argv.includes('--dry-run');
  console.log(`[backfill] call history visibility started (dryRun=${dryRun})`);

  const [rows] = await pool.execute(
    `SELECT id, session_id, role, content_json
     FROM session_messages
     ORDER BY session_id ASC, id ASC`
  );

  let currentSessionId = null;
  let inCallWindow = false;
  const idsToHide = [];

  for (const row of rows) {
    if (row.session_id !== currentSessionId) {
      currentSessionId = row.session_id;
      inCallWindow = false;
    }

    const decision = shouldHideMessage({ row, inCallWindow });
    if (decision.hide) {
      idsToHide.push(row.id);
    }
    inCallWindow = decision.nextInCallWindow;
  }

  console.log(`[backfill] scanned=${rows.length} hideCandidates=${idsToHide.length}`);

  if (!dryRun && idsToHide.length > 0) {
    const groups = chunk(idsToHide, BATCH_SIZE);
    for (const group of groups) {
      const placeholders = group.map(() => '?').join(', ');
      await pool.execute(
        `UPDATE session_messages
         SET history_visible = 0
         WHERE id IN (${placeholders})`,
        group
      );
    }
    console.log(`[backfill] updatedRows=${idsToHide.length} batches=${groups.length}`);
  }

  console.log('[backfill] done');
};

run()
  .catch((error) => {
    console.error('[backfill] failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
