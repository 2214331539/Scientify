// Guards against runaway use: requests per minute and requests at once per user.
// They live in memory; the service runs as one process.

import { fail } from '../http.mjs';

const recent = new Map();
const running = new Map();

/** The plan's limits, with an administrator's override for this user while it lasts. */
export async function effectiveLimits(db, userId, plan, now = new Date()) {
  const result = await db.query(
    'SELECT rpm, concurrency, daily_points, until FROM user_limits WHERE user_id = $1',
    [userId],
  );
  const override = result.rows[0];
  const live = override && (!override.until || new Date(override.until) > now);
  const pick = (value, fallback) => (live && value !== null && value !== undefined ? Number(value) : fallback);
  return {
    rpm: pick(override?.rpm, plan.rpm),
    concurrency: pick(override?.concurrency, plan.concurrency),
    dailyPoints: pick(override?.daily_points, plan.dailyPoints),
    overridden: !!live,
  };
}

/** Takes a slot for one request; call the returned function when it ends. */
export function acquire(userId, limits, now = Date.now()) {
  const times = (recent.get(userId) ?? []).filter((at) => now - at < 60_000);
  if (times.length >= limits.rpm)
    throw fail(429, '请求太频繁，请稍后再试。', 'rate_limited');
  const active = running.get(userId) ?? 0;
  if (active >= limits.concurrency)
    throw fail(429, `同时进行的请求不能超过 ${limits.concurrency} 个，请等前面的回答结束。`, 'rate_limited');
  times.push(now);
  recent.set(userId, times);
  running.set(userId, active + 1);
  if (recent.size > 20_000) {
    for (const [key, list] of recent) if (list.every((at) => now - at >= 60_000)) recent.delete(key);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (running.get(userId) ?? 1) - 1;
    if (left > 0) running.set(userId, left);
    else running.delete(userId);
  };
}

/** For tests and for "解除限流" in the admin pages. */
export function resetLimits(userId) {
  if (userId) {
    recent.delete(userId);
    running.delete(userId);
  } else {
    recent.clear();
    running.clear();
  }
}
