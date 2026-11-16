// Admin sign-in: phone and password, with an SMS code only to reset a
// forgotten password. The session lives in an HttpOnly cookie scoped to
// /admin, apart from the desktop tokens.

import crypto from 'node:crypto';
import { withTransaction } from '../db.mjs';
import { hashSecret } from '../jwt.mjs';
import { fail } from '../http.mjs';
import {
  authenticateCode,
  checkPassword,
  clearPasswordFailures,
  guardPassword,
  hashPassword,
  notePasswordFailure,
  passwordMatches,
} from '../signin.mjs';

export const ROLES = { owner: '所有者', viewer: '只读' };
const COOKIE = 'sf_admin';
const SESSION_HOURS = 8;

function cookies(request) {
  const out = {};
  for (const part of String(request.headers.cookie ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return out;
}

const cookie = (config, value, maxAge) =>
  `${COOKIE}=${value}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.production ? '; Secure' : ''}`;

// Wrong admin passwords per address, on top of the per-number limit: guessing
// across many numbers from one place stops too.
const addressFailures = new Map();
const ADDRESS_WINDOW_MS = 15 * 60_000;
const ADDRESS_FAILURES = 30;
function recentAddressFailures(ip) {
  const now = Date.now();
  const recent = (addressFailures.get(ip) ?? []).filter((at) => now - at < ADDRESS_WINDOW_MS);
  addressFailures.set(ip, recent);
  if (addressFailures.size > 10_000) addressFailures.clear();
  return recent;
}

async function startSession(db, config, user, ip) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO admin_sessions(id, user_id, token_hash, ip, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + ($5 * INTERVAL '1 hour'))`,
    [crypto.randomUUID(), user.id, hashSecret(token), ip, SESSION_HOURS],
  );
  return {
    cookie: cookie(config, token, SESSION_HOURS * 3600),
    admin: { id: user.id, phone: user.phone, role: user.admin_role },
  };
}

export async function signIn(db, config, { phone, password }, ip) {
  if (recentAddressFailures(ip).length >= ADDRESS_FAILURES)
    throw fail(429, '密码错误次数过多，请 15 分钟后再试。');
  guardPassword(phone);
  const result = await db.query(
    'SELECT id, phone, password_hash, admin_role, status FROM users WHERE phone = $1',
    [phone],
  );
  const user = result.rows[0];
  // The same answer whether the number is unknown, not an admin, has no password
  // yet or the wrong one, so the page does not tell who the administrators are.
  if (!user || !ROLES[user.admin_role] || user.status !== 'active' || !passwordMatches(String(password ?? ''), user.password_hash)) {
    notePasswordFailure(phone);
    recentAddressFailures(ip).push(Date.now());
    throw fail(400, '手机号或密码不正确。还没设置过密码的话，请点“忘记密码”。');
  }
  clearPasswordFailures(phone);
  return startSession(db, config, user, ip);
}

/**
 * Sets a new password after an SMS code (sent only to administrators) and
 * signs in. It is the account's password, so the desktop app and other
 * admin sessions sign out, as when it is reset there.
 */
export async function resetPassword(db, config, { phone, code, password }, ip) {
  const secret = hashPassword(checkPassword(password));
  await authenticateCode(db, config, phone, String(code ?? '').trim());
  const result = await db.query('SELECT id, phone, admin_role, status FROM users WHERE phone = $1', [phone]);
  const user = result.rows[0];
  if (!user || !ROLES[user.admin_role] || user.status !== 'active') throw fail(400, '手机号或验证码不正确。');
  await withTransaction(db, async (client) => {
    await client.query('UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1', [user.id, secret]);
    await client.query('DELETE FROM refresh_tokens WHERE user_id = $1', [user.id]);
    await client.query('DELETE FROM admin_sessions WHERE user_id = $1', [user.id]);
  });
  clearPasswordFailures(phone);
  return startSession(db, config, user, ip);
}

export async function signOut(db, config, request) {
  const token = cookies(request)[COOKIE];
  if (token) await db.query('DELETE FROM admin_sessions WHERE token_hash = $1', [hashSecret(token)]);
  return cookie(config, '', 0);
}

/**
 * The signed-in administrator. Every API call must carry the X-Scientify-Admin
 * header: other sites cannot add it without a preflight this server refuses,
 * which together with SameSite=Strict keeps forged requests out.
 */
export async function requireAdmin(db, request, { write = false } = {}) {
  if (request.headers['x-scientify-admin'] !== '1') throw fail(403, '请求来源无效。');
  const token = cookies(request)[COOKIE];
  if (!token) throw fail(401, '请先登录。', 'admin_signed_out');
  const result = await db.query(
    `SELECT u.id, u.phone, u.admin_role, u.status FROM admin_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
    [hashSecret(token)],
  );
  const admin = result.rows[0];
  if (!admin || !ROLES[admin.admin_role] || admin.status !== 'active')
    throw fail(401, '登录已过期，请重新登录。', 'admin_signed_out');
  if (write && admin.admin_role !== 'owner') throw fail(403, '只读管理员不能修改。');
  return { id: admin.id, phone: admin.phone, role: admin.admin_role };
}
