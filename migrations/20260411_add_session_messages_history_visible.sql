ALTER TABLE session_messages
  ADD COLUMN history_visible TINYINT(1) NOT NULL DEFAULT 1 AFTER content_json;

CREATE INDEX idx_session_messages_session_history_id
  ON session_messages (session_id, history_visible, id);
