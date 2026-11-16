// Plans and billing periods. Days and months follow China time, so a day's
// limit and a free month start at midnight there.

const CHINA = 8 * 3600_000;

/** The China-time calendar date of an instant, as YYYY-MM-DD. */
export const chinaDay = (date = new Date()) => new Date(date.getTime() + CHINA).toISOString().slice(0, 10);

/** Midnight in China time on the first day of the instant's month. */
export function monthStart(date) {
  const local = new Date(date.getTime() + CHINA);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - CHINA);
}

/** The same China-time day and time `count` months later, clamped to the month's length. */
export function addMonths(date, count) {
  const local = new Date(date.getTime() + CHINA);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth() + count;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const shifted = Date.UTC(
    year,
    month,
    Math.min(local.getUTCDate(), last),
    local.getUTCHours(),
    local.getUTCMinutes(),
    local.getUTCSeconds(),
    local.getUTCMilliseconds(),
  );
  return new Date(shifted - CHINA);
}

export const addDays = (date, days) => new Date(date.getTime() + days * 86_400_000);

export function planView(row) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    priceMonth: Number(row.price_month),
    priceYear: Number(row.price_year),
    monthlyPoints: Number(row.monthly_points),
    dailyPoints: Number(row.daily_points),
    storageBytes: Number(row.storage_bytes),
    maxMembers: row.max_members === null ? null : Number(row.max_members),
    historyDays: Number(row.history_days),
    rpm: Number(row.rpm),
    concurrency: Number(row.concurrency),
    maxOutputTokens: Number(row.max_output_tokens),
    active: row.active,
  };
}

export async function plans(db) {
  const result = await db.query('SELECT * FROM plans ORDER BY sort, id');
  return result.rows.map(planView);
}

/**
 * The plan a user is on now and the billing period it is in. A subscription's
 * periods are whole months from its start; without one the user is on the
 * free plan, whose periods are calendar months.
 */
export async function currentPlan(db, userId, now = new Date()) {
  const result = await db.query(
    `SELECT s.id AS subscription_id, s.starts_at, s.ends_at, s.source, p.*
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id
      WHERE s.user_id = $1 AND s.starts_at <= $2 AND s.ends_at > $2 AND s.cancelled_at IS NULL
      ORDER BY s.starts_at DESC LIMIT 1`,
    [userId, now],
  );
  const row = result.rows[0];
  if (row) {
    const start = new Date(row.starts_at);
    const end = new Date(row.ends_at);
    let index = 0;
    while (index < 1200 && addMonths(start, index + 1) <= now) index += 1;
    const periodEnd = addMonths(start, index + 1);
    return {
      plan: planView(row),
      subscription: { id: row.subscription_id, startsAt: start, endsAt: end, source: row.source },
      period: {
        start: addMonths(start, index),
        end: periodEnd < end ? periodEnd : end,
        key: `plan:${row.subscription_id}:${index}`,
        source: 'plan',
      },
    };
  }
  const free = await db.query("SELECT * FROM plans WHERE id = 'free'");
  const start = monthStart(now);
  return {
    plan: planView(free.rows[0]),
    subscription: null,
    period: {
      start,
      end: monthStart(addDays(start, 40)),
      key: `free:${chinaDay(start).slice(0, 7)}`,
      source: 'free',
    },
  };
}

/** The last day of the subscriptions a user has, for extending them back to back. */
export async function subscriptionEnd(db, userId, planId, now = new Date()) {
  const result = await db.query(
    `SELECT MAX(ends_at) AS ends_at FROM subscriptions
      WHERE user_id = $1 AND plan_id = $2 AND cancelled_at IS NULL AND ends_at > $3`,
    [userId, planId, now],
  );
  return result.rows[0]?.ends_at ? new Date(result.rows[0].ends_at) : null;
}
