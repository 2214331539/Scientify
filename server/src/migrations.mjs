// Numbered schema changes, applied once each in order after the base schema (db.mjs).
// Never edit a migration that has shipped; add a new one.

export const migrations = [
  {
    id: 1,
    name: 'billing and admin',
    sql: `
ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_reason TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_role TEXT;
-- Points used past zero by requests that were already running; new grants pay it first.
ALTER TABLE users ADD COLUMN IF NOT EXISTS credit_debt BIGINT NOT NULL DEFAULT 0;

-- Days a user made at least one request, in China time; for daily active counts.
CREATE TABLE user_activity (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  PRIMARY KEY (user_id, day)
);
CREATE INDEX user_activity_day ON user_activity(day);

CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'personal',
  price_month INTEGER NOT NULL DEFAULT 0,
  price_year INTEGER NOT NULL DEFAULT 0,
  monthly_points BIGINT NOT NULL,
  daily_points BIGINT NOT NULL,
  storage_bytes BIGINT NOT NULL,
  max_members INTEGER,
  history_days INTEGER NOT NULL,
  rpm INTEGER NOT NULL,
  concurrency INTEGER NOT NULL,
  max_output_tokens INTEGER NOT NULL DEFAULT 32768,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO plans(id, name, kind, price_month, price_year, monthly_points, daily_points,
                  storage_bytes, max_members, history_days, rpm, concurrency, active, sort)
VALUES ('free', '免费', 'personal', 0, 0, 300, 400, 2147483648, 5, 7, 30, 2, TRUE, 0),
       ('pro', '个人专业版', 'personal', 2900, 28800, 3000, 1000, 53687091200, 20, 365, 60, 4, TRUE, 1),
       ('team', '课题组版', 'team', 3900, 38800, 3000, 1000, 53687091200, NULL, 365, 60, 6, FALSE, 2);

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL,
  order_id TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_at TIMESTAMPTZ
);
CREATE INDEX subscriptions_user ON subscriptions(user_id, ends_at);

-- Every batch of points a user received, with what is left of it.
CREATE TABLE credit_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  source_key TEXT,
  points BIGINT NOT NULL,
  points_left BIGINT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  note TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expired_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX credit_grants_key ON credit_grants(user_id, source_key) WHERE source_key IS NOT NULL;
CREATE INDEX credit_grants_user ON credit_grants(user_id, expires_at);

-- Every change to a user's points. Rows are only added.
CREATE TABLE credit_ledger (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  grant_id TEXT,
  delta BIGINT NOT NULL,
  reason TEXT NOT NULL,
  usage_id TEXT,
  admin_id TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX credit_ledger_user ON credit_ledger(user_id, created_at);

CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  chat_endpoint TEXT,
  key_cipher TEXT NOT NULL,
  key_hint TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Prices: cost in yuan and price in points, both per million tokens.
CREATE TABLE models (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT '标准',
  upstream TEXT NOT NULL,
  channel_id TEXT NOT NULL REFERENCES channels(id),
  backup_channel_id TEXT REFERENCES channels(id),
  cost_input NUMERIC NOT NULL DEFAULT 0,
  cost_cached NUMERIC NOT NULL DEFAULT 0,
  cost_output NUMERIC NOT NULL DEFAULT 0,
  price_input BIGINT NOT NULL DEFAULT 0,
  price_cached BIGINT NOT NULL DEFAULT 0,
  price_output BIGINT NOT NULL DEFAULT 0,
  plans TEXT[] NOT NULL DEFAULT '{}',
  active BOOLEAN NOT NULL DEFAULT FALSE,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  sort INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per model request: counts only, never what was asked or answered.
CREATE TABLE usage_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  channel_id TEXT,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  cached_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  reasoning_tokens BIGINT NOT NULL DEFAULT 0,
  points BIGINT NOT NULL DEFAULT 0,
  cost_micros BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  estimated BOOLEAN NOT NULL DEFAULT FALSE,
  http_status INTEGER,
  latency_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX usage_events_user ON usage_events(user_id, created_at);
CREATE INDEX usage_events_time ON usage_events(created_at);

CREATE TABLE usage_daily (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  model_id TEXT NOT NULL,
  requests BIGINT NOT NULL DEFAULT 0,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  cached_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  points BIGINT NOT NULL DEFAULT 0,
  cost_micros BIGINT NOT NULL DEFAULT 0,
  estimated_requests BIGINT NOT NULL DEFAULT 0,
  error_requests BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, model_id)
);
CREATE INDEX usage_daily_day ON usage_daily(day);

-- Long-lived tokens that may only call the official models, one per device.
CREATE TABLE model_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX model_tokens_user ON model_tokens(user_id);

CREATE TABLE user_limits (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  rpm INTEGER,
  concurrency INTEGER,
  daily_points BIGINT,
  until TIMESTAMPTZ,
  reason TEXT,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE redeem_batches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('plan', 'points')),
  plan_id TEXT REFERENCES plans(id),
  months INTEGER,
  points BIGINT,
  valid_days INTEGER,
  count INTEGER NOT NULL,
  redeem_until TIMESTAMPTZ NOT NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  voided_at TIMESTAMPTZ
);
CREATE TABLE redeem_codes (
  code_hash TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES redeem_batches(id) ON DELETE CASCADE,
  used_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  used_at TIMESTAMPTZ
);
CREATE INDEX redeem_codes_batch ON redeem_codes(batch_id);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item TEXT NOT NULL,
  plan_id TEXT,
  months INTEGER,
  amount INTEGER NOT NULL DEFAULT 0,
  method TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'paid',
  note TEXT,
  invoice TEXT NOT NULL DEFAULT 'none',
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX orders_time ON orders(created_at);

CREATE TABLE admin_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  ip TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE admin_audit (
  id BIGSERIAL PRIMARY KEY,
  admin_id TEXT NOT NULL,
  admin_phone TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  target_label TEXT,
  before JSONB,
  after JSONB,
  reason TEXT,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX admin_audit_time ON admin_audit(created_at);
CREATE INDEX admin_audit_target ON admin_audit(target_type, target_id);
`,
  },
];
