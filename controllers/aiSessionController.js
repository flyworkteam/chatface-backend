const { pool } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');
const { uploadBuffer } = require('../utils/bunny');
const { fetchCachedAudioByKey } = require('../services/ai/ttsCacheService');

const MAX_ATTACHMENT_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 1536;
const THUMBNAIL_DIMENSION = 512;
const SUPPORTED_PERSONA_GENDERS = new Set(['male', 'female']);
const SUPPORTED_SESSION_LANGUAGES = new Set([
  'en', 'tr', 'es', 'fr', 'de', 'pt', 'it', 'ar', 'ja', 'ko', 'zh', 'ru'
]);

const stripInlineFromAttachments = (attachments = []) => {
  if (!Array.isArray(attachments)) {
    return [];
  }

  return attachments
    .map((attachment) => {
      if (!attachment || typeof attachment !== 'object') {
        return null;
      }
      const { inlineBase64, ...rest } = attachment;
      return rest;
    })
    .filter(Boolean);
};

const sanitizeContentForResponse = (content) => {
  if (!content || typeof content !== 'object') {
    return content;
  }

  const sanitized = { ...content };
  if (Array.isArray(content.attachments)) {
    sanitized.attachments = stripInlineFromAttachments(content.attachments);
  }

  return sanitized;
};

const parseJsonField = (payload, { stripInline = false } = {}) => {
  if (!payload) {
    return null;
  }
  if (typeof payload === 'object') {
    return stripInline ? sanitizeContentForResponse(payload) : payload;
  }
  try {
    const parsed = JSON.parse(payload);
    return stripInline ? sanitizeContentForResponse(parsed) : parsed;
  } catch (_error) {
    return payload;
  }
};

const normalizeSessionMode = (mode = 'chat') => {
  const value = typeof mode === 'string' ? mode.toLowerCase() : 'chat';
  if (value === 'voice') {
    return 'voice_call';
  }
  if (value === 'video') {
    return 'video_call';
  }
  if (value === 'voice_call' || value === 'video_call') {
    return value;
  }
  return 'chat';
};

const getConversationEndText = (conversationType) => {
  if (conversationType === 'video_call') {
    return 'Video call ended';
  }
  if (conversationType === 'voice_call') {
    return 'Voice call ended';
  }
  return null;
};

const derivePreviewInfo = (content = {}) => {
  const metadata = content.metadata || {};
  const conversationType = metadata.conversationType || 'chat';
  const conversationStatus = metadata.conversationStatus || 'active';
  const isCallConversation = conversationType === 'voice_call' || conversationType === 'video_call';
  const attachments = Array.isArray(content.attachments) ? content.attachments : [];

  if (isCallConversation && conversationStatus === 'ended') {
    return {
      previewType: 'call_marker',
      previewText: content.displayText || getConversationEndText(conversationType) || 'Call ended',
      lastConversationType: conversationType
    };
  }

  if (attachments.length) {
    return {
      previewType: 'photo',
      previewText: 'Photo',
      lastConversationType: conversationType
    };
  }

  return {
    previewType: 'text',
    previewText: content.displayText || content.text || '',
    lastConversationType: conversationType
  };
};

const ensureSessionOwnership = async ({ sessionId, userId }) => {
  const [rows] = await pool.execute(
    `SELECT id
     FROM ai_sessions
     WHERE id = ? AND user_id = ?
     LIMIT 1`,
    [sessionId, userId]
  );

  return rows[0] || null;
};

const normalizeLanguageCode = (value) => {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized || null;
};

const parseBooleanQuery = (value) => {
  if (typeof value !== 'string') {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === '1';
};

const getActivePersonaById = async (personaId) => {
  const [rows] = await pool.execute(
    `SELECT id
     FROM persona_profiles
     WHERE id = ? AND active = 1
     LIMIT 1`,
    [personaId]
  );

  return rows[0] || null;
};

const createSession = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const {
      personaId,
      languageCode: requestedLanguageCode,
      mode = 'chat'
    } = req.body;
    const languageCode = normalizeLanguageCode(requestedLanguageCode) || 'en';
    const sessionMode = normalizeSessionMode(mode);

    if (!personaId) {
      return res.status(400).json({
        success: false,
        message: 'personaId is required'
      });
    }

    if (!SUPPORTED_SESSION_LANGUAGES.has(languageCode)) {
      return res.status(400).json({
        success: false,
        message: `Unsupported languageCode. Supported values: ${[...SUPPORTED_SESSION_LANGUAGES].join(', ')}`
      });
    }

    const [existingRows] = await pool.execute(
      `SELECT id
       FROM ai_sessions
       WHERE user_id = ? AND persona_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId, personaId]
    );

    if (existingRows.length) {
      const existingSessionId = existingRows[0].id;
      await pool.execute(
        `UPDATE ai_sessions
         SET language_code = ?, mode = ?, last_seen_at = NOW()
         WHERE id = ?`,
        [languageCode, sessionMode, existingSessionId]
      );

      return res.json({
        success: true,
        data: {
          sessionId: existingSessionId,
          reused: true
        }
      });
    }

    const sessionId = uuidv4();

    await pool.execute(
      `INSERT INTO ai_sessions (id, user_id, persona_id, language_code, mode, last_seen_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [sessionId, userId, personaId, languageCode, sessionMode]
    );

    res.json({
      success: true,
      data: {
        sessionId,
        reused: false
      }
    });
  } catch (error) {
    next(error);
  }
};

const listPersonas = async (req, res, next) => {
  try {
    const requestedGender = typeof req.query.gender === 'string'
      ? req.query.gender.trim().toLowerCase()
      : null;
    const followedOnly = parseBooleanQuery(req.query.followedOnly);

    if (requestedGender && !SUPPORTED_PERSONA_GENDERS.has(requestedGender)) {
      return res.status(400).json({
        success: false,
        message: `Unsupported gender filter. Supported values: ${[...SUPPORTED_PERSONA_GENDERS].join(', ')}`
      });
    }

    const queryParams = [];
    const genderClause = requestedGender ? ' AND p.gender = ?' : '';
    const followedClause = followedOnly ? ' AND upf.user_id IS NOT NULL' : '';
    const orderClause = followedOnly
      ? 'upf.created_at DESC, p.sort_order ASC, p.name ASC, pv.language_code ASC'
      : 'p.sort_order ASC, p.name ASC, pv.language_code ASC';
    if (requestedGender) {
      queryParams.push(requestedGender);
    }

    queryParams.unshift(req.user.id);

    const [rows] = await pool.execute(
      `SELECT p.*, 
              upf.created_at AS followed_at,
              CASE WHEN upf.user_id IS NULL THEN FALSE ELSE TRUE END AS is_followed,
              pv.language_code AS voice_language_code,
              pv.elevenlabs_voice_id AS voice_elevenlabs_voice_id,
              pv.stability AS voice_stability,
              pv.style AS voice_style,
              pv.timbre AS voice_timbre,
              pv.lip_sync_preset AS voice_lip_sync_preset,
              pv.sample_rate AS voice_sample_rate
       FROM persona_profiles p
       LEFT JOIN user_persona_follows upf
         ON upf.persona_id = p.id
        AND upf.user_id = ?
       LEFT JOIN persona_voices pv ON pv.persona_id = p.id
       WHERE p.active = 1${genderClause}${followedClause}
       ORDER BY ${orderClause}`,
      queryParams
    );

    const grouped = rows.reduce((acc, row) => {
      const {
        followed_at: followedAt,
        is_followed: isFollowed,
        voice_language_code: voiceLanguageCode,
        voice_elevenlabs_voice_id: voiceId,
        voice_stability: voiceStability,
        voice_style: voiceStyle,
        voice_timbre: voiceTimbre,
        voice_lip_sync_preset: voiceLipSyncPreset,
        voice_sample_rate: voiceSampleRate,
        ...personaColumns
      } = row;

      const persona = acc[row.id] || {
        ...personaColumns,
        defaultLanguage: personaColumns.default_language,
        followedAt,
        isFollowed: !!isFollowed,
        voices: [],
        availableLanguageCodes: []
      };

      if (voiceLanguageCode) {
        persona.voices.push({
          languageCode: voiceLanguageCode,
          voiceId,
          stability: voiceStability,
          style: voiceStyle,
          timbre: voiceTimbre,
          lipSyncPreset: voiceLipSyncPreset,
          sampleRate: voiceSampleRate
        });
        if (!persona.availableLanguageCodes.includes(voiceLanguageCode)) {
          persona.availableLanguageCodes.push(voiceLanguageCode);
        }
      }

      persona.selectedLanguage = persona.defaultLanguage || persona.availableLanguageCodes[0] || 'en';
      acc[row.id] = persona;
      return acc;
    }, {});

    res.json({
      success: true,
      data: Object.values(grouped)
    });
  } catch (error) {
    next(error);
  }
};

const updateSessionLanguagePreference = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const sessionId = req.params.sessionId;
    const languageCode = normalizeLanguageCode(req.body?.languageCode);

    if (!languageCode || !SUPPORTED_SESSION_LANGUAGES.has(languageCode)) {
      return res.status(400).json({
        success: false,
        message: `Unsupported languageCode. Supported values: ${[...SUPPORTED_SESSION_LANGUAGES].join(', ')}`
      });
    }

    const session = await ensureSessionOwnership({ sessionId, userId });
    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }

    await pool.execute(
      `UPDATE ai_sessions
       SET language_code = ?, last_seen_at = NOW()
       WHERE id = ?`,
      [languageCode, sessionId]
    );

    res.json({
      success: true,
      data: {
        sessionId,
        languageCode
      }
    });
  } catch (error) {
    next(error);
  }
};

const followPersona = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const personaId = req.params.personaId;
    const persona = await getActivePersonaById(personaId);

    if (!persona) {
      return res.status(404).json({
        success: false,
        message: 'Persona not found'
      });
    }

    await pool.execute(
      `INSERT INTO user_persona_follows (user_id, persona_id)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE created_at = created_at`,
      [userId, personaId]
    );

    res.json({
      success: true,
      data: {
        personaId,
        isFollowed: true
      }
    });
  } catch (error) {
    next(error);
  }
};

const unfollowPersona = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const personaId = req.params.personaId;
    const persona = await getActivePersonaById(personaId);

    if (!persona) {
      return res.status(404).json({
        success: false,
        message: 'Persona not found'
      });
    }

    await pool.execute(
      `DELETE FROM user_persona_follows
       WHERE user_id = ? AND persona_id = ?`,
      [userId, personaId]
    );

    res.json({
      success: true,
      data: {
        personaId,
        isFollowed: false
      }
    });
  } catch (error) {
    next(error);
  }
};

const getConversationHistory = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const limitParam = parseInt(req.query.limit, 10);
    const limit = Math.min(Math.max(Number.isFinite(limitParam) ? limitParam : 20, 1), 100);

    const [rows] = await pool.execute(
      `SELECT s.id AS session_id,
              s.persona_id,
              s.language_code,
              s.mode,
              p.name AS persona_name,
              p.description AS persona_description,
              p.default_language AS persona_default_language,
              latest.last_message_id,
              sm.content_json,
              sm.created_at
       FROM ai_sessions s
       INNER JOIN (
         SELECT session_id, MAX(id) AS last_message_id
         FROM session_messages
         GROUP BY session_id
       ) latest ON latest.session_id = s.id
       LEFT JOIN session_messages sm ON sm.id = latest.last_message_id
       LEFT JOIN persona_profiles p ON p.id = s.persona_id
       WHERE s.user_id = ?
       ORDER BY sm.created_at DESC
       LIMIT ?`,
      [userId, limit]
    );

    const history = rows
      .map((row) => {
        const parsedContent = parseJsonField(row.content_json, { stripInline: true }) || {};
        const preview = derivePreviewInfo(parsedContent);

        return {
          sessionId: row.session_id,
          lastMessageId: row.last_message_id,
          previewText: preview.previewText,
          previewType: preview.previewType,
          lastConversationType: preview.lastConversationType || row.mode,
          updatedAt: row.created_at,
          persona: row.persona_id
            ? {
              id: row.persona_id,
              name: row.persona_name,
              description: row.persona_description,
              defaultLanguage: row.persona_default_language
            }
            : null,
          session: {
            mode: row.mode,
            language: row.language_code
          }
        };
      });

    res.json({
      success: true,
      data: history,
      meta: {
        limit
      }
    });
  } catch (error) {
    next(error);
  }
};

const getConversationMessages = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const sessionId = req.params.sessionId;
    const limitParam = parseInt(req.query.limit, 10);
    const beforeIdParam = parseInt(req.query.beforeId, 10);
    const limit = Math.min(Math.max(Number.isFinite(limitParam) ? limitParam : 30, 1), 100);
    const beforeId = Number.isFinite(beforeIdParam) ? beforeIdParam : null;

    const session = await ensureSessionOwnership({ sessionId, userId });
    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }

    const conditions = ['sm.session_id = ?'];
    const params = [sessionId];
    if (beforeId) {
      conditions.push('sm.id < ?');
      params.push(beforeId);
    }
    params.push(limit);

    const [rows] = await pool.execute(
      `SELECT sm.id, sm.role, sm.content_json, sm.created_at
       FROM session_messages sm
       WHERE ${conditions.join(' AND ')}
       ORDER BY sm.id DESC
       LIMIT ?`,
      params
    );

    const messages = rows.map((row) => {
      const parsed = parseJsonField(row.content_json, { stripInline: true }) || {};
      return {
        id: row.id,
        role: row.role,
        text: parsed.text || '',
        metadata: parsed.metadata || {},
        attachments: Array.isArray(parsed.attachments) ? parsed.attachments : [],
        createdAt: row.created_at
      };
    });

    const nextBeforeId = rows.length === limit ? rows[rows.length - 1].id : null;

    res.json({
      success: true,
      data: messages,
      meta: {
        limit,
        nextBeforeId
      }
    });
  } catch (error) {
    next(error);
  }
};

const uploadImageAttachment = async (req, res, next) => {
  try {
    const file = req.file;
    if (!file || !file.buffer) {
      return res.status(400).json({
        success: false,
        message: 'Image file is required'
      });
    }

    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      return res.status(400).json({
        success: false,
        message: 'Only image uploads are supported'
      });
    }

    if (file.size > MAX_ATTACHMENT_UPLOAD_BYTES) {
      return res.status(400).json({
        success: false,
        message: 'Image exceeds 5MB limit'
      });
    }

    const baseKey = `messages/${req.user.id}`;
    const timestamp = Date.now();
    const uniqueId = uuidv4();
    const objectKey = `${baseKey}/${timestamp}-${uniqueId}.jpg`;
    const thumbKey = `${baseKey}/thumb-${timestamp}-${uniqueId}.jpg`;

    const optimizedBuffer = await sharp(file.buffer)
      .rotate()
      .resize({
        width: MAX_IMAGE_DIMENSION,
        height: MAX_IMAGE_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true
      })
      .jpeg({ quality: 82 })
      .toBuffer();

    const optimizedMeta = await sharp(optimizedBuffer).metadata();

    const thumbnailBuffer = await sharp(optimizedBuffer)
      .resize({
        width: THUMBNAIL_DIMENSION,
        height: THUMBNAIL_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true
      })
      .jpeg({ quality: 70 })
      .toBuffer();

    const [url, thumbnailUrl] = await Promise.all([
      uploadBuffer(optimizedBuffer, objectKey, 'image/jpeg'),
      uploadBuffer(thumbnailBuffer, thumbKey, 'image/jpeg')
    ]);

    res.json({
      success: true,
      data: {
        attachment: {
          url,
          thumbnailUrl,
          width: optimizedMeta.width,
          height: optimizedMeta.height,
          mimeType: 'image/jpeg',
          sizeBytes: optimizedBuffer.length,
          inlineBase64: thumbnailBuffer.toString('base64')
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

const getTtsCacheAudio = async (req, res, next) => {
  try {
    const cacheKey = req.params.cacheKey;

    if (!/^[a-f0-9]{40}$/i.test(cacheKey || '')) {
      return res.status(400).json({
        success: false,
        message: 'Invalid cache key'
      });
    }

    const cached = await fetchCachedAudioByKey({ cacheKey });
    if (!cached?.audioBase64) {
      return res.status(404).json({
        success: false,
        message: 'Audio not found'
      });
    }

    const audioBuffer = Buffer.from(cached.audioBase64, 'base64');
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(audioBuffer);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createSession,
  listPersonas,
  followPersona,
  unfollowPersona,
  updateSessionLanguagePreference,
  getConversationHistory,
  getConversationMessages,
  uploadImageAttachment,
  getTtsCacheAudio
};
