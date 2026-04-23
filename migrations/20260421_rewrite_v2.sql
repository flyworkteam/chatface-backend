







ALTER TABLE ai_sessions
  ADD COLUMN call_locked_language CHAR(5) NULL
   ,
  ADD COLUMN active_mode ENUM('chat','voice_call','video_call') NOT NULL DEFAULT 'chat'
    ,
  ADD COLUMN active_call_started_at DATETIME NULL
    ;


ALTER TABLE ai_sessions
  CHANGE COLUMN mode preferred_mode ENUM('chat','voice_call','video_call') NOT NULL DEFAULT 'chat'
    ;

CREATE INDEX idx_ai_sessions_active_mode ON ai_sessions (active_mode, active_call_started_at);





ALTER TABLE persona_voices
  ADD COLUMN filler_voice_id VARCHAR(64) NULL
   ,
  ADD COLUMN filler_style_tag VARCHAR(32) NULL
   ;





CREATE TABLE IF NOT EXISTS filler_audio_cache (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  persona_id CHAR(36) NOT NULL,
  language_code CHAR(5) NOT NULL,
  scenario ENUM(
    'thinking_short',
    'thinking_long',
    'cant_understand',
    'wrong_language',
    'network_hiccup',
    'cold_start'
  ) NOT NULL,
  variant_index TINYINT UNSIGNED NOT NULL DEFAULT 0,
  text VARCHAR(280) NOT NULL,
  cdn_url VARCHAR(512) NOT NULL,
  duration_ms INT UNSIGNED NOT NULL,
  mouth_cues_json JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_persona_lang_scenario_variant
    (persona_id, language_code, scenario, variant_index),
  KEY idx_scenario_lang (scenario, language_code),
  CONSTRAINT fk_filler_persona FOREIGN KEY (persona_id)
    REFERENCES persona_profiles(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;



















