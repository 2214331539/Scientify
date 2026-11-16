// Who is calling: a desktop access token (JWT) or a model token, which may
// only call the official models and read the account's billing. Disabled
// accounts are refused everywhere.

import crypto from 'node:crypto';
import { hashSecret, verifyToken } from './jwt.mjs';
import { bearer, fail } from './http.mjs';
import { chinaDay } from './billing/plans.mjs';

export const MODEL_TOKEN_PREFIX = 'sfm_';

export const newModelToken = () => MODEL_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');

// Account status is read on every request; a short cache keeps that cheap and
// admin changes clear it at once.
const statusCache = new Map();
export function forgetStatus(userId) {
  statusCache.delete(userId);
}

async function accountStatus(db, userId) {
  const cached = statusCache.get(userId);
  if (cached && cached.at > Date.now() - 20_000) return cached;
  const result = await db.query('SELECT status, disabled_reason FROM users WHERE id = $1', [userId]);
  const entry = {
    at: Date.now(),
    status: result.rows[0]?.status ?? 'missing',
    reason: result.rows[0]?.disabled_reason ?? '',
  };
  statusCache.set(userId, entry);
  if (statusCache.size > 50_000) statusCache.clear();
  return entry;
}

export async function requireActive(db, userId) {
  const { status, reason } = await accountStatus(db, userId);
  if (status === 'disabled')
    throw fail(403, reason ? `账号已停用：${reason}` : '账号已停用。', 'account_disabled');
  if (status === 'missing') throw fail(401, '登录状态已失效。');
}

// One activity row per user and China-time day, and last_active_at at most every five minutes.
const seen = new Map();
export function noteActivity(db, userId) {
  const now = Date.now();
  const day = chinaDay(new Date(now));
  const last = seen.get(userId);
  if (last && last.day === day && now - last.at < 5 * 60_000) return;
  seen.set(userId, { day, at: now });
  if (seen.size > 50_000) seen.clear();
  db.query(
    `INSERT INTO user_activity(user_id, day) VALUES ($1, $2) ON CONFLICT DO NOTHING;`,
    [userId, day],
  )
    .then(() => db.query('UPDATE users SET last_active_at = NOW() WHERE id = $1', [userId]))
    .catch((error) => console.error('activity', error.message));
}

/**
 * The caller of a /v1 request. `models` allows model tokens, which only the
 * model and billing-summary routes accept.
 */
export async function caller(request, { config, db }, { models = false } = {}) {
  const token = bearer(request);
  if (token.startsWith(MODEL_TOKEN_PREFIX)) {
    if (!models) throw fail(401, '登录状态已失效。');
    const result = await db.query(
      `SELECT t.id, t.user_id, u.phone FROM model_tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = $1 AND t.revoked_at IS NULL`,
      [hashSecret(token)],
    );
    const row = result.rows[0];
    if (!row) throw fail(401, '官方模型令牌已失效，请重新打开应用。', 'model_token_invalid');
    await requireActive(db, row.user_id);
    db.query(
      "UPDATE model_tokens SET last_used_at = NOW() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL '5 minutes')",
      [row.id],
    ).catch(() => {});
    noteActivity(db, row.user_id);
    return { sub: row.user_id, phone: row.phone, kind: 'model', tokenId: row.id };
  }
  let payload;
  try {
    payload = verifyToken(token, config.jwtSecret, config.jwtIssuer);
    if (payload.tokenType !== 'access') throw new Error('Not an access token');
  } catch {
    throw fail(401, '登录状态已失效。');
  }
  await requireActive(db, payload.sub);
  noteActivity(db, payload.sub);
  return { ...payload, kind: 'access' };
}
