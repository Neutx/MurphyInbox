-- Web Push: one row per browser or installed app that turned on notifications. The endpoint is the
-- push service URL (Apple, Google, Mozilla); p256dh and auth are the device's encryption keys.
CREATE TABLE push_subscriptions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  last_success_at INTEGER,
  failures INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX push_subscriptions_user ON push_subscriptions (user_id);
