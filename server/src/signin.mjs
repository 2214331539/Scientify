// SMS codes and passwords, shared by desktop sign-in and the admin pages.

import crypto from 'node:crypto';
import { hashSecret } from './jwt.mjs';
import { fail } from './http.mjs';
import { sendVerificationCode } from './sms.mjs';

const codeRequests = new Map();
const CODE_WINDOW_MS = 10 * 60_000;
const CODE_REQUESTS_PER_WINDOW = 10;

function limitCodeRequests(address) {
  const nowMs = Date.now();
  const recent = (codeRequests.get(address) ?? []).filter((at) => nowMs - at < CODE_WINDOW_MS);
  if (recent.length >= CODE_REQUESTS_PER_WINDOW) {
    throw fail(429, '验证码请求过多，请稍后再试。');
  }
  recent.push(nowMs);
  codeRequests.set(address, recent);
  if (codeRequests.size > 10_000) {
    for (const [key, times] of codeRequests) {
      if (times.every((at) => nowMs - at >= CODE_WINDOW_MS)) codeRequests.delete(key);
    }
  }
}

/**
 * A fixed code for test accounts, which receive no SMS. In production it only
 * covers the numbers in DEV_SMS_PHONES; elsewhere it covers every number.
 */
function usesDevelopmentCode(config, phone) {
  const { developmentCode, developmentPhones } = config.sms;
  if (!developmentCode) return false;
  return developmentPhones.length ? developmentPhones.includes(phone) : !config.production;
}

function phoneCode(config, phone) {
  if (usesDevelopmentCode(config, phone)) return config.sms.developmentCode;
  return String(crypto.randomInt(100000, 1_000_000));
}

/** Stores a fresh code for the number and texts it; one a minute per number. */
export async function sendCode(db, config, phone, address) {
  limitCodeRequests(address);
  const existing = await db.query('SELECT last_sent_at FROM auth_codes WHERE phone = $1', [phone]);
  if (existing.rows[0] && Date.now() - new Date(existing.rows[0].last_sent_at).getTime() < 60_000) {
    throw fail(429, '验证码发送过于频繁，请稍后再试。');
  }
  const code = phoneCode(config, phone);
  const hash = hashSecret(`${config.jwtSecret}:${phone}:${code}`);
  await db.query(
    `INSERT INTO auth_codes(phone, code_hash, expires_at, last_sent_at, attempts)
     VALUES ($1, $2, NOW() + INTERVAL '5 minutes', NOW(), 0)
     ON CONFLICT (phone) DO UPDATE SET code_hash = EXCLUDED.code_hash,
       expires_at = EXCLUDED.expires_at, last_sent_at = EXCLUDED.last_sent_at, attempts = 0`,
    [phone, hash],
  );
  if (!usesDevelopmentCode(config, phone)) await sendVerificationCode(config, phone, code);
}

export async function authenticateCode(db, config, phone, code) {
  const result = await db.query('SELECT * FROM auth_codes WHERE phone = $1', [phone]);
  const stored = result.rows[0];
  if (!stored || new Date(stored.expires_at).getTime() < Date.now()) {
    throw fail(400, '验证码已过期，请重新获取。');
  }
  if (stored.attempts >= 5) {
    throw fail(429, '验证码尝试次数过多，请重新获取。');
  }
  const valid = hashSecret(`${config.jwtSecret}:${phone}:${code}`) === stored.code_hash;
  if (!valid) {
    await db.query('UPDATE auth_codes SET attempts = attempts + 1 WHERE phone = $1', [phone]);
    throw fail(400, '验证码不正确。');
  }
  await db.query('DELETE FROM auth_codes WHERE phone = $1', [phone]);
}

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

/** Passwords are stored as scrypt hashes with their own salt and parameters. */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export function passwordMatches(password, stored) {
  const [kind, N, r, p, salt, hash] = String(stored ?? '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
  });
  return crypto.timingSafeEqual(actual, expected);
}

/** 8 to 64 characters with at least one letter and one digit. */
export function checkPassword(value) {
  const password = String(value ?? '');
  if (password.length < 8 || password.length > 64 || !/[A-Za-z]/.test(password) || !/\d/.test(password))
    throw fail(400, '密码需要 8–64 位，同时包含字母和数字。');
  return password;
}

// Wrong passwords per phone number: ten in fifteen minutes, then a pause.
const passwordFailures = new Map();
const PASSWORD_WINDOW_MS = 15 * 60_000;
const PASSWORD_FAILURES_PER_WINDOW = 10;

function recentFailures(phone) {
  const nowMs = Date.now();
  const recent = (passwordFailures.get(phone) ?? []).filter((at) => nowMs - at < PASSWORD_WINDOW_MS);
  passwordFailures.set(phone, recent);
  return recent;
}

export function guardPassword(phone) {
  if (recentFailures(phone).length >= PASSWORD_FAILURES_PER_WINDOW)
    throw fail(429, '密码错误次数过多，请 15 分钟后再试，或用验证码登录。');
}
export const notePasswordFailure = (phone) => recentFailures(phone).push(Date.now());
export const clearPasswordFailures = (phone) => passwordFailures.delete(phone);
