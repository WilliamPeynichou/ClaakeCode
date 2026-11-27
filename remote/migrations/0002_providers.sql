-- Claake Ask: model subscriptions connected from the phone (Claude, ChatGPT, Gemini, Kimi, Mistral).
-- Credentials are AES-GCM encrypted with the Worker secret PROVIDER_ENCRYPTION_KEY.
CREATE TABLE provider_accounts (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  label TEXT,
  secret TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider)
);

-- A sign-in started on the phone, finished when the user pastes the code (or Kimi confirms the device).
CREATE TABLE provider_logins (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  secret TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
