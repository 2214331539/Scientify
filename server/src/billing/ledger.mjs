// Points: grants (each batch a user received, with what is left), the ledger
// of every change, and the debt left by requests that ran past zero.

import crypto from 'node:crypto';
import { withTransaction } from '../db.mjs';
import { addDays, currentPlan } from './plans.mjs';

export const SIGNUP_POINTS = 1000;
export const SIGNUP_DAYS = 30;

const uuid = () => crypto.randomUUID();

/** What users see for each kind of grant. */
export const SOURCE_LABEL = {
  plan: '套餐月度额度',
  free: '免费版月度额度',
  signup: '注册赠送',
  redeem: '兑换码',
  adjust: '人工调整',
  pack: '加油包',
};

async function ledger(client, row) {
  await client.query(
    `INSERT INTO credit_ledger(user_id, grant_id, delta, reason, usage_id, admin_id, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      row.userId,
      row.grantId ?? null,
      row.delta,
      row.reason,
      row.usageId ?? null,
      row.adminId ?? null,
      row.note ?? null,
    ],
  );
}

/**
 * Adds a grant and records it. A `key` makes the grant happen once per user
 * (a period's points, the sign-up gift); returns null when it already did.
 */
export async function addGrant(client, userId, grant) {
  const id = uuid();
  const result = await client.query(
    `INSERT INTO credit_grants(id, user_id, source, source_key, points, points_left, starts_at, expires_at, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, $9)
     ON CONFLICT (user_id, source_key) WHERE source_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      id,
      userId,
      grant.source,
      grant.key ?? null,
      grant.points,
      grant.startsAt,
      grant.expiresAt,
      grant.note ?? null,
      grant.adminId ?? null,
    ],
  );
  if (!result.rows[0]) return null;
  await ledger(client, {
    userId,
    grantId: id,
    delta: grant.points,
    reason: 'grant',
    adminId: grant.adminId,
    note: grant.note ?? SOURCE_LABEL[grant.source],
  });
  await settleDebt(client, userId, grant.now ?? new Date());
  return id;
}

/** Grants the sign-up gift and the current period's points if they are still missing. */
export async function ensureGrants(client, userId, now = new Date()) {
  const user = await client.query('SELECT created_at FROM users WHERE id = $1', [userId]);
  if (!user.rows[0]) return;
  const created = new Date(user.rows[0].created_at);
  const signupEnds = addDays(created, SIGNUP_DAYS);
  if (signupEnds > now)
    await addGrant(client, userId, {
      source: 'signup',
      key: 'signup',
      points: SIGNUP_POINTS,
      startsAt: created,
      expiresAt: signupEnds,
      now,
    });
  const { plan, period } = await currentPlan(client, userId, now);
  if (plan.monthlyPoints > 0)
    await addGrant(client, userId, {
      source: period.source,
      key: period.key,
      points: plan.monthlyPoints,
      startsAt: period.start,
      expiresAt: period.end,
      now,
    });
}

/**
 * Fills the current period's plan points back up ("重置本周期额度"). Returns the points
 * added, 0 when nothing was used, null when the plan gives no points per period.
 */
export async function resetPeriodGrant(client, userId, entry, now = new Date()) {
  await ensureGrants(client, userId, now);
  const { period } = await currentPlan(client, userId, now);
  const result = await client.query(
    'SELECT id, points, points_left FROM credit_grants WHERE user_id = $1 AND source_key = $2 FOR UPDATE',
    [userId, period.key],
  );
  const grant = result.rows[0];
  if (!grant) return null;
  const added = Number(grant.points) - Number(grant.points_left);
  if (added <= 0) return 0;
  await client.query('UPDATE credit_grants SET points_left = points WHERE id = $1', [grant.id]);
  await ledger(client, {
    userId,
    grantId: grant.id,
    delta: added,
    reason: 'adjust',
    adminId: entry.adminId,
    note: entry.note,
  });
  await settleDebt(client, userId, now);
  return added;
}

/** Points that can be spent now: what is left of live grants, less any debt. */
export async function balance(client, userId, now = new Date()) {
  const result = await client.query(
    `SELECT COALESCE((SELECT SUM(points_left) FROM credit_grants
                       WHERE user_id = $1 AND starts_at <= $2 AND expires_at > $2 AND points_left > 0), 0)
            - u.credit_debt AS balance
       FROM users u WHERE u.id = $1`,
    [userId, now],
  );
  return Number(result.rows[0]?.balance ?? 0);
}

async function liveGrants(client, userId, now) {
  const result = await client.query(
    `SELECT id, points_left FROM credit_grants
      WHERE user_id = $1 AND starts_at <= $2 AND expires_at > $2 AND points_left > 0
      ORDER BY expires_at, created_at FOR NO KEY UPDATE`,
    [userId, now],
  );
  return result.rows.map((row) => ({ id: row.id, left: Number(row.points_left) }));
}

/**
 * Takes points from the grants that expire first. What the grants cannot
 * cover becomes debt unless `allowDebt` is false, in which case nothing is
 * taken and an error says how much was available. Run inside a transaction.
 */
export async function debit(client, userId, points, entry, now = new Date()) {
  const user = await client.query('SELECT credit_debt FROM users WHERE id = $1 FOR NO KEY UPDATE', [userId]);
  if (!user.rows[0]) return;
  const grants = await liveGrants(client, userId, now);
  const available = grants.reduce((sum, grant) => sum + grant.left, 0) - Number(user.rows[0].credit_debt);
  if (entry.allowDebt === false && points > available)
    throw Object.assign(new Error(`最多只能扣减 ${Math.max(0, available)} 点。`), { status: 400 });
  let remaining = points;
  for (const grant of grants) {
    if (!remaining) break;
    const take = Math.min(grant.left, remaining);
    await client.query('UPDATE credit_grants SET points_left = points_left - $2 WHERE id = $1', [
      grant.id,
      take,
    ]);
    await ledger(client, { ...entry, userId, grantId: grant.id, delta: -take });
    remaining -= take;
  }
  if (remaining > 0) {
    await client.query('UPDATE users SET credit_debt = credit_debt + $2 WHERE id = $1', [
      userId,
      remaining,
    ]);
    await ledger(client, { ...entry, userId, delta: -remaining, reason: 'debt' });
  }
}

/** New points pay off debt first. The balance does not change, so the ledger notes it at zero. */
async function settleDebt(client, userId, now) {
  const user = await client.query('SELECT credit_debt FROM users WHERE id = $1 FOR NO KEY UPDATE', [userId]);
  let debt = Number(user.rows[0]?.credit_debt ?? 0);
  if (!debt) return;
  for (const grant of await liveGrants(client, userId, now)) {
    if (!debt) break;
    const take = Math.min(grant.left, debt);
    await client.query('UPDATE credit_grants SET points_left = points_left - $2 WHERE id = $1', [
      grant.id,
      take,
    ]);
    await ledger(client, {
      userId,
      grantId: grant.id,
      delta: 0,
      reason: 'settle',
      note: `抵扣欠额 ${take} 点`,
    });
    debt -= take;
  }
  await client.query('UPDATE users SET credit_debt = $2 WHERE id = $1', [userId, debt]);
}

/** Zeroes grants that ran out of time with points left and records what went unused. */
export async function expireGrants(db, now = new Date()) {
  const due = await db.query(
    `SELECT id FROM credit_grants
      WHERE expires_at <= $1 AND expired_at IS NULL AND points_left > 0 LIMIT 1000`,
    [now],
  );
  for (const { id } of due.rows) {
    await withTransaction(db, async (client) => {
      const grant = await client.query(
        `SELECT user_id, points_left FROM credit_grants
          WHERE id = $1 AND expired_at IS NULL FOR UPDATE`,
        [id],
      );
      const row = grant.rows[0];
      if (!row) return;
      await client.query(
        'UPDATE credit_grants SET expired_at = $2, points_left = 0 WHERE id = $1',
        [id, now],
      );
      if (Number(row.points_left) > 0)
        await ledger(client, {
          userId: row.user_id,
          grantId: id,
          delta: -Number(row.points_left),
          reason: 'expire',
          note: '到期作废',
        });
    });
  }
  return due.rows.length;
}
