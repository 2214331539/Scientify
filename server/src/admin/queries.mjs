// What the admin pages read: the overview, users, inferred teams and usage.
// Only counts and metadata; no file, document or conversation content.

import { withTransaction } from '../db.mjs';
import { ensureGrants } from '../billing/ledger.mjs';
import { addDays, chinaDay, monthStart, plans as allPlans } from '../billing/plans.mjs';
import { catalog } from '../billing/models.mjs';
import { typical } from '../billing/meter.mjs';
import { effectiveLimits } from '../billing/limits.mjs';
import { grantView, summary, usageByDay, usedToday } from '../billing/account.mjs';
import { currentPlan } from '../billing/plans.mjs';
import { MIN_MARGIN } from '../billing/pricing.mjs';

export const maskPhone = (phone) => (phone ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : '');
const n = (value) => Number(value ?? 0);
// Standard OSS storage, for an order-of-magnitude cost; traffic is not included.
const OSS_YUAN_PER_GB_MONTH = 0.12;

const displayName = (row) => row.nickname || maskPhone(row.phone);

async function planNames(db) {
  return new Map((await allPlans(db)).map((plan) => [plan.id, plan.name]));
}

/** Gives the listed users their sign-up gift and period points, so balances are current. */
async function settle(db, userIds, now) {
  for (const id of userIds) await withTransaction(db, (client) => ensureGrants(client, id, now));
}

export async function overview(db, now = new Date()) {
  const today = chinaDay(now);
  const month = monthStart(now);
  const monthDay = chinaDay(month);
  const from = chinaDay(addDays(now, -29));
  const [users, active, paid, revenue, cost, storage, dau, signups, daily, monthly, revenueByMonth] =
    await Promise.all([
      db.query('SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE created_at >= $1) AS month FROM users', [month]),
      db.query(
        `SELECT COUNT(DISTINCT user_id) FILTER (WHERE day > $1::date - 7) AS week,
                COUNT(DISTINCT user_id) FILTER (WHERE day <= $1::date - 7 AND day > $1::date - 14) AS before
           FROM user_activity WHERE day > $1::date - 14`,
        [today],
      ),
      db.query(
        `SELECT plan_id, COUNT(DISTINCT user_id) AS users FROM subscriptions
          WHERE starts_at <= $1 AND ends_at > $1 AND cancelled_at IS NULL GROUP BY plan_id`,
        [now],
      ),
      db.query('SELECT COALESCE(SUM(amount), 0) AS amount, COUNT(*) FILTER (WHERE amount > 0) AS paid FROM orders WHERE created_at >= $1', [month]),
      db.query('SELECT COALESCE(SUM(cost_micros), 0) AS cost, COALESCE(SUM(points), 0) AS points FROM usage_daily WHERE day >= $1', [monthDay]),
      db.query("SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM blobs WHERE status = 'complete' AND deleted_at IS NULL"),
      db.query(
        `SELECT to_char(day, 'YYYY-MM-DD') AS day, COUNT(*) AS users FROM user_activity WHERE day >= $1 GROUP BY day`,
        [from],
      ),
      db.query(
        `SELECT to_char((created_at AT TIME ZONE 'Asia/Shanghai')::date, 'YYYY-MM-DD') AS day, COUNT(*) AS users
           FROM users WHERE created_at >= $1 GROUP BY 1`,
        [addDays(now, -31)],
      ),
      db.query(
        `SELECT to_char(day, 'YYYY-MM-DD') AS day, model_id, SUM(points) AS points FROM usage_daily
          WHERE day >= $1 GROUP BY day, model_id`,
        [from],
      ),
      db.query(
        `SELECT to_char(day, 'YYYY-MM') AS month, SUM(cost_micros) AS cost FROM usage_daily
          WHERE day >= $1 GROUP BY 1`,
        [chinaDay(monthStart(addDays(month, -160)))],
      ),
      db.query(
        `SELECT to_char((created_at AT TIME ZONE 'Asia/Shanghai'), 'YYYY-MM') AS month, SUM(amount) AS amount
           FROM orders WHERE created_at >= $1 GROUP BY 1`,
        [monthStart(addDays(month, -160))],
      ),
    ]);
  const days = [];
  for (let offset = 29; offset >= 0; offset -= 1) days.push(chinaDay(addDays(now, -offset)));
  const byDay = (rows, key) => new Map(rows.map((row) => [row.day, n(row[key])]));
  const dauMap = byDay(dau.rows, 'users');
  const signupMap = byDay(signups.rows, 'users');
  const modelDays = new Map();
  for (const row of daily.rows) {
    const entry = modelDays.get(row.day) ?? {};
    entry[row.model_id] = n(row.points);
    modelDays.set(row.day, entry);
  }
  const uniqueMonths = [];
  for (let start = month, count = 0; count < 6; count += 1, start = monthStart(addDays(start, -1)))
    uniqueMonths.unshift(chinaDay(start).slice(0, 7));
  const costMonths = new Map(monthly.rows.map((row) => [row.month, n(row.cost) / 1e6]));
  const revenueMonths = new Map(revenueByMonth.rows.map((row) => [row.month, n(row.amount) / 100]));
  const paidUsers = Object.fromEntries(paid.rows.map((row) => [row.plan_id, n(row.users)]));
  const storageBytes = n(storage.rows[0].bytes);
  return {
    tiles: {
      users: n(users.rows[0].total),
      usersThisMonth: n(users.rows[0].month),
      active7: n(active.rows[0].week),
      activeBefore: n(active.rows[0].before),
      paidUsers: Object.values(paidUsers).reduce((sum, value) => sum + value, 0),
      paidByPlan: paidUsers,
      revenue: n(revenue.rows[0].amount) / 100,
      paidOrders: n(revenue.rows[0].paid),
      modelCost: n(cost.rows[0].cost) / 1e6,
      pointsSold: n(cost.rows[0].points),
      storageBytes,
      storageYuan: (storageBytes / 1024 ** 3) * OSS_YUAN_PER_GB_MONTH,
    },
    days,
    activeDaily: days.map((day) => dauMap.get(day) ?? 0),
    signupsDaily: days.map((day) => signupMap.get(day) ?? 0),
    modelDaily: days.map((day) => modelDays.get(day) ?? {}),
    months: uniqueMonths,
    revenueMonthly: uniqueMonths.map((key) => revenueMonths.get(key) ?? 0),
    costMonthly: uniqueMonths.map((key) => costMonths.get(key) ?? 0),
    storageMonthly: uniqueMonths.map(() => (storageBytes / 1024 ** 3) * OSS_YUAN_PER_GB_MONTH),
    alerts: await alerts(db, now),
  };
}

async function alerts(db, now) {
  const out = [];
  const heavy = await db.query(
    `SELECT e.user_id, u.phone, u.nickname, SUM(e.points) AS points FROM usage_events e JOIN users u ON u.id = e.user_id
      WHERE e.created_at > $1 GROUP BY e.user_id, u.phone, u.nickname HAVING SUM(e.points) >= 200
      ORDER BY points DESC LIMIT 5`,
    [new Date(now.getTime() - 3600_000)],
  );
  for (const row of heavy.rows) {
    const { plan } = await currentPlan(db, row.user_id, now);
    const limits = await effectiveLimits(db, row.user_id, plan, now);
    const today = await usedToday(db, row.user_id, now);
    if (today >= limits.dailyPoints * 0.8)
      out.push({
        level: 'bad',
        title: `${displayName(row)}（${maskPhone(row.phone)}）一小时内用了 ${n(row.points)} 点`,
        detail: `今天已用 ${today} 点，是单日上限的 ${Math.round((today / limits.dailyPoints) * 100)}%，可能是 Agent 循环`,
        action: { label: '查看用户', view: 'user', id: row.user_id },
      });
  }
  const channels = await db.query(
    `SELECT c.id, c.name, COUNT(*) AS requests, COUNT(*) FILTER (WHERE e.status = 'error') AS errors
       FROM usage_events e JOIN channels c ON c.id = e.channel_id
      WHERE e.created_at > $1 GROUP BY c.id, c.name`,
    [new Date(now.getTime() - 3600_000)],
  );
  for (const row of channels.rows) {
    const rate = n(row.errors) / Math.max(1, n(row.requests));
    if (n(row.requests) >= 20 && rate > 0.02)
      out.push({
        level: 'warn',
        title: `渠道“${row.name}”的错误率 ${(rate * 100).toFixed(1)}%`,
        detail: `近 1 小时 ${n(row.requests)} 次请求`,
        action: { label: '查看渠道', view: 'channels' },
      });
  }
  const { models } = await catalog(db);
  for (const model of models.filter((item) => item.active)) {
    const { margin } = typical(model);
    if (margin === null)
      out.push({ level: 'bad', title: `${model.name} 已上架但没有售价`, detail: '用户使用它不会扣点数', action: { label: '设置价格', view: 'model', id: model.id } });
    else if (margin < MIN_MARGIN)
      out.push({ level: 'warn', title: `${model.name} 的毛利率 ${margin}%`, detail: `低于 ${MIN_MARGIN}%`, action: { label: '调整价格', view: 'model', id: model.id } });
  }
  const batches = await db.query(
    `SELECT b.id, b.name, b.count, COUNT(c.used_by) AS used FROM redeem_batches b LEFT JOIN redeem_codes c ON c.batch_id = b.id
      WHERE b.voided_at IS NULL AND b.redeem_until > $1 AND b.redeem_until <= $2
      GROUP BY b.id HAVING COUNT(c.used_by) < b.count`,
    [now, addDays(now, 7)],
  );
  for (const row of batches.rows)
    out.push({ level: 'info', title: `兑换码“${row.name}”7 天内到期`, detail: `已兑换 ${n(row.used)} / ${n(row.count)}`, action: { label: '查看', view: 'codes' } });
  return out;
}

const userColumns = `
  u.id, u.phone, u.nickname, u.status, u.disabled_reason, u.created_at, u.last_active_at, u.admin_role,
  sub.plan_id, sub.ends_at,
  COALESCE((SELECT SUM(points_left) FROM credit_grants g
             WHERE g.user_id = u.id AND g.starts_at <= $1 AND g.expires_at > $1), 0) - u.credit_debt AS balance,
  COALESCE((SELECT SUM(points) FROM usage_daily d WHERE d.user_id = u.id AND d.day >= $2), 0) AS month_points,
  COALESCE((SELECT SUM(b.size_bytes) FROM blobs b JOIN projects p ON p.id = b.project_id
             WHERE p.owner_id = u.id AND b.status = 'complete' AND b.deleted_at IS NULL), 0) AS storage,
  (SELECT COUNT(*) FROM project_members m WHERE m.user_id = u.id) AS projects,
  (SELECT COUNT(*) FROM project_members m WHERE m.user_id = u.id
      AND (SELECT COUNT(*) FROM project_members x WHERE x.project_id = m.project_id) > 1) AS team_projects`;
const currentSubscription = `
  LEFT JOIN LATERAL (SELECT plan_id, ends_at FROM subscriptions s
                      WHERE s.user_id = u.id AND s.starts_at <= $1 AND s.ends_at > $1 AND s.cancelled_at IS NULL
                      ORDER BY s.starts_at DESC LIMIT 1) sub ON TRUE`;

function userRow(row, names, planList) {
  const planId = row.plan_id ?? 'free';
  const plan = planList.find((item) => item.id === planId);
  return {
    id: row.id,
    phone: maskPhone(row.phone),
    nickname: row.nickname ?? '',
    name: displayName(row),
    status: row.status,
    disabledReason: row.disabled_reason ?? '',
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    adminRole: row.admin_role,
    plan: { id: planId, name: names.get(planId) ?? planId, endsAt: row.ends_at ?? null },
    balance: n(row.balance),
    monthPoints: n(row.month_points),
    monthlyPoints: plan?.monthlyPoints ?? 0,
    storage: { usedBytes: n(row.storage), limitBytes: plan?.storageBytes ?? 0 },
    projects: n(row.projects),
    teamProjects: n(row.team_projects),
  };
}

export async function users(db, query, now = new Date()) {
  const q = String(query.q ?? '').trim().slice(0, 40);
  const plan = String(query.plan ?? 'all');
  const status = String(query.status ?? 'all');
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
  const offset = Math.max(0, Number(query.offset) || 0);
  const where = `WHERE ($2 = '' OR u.phone LIKE '%' || $2 || '%' OR u.nickname ILIKE '%' || $2 || '%' OR u.id = $2)
      AND ($3 = 'all' OR COALESCE(sub.plan_id, 'free') = $3)
      AND ($4 = 'all' OR u.status = $4)`;
  const params = [now, q, plan, status];
  const total = await db.query(`SELECT COUNT(*) AS total FROM users u ${currentSubscription} ${where}`, params);
  const page = await db.query(
    `SELECT u.id FROM users u ${currentSubscription} ${where}
      ORDER BY u.last_active_at DESC NULLS LAST, u.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  await settle(db, page.rows.map((row) => row.id), now);
  const rows = await db.query(
    `SELECT ${userColumns} FROM users u ${currentSubscription}
      WHERE u.id = ANY($3) ORDER BY u.last_active_at DESC NULLS LAST, u.created_at DESC`,
    [now, chinaDay(monthStart(now)), page.rows.map((row) => row.id)],
  );
  const names = await planNames(db);
  const planList = await allPlans(db);
  return { total: n(total.rows[0].total), users: rows.rows.map((row) => userRow(row, names, planList)) };
}

export async function userDetail(db, userId, now = new Date()) {
  const found = await db.query(`SELECT ${userColumns} FROM users u ${currentSubscription} WHERE u.id = $3`, [
    now,
    chinaDay(monthStart(now)),
    userId,
  ]);
  if (!found.rows[0]) return null;
  const account = await summary(db, userId, (plan) => effectiveLimits(db, userId, plan, now), now);
  const names = await planNames(db);
  const [subscriptions, grants, ledger, usage, projects, devices, sessions, limits, audit] = await Promise.all([
    db.query(
      `SELECT plan_id, starts_at, ends_at, source, cancelled_at, created_at FROM subscriptions
        WHERE user_id = $1 ORDER BY starts_at DESC LIMIT 20`,
      [userId],
    ),
    db.query('SELECT * FROM credit_grants WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [userId]),
    // Usage is shown per day; everything else row by row.
    db.query(
      `SELECT * FROM (
         SELECT MAX(created_at) AS at, to_char((created_at AT TIME ZONE 'Asia/Shanghai')::date, 'YYYY-MM-DD') AS day,
                SUM(delta) AS delta, 'usage' AS reason, COUNT(DISTINCT usage_id) AS requests, NULL AS note, NULL AS admin
           FROM credit_ledger WHERE user_id = $1 AND reason IN ('usage', 'debt') AND created_at > $2
          GROUP BY 2
         UNION ALL
         SELECT l.created_at, NULL, l.delta, l.reason, NULL, l.note, a.phone
           FROM credit_ledger l LEFT JOIN users a ON a.id = l.admin_id
          WHERE l.user_id = $1 AND l.reason NOT IN ('usage', 'debt') AND l.created_at > $2
       ) entries ORDER BY at DESC LIMIT 120`,
      [userId, addDays(now, -90)],
    ),
    usageByDay(db, userId, 30, now),
    db.query(
      `SELECT p.id, p.name, m.role, p.owner_id = $1 AS owned,
              (SELECT COUNT(*) FROM project_members x WHERE x.project_id = p.id) AS members,
              (SELECT COALESCE(SUM(size_bytes), 0) FROM blobs b WHERE b.project_id = p.id AND b.status = 'complete' AND b.deleted_at IS NULL) AS bytes,
              (SELECT MAX(updated_at) FROM sync_entities e WHERE e.project_id = p.id) AS synced_at
         FROM project_members m JOIN projects p ON p.id = m.project_id
        WHERE m.user_id = $1 ORDER BY synced_at DESC NULLS LAST`,
      [userId],
    ),
    db.query(
      `SELECT id, device_name, created_at, last_used_at FROM model_tokens
        WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC`,
      [userId],
    ),
    db.query('SELECT COUNT(*) AS count, MAX(created_at) AS last FROM refresh_tokens WHERE user_id = $1 AND expires_at > NOW()', [userId]),
    db.query('SELECT * FROM user_limits WHERE user_id = $1', [userId]),
    db.query(
      `SELECT * FROM admin_audit WHERE target_type = 'user' AND target_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [userId],
    ),
  ]);
  const { models } = await catalog(db);
  const modelNames = new Map(models.map((model) => [model.id, model.name]));
  const limit = limits.rows[0];
  return {
    user: userRow(found.rows[0], names, await allPlans(db)),
    account,
    subscriptions: subscriptions.rows.map((row) => ({
      plan: names.get(row.plan_id) ?? row.plan_id,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      source: row.source,
      cancelledAt: row.cancelled_at,
    })),
    grants: grants.rows.map(grantView),
    ledger: ledger.rows.map((row) => ({
      at: row.at,
      day: row.day,
      delta: n(row.delta),
      reason: row.reason,
      requests: row.requests === null ? null : n(row.requests),
      note: row.note ?? '',
      admin: row.admin ? maskPhone(row.admin) : '',
    })),
    usage: { ...usage, models: usage.models.map((item) => ({ ...item, name: modelNames.get(item.id) ?? item.id })) },
    projects: projects.rows.map((row) => ({
      id: row.id,
      name: row.name,
      role: row.role,
      owned: row.owned,
      members: n(row.members),
      bytes: n(row.bytes),
      syncedAt: row.synced_at,
    })),
    devices: devices.rows.map((row) => ({
      id: row.id,
      name: row.device_name,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
    })),
    sessions: { count: n(sessions.rows[0].count), lastSignIn: sessions.rows[0].last },
    limits: limit
      ? {
          rpm: limit.rpm,
          concurrency: limit.concurrency,
          dailyPoints: limit.daily_points === null ? null : n(limit.daily_points),
          until: limit.until,
          reason: limit.reason ?? '',
        }
      : null,
    audit: audit.rows.map(auditView),
  };
}

export const auditView = (row) => ({
  id: n(row.id),
  at: row.created_at,
  admin: maskPhone(row.admin_phone),
  action: row.action,
  targetType: row.target_type,
  targetId: row.target_id,
  target: row.target_label ?? '',
  before: row.before,
  after: row.after,
  reason: row.reason ?? '',
  ip: row.ip ?? '',
});

/**
 * Teams are inferred: people who share a project with others form a team
 * (connected through any shared project). It is named after the person who
 * owns most of its shared projects.
 */
async function inferTeams(db) {
  const rows = await db.query(
    `SELECT p.id, p.name, p.owner_id, m.user_id, m.role FROM projects p JOIN project_members m ON m.project_id = p.id
      WHERE p.id IN (SELECT project_id FROM project_members GROUP BY project_id HAVING COUNT(*) > 1)
      ORDER BY p.created_at`,
  );
  const projects = new Map();
  for (const row of rows.rows) {
    const project = projects.get(row.id) ?? { id: row.id, name: row.name, ownerId: row.owner_id, roles: {} };
    project.roles[row.user_id] = row.role;
    projects.set(row.id, project);
  }
  const parent = new Map();
  const find = (id) => {
    while (parent.get(id) !== id) {
      parent.set(id, parent.get(parent.get(id)));
      id = parent.get(id);
    }
    return id;
  };
  for (const project of projects.values()) {
    const members = Object.keys(project.roles);
    for (const id of members) if (!parent.has(id)) parent.set(id, id);
    for (const id of members.slice(1)) parent.set(find(id), find(members[0]));
  }
  const teams = new Map();
  for (const project of projects.values()) {
    const root = find(Object.keys(project.roles)[0]);
    const team = teams.get(root) ?? { projects: [], members: new Set() };
    team.projects.push(project);
    for (const id of Object.keys(project.roles)) team.members.add(id);
    teams.set(root, team);
  }
  return [...teams.values()].map((team) => {
    const owned = new Map();
    for (const project of team.projects) owned.set(project.ownerId, (owned.get(project.ownerId) ?? 0) + 1);
    const ownerId = [...owned.entries()].sort((a, b) => b[1] - a[1])[0][0];
    return { id: ownerId, ownerId, projects: team.projects, members: [...team.members] };
  });
}

async function describeTeams(db, teams, now) {
  const ids = [...new Set(teams.flatMap((team) => team.members))];
  const projectIds = teams.flatMap((team) => team.projects.map((project) => project.id));
  const [people, points, bytes] = await Promise.all([
    db.query(
      `SELECT u.id, u.phone, u.nickname, u.last_active_at, sub.plan_id FROM users u ${currentSubscription.replaceAll('$1', '$2')}
        WHERE u.id = ANY($1)`,
      [ids, now],
    ),
    db.query(
      'SELECT user_id, SUM(points) AS points FROM usage_daily WHERE user_id = ANY($1) AND day >= $2 GROUP BY user_id',
      [ids, chinaDay(monthStart(now))],
    ),
    db.query(
      `SELECT project_id, SUM(size_bytes) AS bytes FROM blobs
        WHERE project_id = ANY($1) AND status = 'complete' AND deleted_at IS NULL GROUP BY project_id`,
      [projectIds],
    ),
  ]);
  const names = await planNames(db);
  const person = new Map(people.rows.map((row) => [row.id, row]));
  const used = new Map(points.rows.map((row) => [row.user_id, n(row.points)]));
  const size = new Map(bytes.rows.map((row) => [row.project_id, n(row.bytes)]));
  return teams.map((team) => {
    const owner = person.get(team.ownerId);
    const memberList = team.members.map((id) => {
      const row = person.get(id);
      return {
        id,
        name: row ? displayName(row) : id,
        phone: maskPhone(row?.phone),
        plan: row?.plan_id ?? 'free',
        planName: names.get(row?.plan_id ?? 'free'),
        points: used.get(id) ?? 0,
        lastActiveAt: row?.last_active_at ?? null,
      };
    });
    const edges = new Map();
    for (const project of team.projects) {
      const members = Object.keys(project.roles);
      for (let a = 0; a < members.length; a += 1)
        for (let b = a + 1; b < members.length; b += 1) {
          const key = [members[a], members[b]].sort().join('|');
          edges.set(key, (edges.get(key) ?? 0) + 1);
        }
    }
    return {
      id: team.id,
      ownerId: team.ownerId,
      name: `${owner ? displayName(owner) : '未知'}的团队`,
      ownerPlan: owner?.plan_id ?? 'free',
      ownerPlanName: names.get(owner?.plan_id ?? 'free'),
      members: memberList,
      projects: team.projects.map((project) => ({ ...project, bytes: size.get(project.id) ?? 0 })),
      edges: [...edges.entries()].map(([key, weight]) => {
        const [a, b] = key.split('|');
        return { a, b, weight };
      }),
      bytes: team.projects.reduce((sum, project) => sum + (size.get(project.id) ?? 0), 0),
      points: memberList.reduce((sum, member) => sum + member.points, 0),
      lastActiveAt: memberList.map((member) => member.lastActiveAt).filter(Boolean).sort().at(-1) ?? null,
    };
  });
}

export async function teams(db, now = new Date()) {
  const described = await describeTeams(db, await inferTeams(db), now);
  return described.sort((a, b) => b.members.length - a.members.length || b.points - a.points);
}

const DOMAIN_NAMES = { library: '文献', code: '代码', doc: '文档', asset: '笔记图片' };

export async function teamDetail(db, teamId, now = new Date()) {
  const team = (await inferTeams(db)).find((item) => item.id === teamId || item.members.includes(teamId));
  if (!team) return null;
  const [described] = await describeTeams(db, [team], now);
  const projectIds = team.projects.map((project) => project.id);
  const since = addDays(now, -30);
  const [activity, domains, invites, ownerPlan] = await Promise.all([
    db.query(
      `SELECT updated_by, to_char((updated_at AT TIME ZONE 'Asia/Shanghai')::date, 'YYYY-MM-DD') AS day, COUNT(*) AS changes
         FROM (SELECT updated_by, updated_at FROM sync_entities WHERE project_id = ANY($1) AND updated_at > $2
               UNION ALL
               SELECT updated_by, updated_at FROM sync_entity_versions WHERE project_id = ANY($1) AND updated_at > $2) changes
        GROUP BY 1, 2`,
      [projectIds, since],
    ),
    db.query(
      `SELECT project_id, domain, SUM(size_bytes) AS bytes FROM sync_entities
        WHERE project_id = ANY($1) AND NOT deleted AND size_bytes IS NOT NULL GROUP BY project_id, domain`,
      [projectIds],
    ),
    db.query('SELECT project_id, phone, role FROM project_invitations WHERE project_id = ANY($1)', [projectIds]),
    currentPlan(db, team.ownerId, now),
  ]);
  const days = [];
  for (let offset = 29; offset >= 0; offset -= 1) days.push(chinaDay(addDays(now, -offset)));
  const heat = new Map();
  for (const row of activity.rows) heat.set(`${row.updated_by}|${row.day}`, n(row.changes));
  const composition = new Map();
  for (const row of domains.rows) {
    const entry = composition.get(row.project_id) ?? {};
    const name = DOMAIN_NAMES[row.domain] ?? '其他';
    entry[name] = (entry[name] ?? 0) + n(row.bytes);
    composition.set(row.project_id, entry);
  }
  return {
    ...described,
    ownerLimits: { maxMembers: ownerPlan.plan.maxMembers, storageBytes: ownerPlan.plan.storageBytes },
    days,
    heat: described.members.map((member) => days.map((day) => heat.get(`${member.id}|${day}`) ?? 0)),
    composition: described.projects.map((project) => ({ id: project.id, name: project.name, parts: composition.get(project.id) ?? {} })),
    invites: invites.rows.map((row) => ({
      project: team.projects.find((project) => project.id === row.project_id)?.name ?? '',
      phone: maskPhone(row.phone),
      role: row.role,
    })),
  };
}

export async function usageReport(db, query, now = new Date()) {
  const days = Math.min(90, Math.max(1, Number(query.days) || 30));
  const group = ['user', 'team', 'model', 'plan'].includes(query.group) ? query.group : 'user';
  const from = chinaDay(addDays(now, -(days - 1)));
  const sums = `SUM(requests) AS requests, SUM(input_tokens) AS input, SUM(cached_tokens) AS cached,
                SUM(output_tokens) AS output, SUM(points) AS points, SUM(cost_micros) AS cost,
                SUM(estimated_requests) AS estimated, SUM(error_requests) AS errors`;
  const total = await db.query(`SELECT ${sums} FROM usage_daily WHERE day >= $1`, [from]);
  const daily = await db.query(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, model_id, SUM(points) AS points FROM usage_daily
      WHERE day >= $1 GROUP BY day, model_id`,
    [from],
  );
  const view = (row, extra) => ({
    ...extra,
    requests: n(row.requests),
    input: n(row.input),
    cached: n(row.cached),
    output: n(row.output),
    points: n(row.points),
    cost: n(row.cost) / 1e6,
    estimated: n(row.estimated),
    errors: n(row.errors),
  });
  let rows;
  if (group === 'model') {
    const { models } = await catalog(db);
    const result = await db.query(`SELECT model_id, ${sums} FROM usage_daily WHERE day >= $1 GROUP BY model_id ORDER BY points DESC`, [from]);
    rows = result.rows.map((row) => view(row, { id: row.model_id, name: models.find((m) => m.id === row.model_id)?.name ?? row.model_id }));
  } else if (group === 'plan') {
    const names = await planNames(db);
    const result = await db.query(
      `SELECT COALESCE(sub.plan_id, 'free') AS plan_id, COUNT(DISTINCT d.user_id) AS users, ${sums.replace(/SUM\((\w+)\)/g, 'SUM(d.$1)')}
         FROM usage_daily d JOIN users u ON u.id = d.user_id ${currentSubscription.replaceAll('$1', '$2')}
        WHERE d.day >= $1 GROUP BY 1 ORDER BY points DESC`,
      [from, now],
    );
    rows = result.rows.map((row) => view(row, { id: row.plan_id, name: names.get(row.plan_id) ?? row.plan_id, users: n(row.users) }));
  } else {
    const result = await db.query(
      `SELECT d.user_id, u.phone, u.nickname, ${sums.replace(/SUM\((\w+)\)/g, 'SUM(d.$1)')}
         FROM usage_daily d JOIN users u ON u.id = d.user_id WHERE d.day >= $1
        GROUP BY d.user_id, u.phone, u.nickname ORDER BY points DESC LIMIT 500`,
      [from],
    );
    const perUser = result.rows.map((row) => view(row, { id: row.user_id, name: displayName(row), phone: maskPhone(row.phone) }));
    if (group === 'user') rows = perUser.slice(0, 50);
    else {
      const byUser = new Map(perUser.map((row) => [row.id, row]));
      rows = (await teams(db, now))
        .map((team) => {
          const sum = { requests: 0, input: 0, cached: 0, output: 0, points: 0, cost: 0, estimated: 0, errors: 0 };
          for (const member of team.members) {
            const row = byUser.get(member.id);
            if (row) for (const key of Object.keys(sum)) sum[key] += row[key];
          }
          return { id: team.id, name: team.name, members: team.members.length, ...sum };
        })
        .sort((a, b) => b.points - a.points);
    }
  }
  const dayList = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) dayList.push(chinaDay(addDays(now, -offset)));
  const byDay = new Map();
  for (const row of daily.rows) {
    const entry = byDay.get(row.day) ?? {};
    entry[row.model_id] = n(row.points);
    byDay.set(row.day, entry);
  }
  return {
    days: dayList,
    modelDaily: dayList.map((day) => byDay.get(day) ?? {}),
    total: view(total.rows[0], {}),
    group,
    rows,
  };
}

/** Per-model points over 30 days and per-channel health over 24 hours. */
export async function modelStats(db, now = new Date()) {
  const [points, health] = await Promise.all([
    db.query('SELECT model_id, SUM(points) AS points FROM usage_daily WHERE day >= $1 GROUP BY model_id', [
      chinaDay(addDays(now, -29)),
    ]),
    db.query(
      `SELECT channel_id, COUNT(*) AS requests, COUNT(*) FILTER (WHERE status = 'error') AS errors,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50
         FROM usage_events WHERE created_at > $1 AND channel_id IS NOT NULL GROUP BY channel_id`,
      [new Date(now.getTime() - 86_400_000)],
    ),
  ]);
  return {
    points: Object.fromEntries(points.rows.map((row) => [row.model_id, n(row.points)])),
    channels: Object.fromEntries(
      health.rows.map((row) => [
        row.channel_id,
        { requests: n(row.requests), errorRate: n(row.errors) / Math.max(1, n(row.requests)), p50: Math.round(n(row.p50)) },
      ]),
    ),
  };
}
