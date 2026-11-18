// Error reports from the apps: what broke, in which version and how often.
// Users can turn sending off in Settings. A report holds the message and stack
// only, with the account name in home-folder paths blanked on both ends.

import crypto from 'node:crypto';
import { bearer, fail } from './http.mjs';
import { verifyToken } from './jwt.mjs';

const LIMITS = { message: 1000, stack: 8000, source: 120, page: 80, version: 40, platform: 40 };
const WINDOW = 10 * 60_000;
const PER_WINDOW = 30;
const recent = new Map();

/** "C:\Users\li\…", "/Users/li/…" and "/home/li/…" with the account name blanked. */
export function scrub(text) {
  return String(text ?? '')
    .replace(/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s"'`]+/gi, '$1~')
    .replace(/(\/(?:Users|home)\/)[^/\s"'`]+/g, '$1~');
}

export function cleanReport(input) {
  const report = Object.fromEntries(
    Object.entries(LIMITS).map(([key, limit]) => [key, scrub(input?.[key]).slice(0, limit).trim()]),
  );
  if (!report.message) throw fail(400, '错误报告缺少内容。');
  return report;
}

/** One group per error: the same message shape and top of the stack, in one version. */
export function fingerprint({ message, stack, version }) {
  const top = stack
    .split('\n')
    .slice(0, 4)
    .join('\n')
    .replace(/:\d+:\d+/g, '');
  // Numbers and quoted values differ between occurrences of one error.
  const shape = message.replace(/(["'`]).*?\1/g, '$1$1').replace(/\d+/g, '0');
  return crypto
    .createHash('sha256')
    .update(`${version}\n${shape}\n${top}`)
    .digest('hex')
    .slice(0, 32);
}

/** At most 30 reports per address in ten minutes; a crash loop can't flood the table. */
export function allowReport(address, now = Date.now()) {
  const entry = recent.get(address);
  if (!entry || now - entry.start > WINDOW) {
    if (recent.size > 10_000) recent.clear();
    recent.set(address, { start: now, count: 1 });
    return true;
  }
  entry.count += 1;
  return entry.count <= PER_WINDOW;
}

/** Signed-in reports name the user; others still count, by device. */
function reporter(request, config) {
  try {
    const payload = verifyToken(bearer(request), config.jwtSecret, config.jwtIssuer);
    return payload.tokenType === 'access' ? payload.sub : null;
  } catch {
    return null;
  }
}

export async function recordError(db, config, request, address, input) {
  if (!allowReport(address)) return false;
  const report = cleanReport(input);
  const id = fingerprint(report);
  const device = crypto
    .createHash('sha256')
    .update(String(input?.device || address))
    .digest('hex')
    .slice(0, 24);
  await db.query(
    `INSERT INTO client_errors(fingerprint, message, stack, source, page, version, platform, last_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (fingerprint) DO UPDATE SET
       count = client_errors.count + 1,
       last_at = NOW(),
       resolved_at = NULL,
       last_user_id = COALESCE(EXCLUDED.last_user_id, client_errors.last_user_id)`,
    [
      id,
      report.message,
      report.stack,
      report.source,
      report.page,
      report.version,
      report.platform,
      reporter(request, config),
    ],
  );
  await db.query(
    'INSERT INTO client_error_devices(fingerprint, device) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [id, device],
  );
  return true;
}
