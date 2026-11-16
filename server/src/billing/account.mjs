// A user's plan, points, storage and usage, as the desktop app and the admin
// pages show them; and the operations both share (extending a plan, redeeming).

import crypto from 'node:crypto';
import { withTransaction } from '../db.mjs';
import { fail } from '../http.mjs';
import { SOURCE_LABEL, addGrant, balance, debit, ensureGrants } from './ledger.mjs';
import { addDays, addMonths, chinaDay, currentPlan, subscriptionEnd } from './plans.mjs';

const uuid = () => crypto.randomUUID();

/** Bytes of synced files in the projects a user owns; members do not pay for them. */
export async function storageUsed(db, userId) {
  const result = await db.query(
    `SELECT COALESCE(SUM(b.size_bytes), 0) AS bytes
       FROM blobs b JOIN projects p ON p.id = b.project_id
      WHERE p.owner_id = $1 AND b.status = 'complete' AND b.deleted_at IS NULL`,
    [userId],
  );
  return Number(result.rows[0].bytes);
}

export async function usedToday(db, userId, now = new Date()) {
  const result = await db.query(
    'SELECT COALESCE(SUM(points), 0) AS points FROM usage_daily WHERE user_id = $1 AND day = $2',
    [userId, chinaDay(now)],
  );
  return Number(result.rows[0].points);
}

/** Points spent since an instant, from the ledger (usage and the debt it ran into). */
async function spentSince(db, userId, since) {
  const result = await db.query(
    `SELECT COALESCE(-SUM(delta), 0) AS points FROM credit_ledger
      WHERE user_id = $1 AND reason IN ('usage', 'debt') AND created_at >= $2`,
    [userId, since],
  );
  return Number(result.rows[0].points);
}

export const grantView = (row) => ({
  id: row.id,
  source: row.source,
  label: SOURCE_LABEL[row.source] ?? row.source,
  note: row.note ?? '',
  points: Number(row.points),
  left: Number(row.points_left),
  startsAt: row.starts_at,
  expiresAt: row.expires_at,
  expired: !!row.expired_at || new Date(row.expires_at) <= new Date(),
});

/** Everything the desktop "账号与订阅" page shows. */
export async function summary(db, userId, limitsFor, now = new Date()) {
  const current = await withTransaction(db, async (client) => {
    await ensureGrants(client, userId, now);
    return currentPlan(client, userId, now);
  });
  const [available, grants, debtRow, today, period, storage, limits] = await Promise.all([
    balance(db, userId, now),
    db.query(
      `SELECT * FROM credit_grants WHERE user_id = $1 AND starts_at <= $2 AND expires_at > $2 AND points_left > 0
        ORDER BY expires_at`,
      [userId, now],
    ),
    db.query('SELECT credit_debt FROM users WHERE id = $1', [userId]),
    usedToday(db, userId, now),
    spentSince(db, userId, current.period.start),
    storageUsed(db, userId),
    limitsFor(current.plan),
  ]);
  const { plan, subscription } = current;
  return {
    plan: {
      id: plan.id,
      name: plan.name,
      monthlyPoints: plan.monthlyPoints,
      storageBytes: plan.storageBytes,
      maxMembers: plan.maxMembers,
      historyDays: plan.historyDays,
    },
    subscription: subscription && {
      startsAt: subscription.startsAt,
      endsAt: (await subscriptionEnd(db, userId, plan.id, now)) ?? subscription.endsAt,
      source: subscription.source,
    },
    period: { start: current.period.start, end: current.period.end },
    balance: available,
    debt: Number(debtRow.rows[0]?.credit_debt ?? 0),
    usedThisPeriod: period,
    usedToday: today,
    limits: { dailyPoints: limits.dailyPoints, rpm: limits.rpm, concurrency: limits.concurrency },
    grants: grants.rows.map(grantView),
    storage: { usedBytes: storage, limitBytes: plan.storageBytes },
  };
}

/** Points per day and model over the last `days` days, in China time. */
export async function usageByDay(db, userId, days, now = new Date()) {
  const from = chinaDay(addDays(now, -(days - 1)));
  const result = await db.query(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, model_id, SUM(points) AS points, SUM(requests) AS requests,
            SUM(input_tokens) AS input, SUM(cached_tokens) AS cached, SUM(output_tokens) AS output
       FROM usage_daily WHERE user_id = $1 AND day >= $2
      GROUP BY day, model_id ORDER BY day`,
    [userId, from],
  );
  const byDay = new Map();
  const models = new Map();
  for (const row of result.rows) {
    const entry = byDay.get(row.day) ?? { day: row.day, points: 0, models: {} };
    entry.points += Number(row.points);
    entry.models[row.model_id] = Number(row.points);
    byDay.set(row.day, entry);
    const total = models.get(row.model_id) ?? { id: row.model_id, points: 0, requests: 0, input: 0, cached: 0, output: 0 };
    total.points += Number(row.points);
    total.requests += Number(row.requests);
    total.input += Number(row.input);
    total.cached += Number(row.cached);
    total.output += Number(row.output);
    models.set(row.model_id, total);
  }
  const list = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = chinaDay(addDays(now, -offset));
    list.push(byDay.get(day) ?? { day, points: 0, models: {} });
  }
  return { days: list, models: [...models.values()].sort((a, b) => b.points - a.points) };
}

/**
 * Puts a user on a paid plan for `months`, after any time already bought on
 * it; "free" ends every paid subscription now. Returns the new end.
 */
export async function extendPlan(client, userId, planId, months, source, extra = {}) {
  const now = extra.now ?? new Date();
  if (planId === 'free') {
    await client.query(
      `UPDATE subscriptions SET cancelled_at = $2
        WHERE user_id = $1 AND cancelled_at IS NULL AND ends_at > $2`,
      [userId, now],
    );
    return null;
  }
  const plan = await client.query('SELECT id FROM plans WHERE id = $1', [planId]);
  if (!plan.rows[0]) throw fail(400, '套餐不存在。');
  const after = await subscriptionEnd(client, userId, planId, now);
  const start = after ?? now;
  const end = addMonths(start, months);
  await client.query(
    `INSERT INTO subscriptions(id, user_id, plan_id, starts_at, ends_at, source, order_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [uuid(), userId, planId, start, end, source, extra.orderId ?? null, extra.adminId ?? null],
  );
  await ensureGrants(client, userId, now);
  return end;
}

export async function addOrder(client, order) {
  const now = new Date();
  const stamp = chinaDay(now).replaceAll('-', '');
  const id = `SO${stamp}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  await client.query(
    `INSERT INTO orders(id, user_id, item, plan_id, months, amount, method, status, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'paid', $8, $9)`,
    [
      id,
      order.userId,
      order.item,
      order.planId ?? null,
      order.months ?? null,
      order.amount ?? 0,
      order.method,
      order.note ?? null,
      order.adminId ?? null,
    ],
  );
  return id;
}

/** Codes look like SFY-7KQ2-M9XD-4TRA; letters that read alike are left out. */
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newCode() {
  const bytes = crypto.randomBytes(12);
  const chars = [...bytes].map((byte) => CODE_LETTERS[byte % CODE_LETTERS.length]).join('');
  return `SFY-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}
export const codeHash = (code) =>
  crypto
    .createHash('sha256')
    .update(String(code).toUpperCase().replace(/[^A-Z0-9]/g, ''))
    .digest('hex');

/** Uses a code once; a batch gives each account at most one of its codes. */
export async function redeem(db, userId, code, now = new Date()) {
  return withTransaction(db, async (client) => {
    const found = await client.query(
      `SELECT c.code_hash, c.used_by, b.* FROM redeem_codes c JOIN redeem_batches b ON b.id = c.batch_id
        WHERE c.code_hash = $1 FOR UPDATE OF c`,
      [codeHash(code)],
    );
    const row = found.rows[0];
    if (!row) throw fail(404, '兑换码不正确。', 'code_invalid');
    if (row.used_by) throw fail(409, '这个兑换码已经用过了。', 'code_used');
    if (row.voided_at || new Date(row.redeem_until) <= now)
      throw fail(410, '这个兑换码已失效。', 'code_expired');
    const mine = await client.query(
      'SELECT 1 FROM redeem_codes WHERE batch_id = $1 AND used_by = $2 LIMIT 1',
      [row.id, userId],
    );
    if (mine.rows[0]) throw fail(409, '你已经兑换过这一批的兑换码。', 'code_batch_used');
    await client.query('UPDATE redeem_codes SET used_by = $2, used_at = $3 WHERE code_hash = $1', [
      row.code_hash,
      userId,
      now,
    ]);
    if (row.kind === 'points') {
      await addGrant(client, userId, {
        source: 'redeem',
        points: Number(row.points),
        startsAt: now,
        expiresAt: addDays(now, Number(row.valid_days) || 90),
        note: `兑换码 · ${row.name}`,
        now,
      });
      return { kind: 'points', points: Number(row.points) };
    }
    const planName = (await client.query('SELECT name FROM plans WHERE id = $1', [row.plan_id])).rows[0]?.name;
    const orderId = await addOrder(client, {
      userId,
      item: `${planName} · ${row.months} 个月`,
      planId: row.plan_id,
      months: Number(row.months),
      amount: 0,
      method: '兑换码',
      note: row.name,
    });
    const endsAt = await extendPlan(client, userId, row.plan_id, Number(row.months), 'redeem', { orderId, now });
    return { kind: 'plan', plan: planName, months: Number(row.months), endsAt };
  });
}

/** Writes one model request's counts and takes its points, all or nothing. */
export async function recordUsage(db, usage) {
  const now = usage.now ?? new Date();
  const id = crypto.randomUUID();
  await withTransaction(db, async (client) => {
    // One user's requests are recorded one at a time; taking the user's row
    // first keeps the daily row and the grants from being locked in turns.
    await client.query('SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE', [usage.userId]);
    await client.query(
      `INSERT INTO usage_events(id, user_id, model_id, channel_id, input_tokens, cached_tokens, output_tokens,
                                reasoning_tokens, points, cost_micros, status, estimated, http_status, latency_ms, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        id,
        usage.userId,
        usage.modelId,
        usage.channelId ?? null,
        usage.tokens.input,
        usage.tokens.cached,
        usage.tokens.output,
        usage.tokens.reasoning,
        usage.points,
        usage.costMicros,
        usage.status,
        !!usage.tokens.estimated,
        usage.httpStatus ?? null,
        usage.latencyMs ?? null,
        now,
      ],
    );
    await client.query(
      `INSERT INTO usage_daily(user_id, day, model_id, requests, input_tokens, cached_tokens, output_tokens,
                               points, cost_micros, estimated_requests, error_requests)
       VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (user_id, day, model_id) DO UPDATE SET
         requests = usage_daily.requests + 1,
         input_tokens = usage_daily.input_tokens + EXCLUDED.input_tokens,
         cached_tokens = usage_daily.cached_tokens + EXCLUDED.cached_tokens,
         output_tokens = usage_daily.output_tokens + EXCLUDED.output_tokens,
         points = usage_daily.points + EXCLUDED.points,
         cost_micros = usage_daily.cost_micros + EXCLUDED.cost_micros,
         estimated_requests = usage_daily.estimated_requests + EXCLUDED.estimated_requests,
         error_requests = usage_daily.error_requests + EXCLUDED.error_requests`,
      [
        usage.userId,
        chinaDay(now),
        usage.modelId,
        usage.tokens.input,
        usage.tokens.cached,
        usage.tokens.output,
        usage.points,
        usage.costMicros,
        usage.tokens.estimated ? 1 : 0,
        usage.status === 'error' ? 1 : 0,
      ],
    );
    if (usage.points > 0)
      await debit(client, usage.userId, usage.points, { reason: 'usage', usageId: id, note: usage.modelName }, now);
  });
  return id;
}
