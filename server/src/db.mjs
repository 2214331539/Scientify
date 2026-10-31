import { Pool } from 'pg';

export const schema = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS auth_codes (
  phone TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  last_sent_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'reviewer', 'viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, user_id)
);
CREATE TABLE IF NOT EXISTS project_invitations (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('editor', 'reviewer', 'viewer')),
  invited_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, phone)
);
CREATE TABLE IF NOT EXISTS sync_operations (
  operation_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES users(id),
  client_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  base_revision BIGINT NOT NULL,
  server_revision BIGINT NOT NULL,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  sequence BIGSERIAL UNIQUE
);
CREATE INDEX IF NOT EXISTS sync_operations_project_sequence
  ON sync_operations(project_id, sequence);
CREATE TABLE IF NOT EXISTS entity_heads (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  revision BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, domain, entity_id)
);
CREATE TABLE IF NOT EXISTS blobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  content_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'deleted')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS blobs_project_hash ON blobs(project_id, sha256);
`;

export function createDb(config) {
  return new Pool({ connectionString: config.databaseUrl, max: 5, idleTimeoutMillis: 30_000 });
}

export async function initDb(db) {
  await db.query(schema);
}

export async function withTransaction(db, task) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await task(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
