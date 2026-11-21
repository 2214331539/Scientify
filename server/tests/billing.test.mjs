import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDb, initDb } from '../src/db.mjs';
import { createServer } from '../src/server.mjs';
import { sealKey, forgetModels } from '../src/billing/models.mjs';
import { resetLimits } from '../src/billing/limits.mjs';
import { runJobs } from '../src/jobs.mjs';
import { hashSecret } from '../src/jwt.mjs';

// Billing, the model gateway and the admin API against a throwaway PostgreSQL
// database (own schema) and a fake upstream model service.
const databaseUrl = process.env.TEST_DATABASE_URL;
const options = { skip: databaseUrl ? false : 'set TEST_DATABASE_URL to run the billing tests' };

const config = {
  host: '127.0.0.1',
  port: 0,
  trustProxy: false,
  get databaseUrl() {
    const url = new URL(databaseUrl);
    url.searchParams.set('options', '-c search_path=billing_test');
    return url.toString();
  },
  jwtSecret: 'z'.repeat(40),
  jwtIssuer: 'test',
  accessTokenTtl: 900,
  refreshTokenTtl: 3600,
  oss: {},
  sms: { dryRun: true, developmentCode: '123456', developmentPhones: [] },
  officialModel: { models: [], maxBodyBytes: 4_194_304 },
};

let db;
let server;
let base;
let upstream;
let upstreamBase;
const upstreamRequests = [];
// Per request: input 100,000 (40,000 cached) and output 20,000 tokens = 38 points at the fast model's price.
const USAGE = { input_tokens: 100_000, input_tokens_details: { cached_tokens: 40_000 }, output_tokens: 20_000 };
const POINTS = 38;

function fakeUpstream() {
  return http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const input = raw ? JSON.parse(raw) : {};
    upstreamRequests.push({ path: request.url, auth: request.headers.authorization, input });
    if (request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end(
        JSON.stringify({
          data: [
            { id: 'up-fast' },
            { id: 'Qwen/Qwen3-32B', display_name: 'Qwen3 32B' },
            { id: 'text-embedding-v3' },
            { id: 'painter', architecture: { output_modalities: ['image'] } },
          ],
        }),
      );
    }
    if (input.model === 'up-broken') {
      response.writeHead(500, { 'content-type': 'application/json' });
      return response.end('{"error":"down"}');
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (request.url.endsWith('/chat/completions')) {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`);
      if (input.stream_options?.include_usage)
        response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100_000, prompt_tokens_details: { cached_tokens: 40_000 }, completion_tokens: 20_000 } })}\n\n`);
    } else {
      response.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: '你好' })}\n\n`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      response.write(`data: ${JSON.stringify({ type: 'response.completed', response: { usage: USAGE } })}\n\n`);
    }
    response.end('data: [DONE]\n\n');
  });
}

async function call(method, path, { token, body, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    value = text;
  }
  return { status: response.status, body: value, headers: response.headers };
}

// Codes are stored directly: sending one is limited per address, and the tests all come from one.
async function storeCode(phone) {
  await db.query(
    `INSERT INTO auth_codes(phone, code_hash, expires_at, last_sent_at, attempts)
     VALUES ($1, $2, NOW() + INTERVAL '5 minutes', NOW() - INTERVAL '2 minutes', 0)
     ON CONFLICT (phone) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0`,
    [phone, hashSecret(`${config.jwtSecret}:${phone}:123456`)],
  );
}

async function signUp(phone, password = 'abc12345') {
  await storeCode(phone);
  const result = await call('POST', '/v1/auth/register', { body: { phone, code: '123456', password } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return { token: result.body.accessToken, id: result.body.user.id, phone };
}

async function modelToken(user, deviceId = 'device-1') {
  const result = await call('POST', '/v1/model-tokens', { token: user.token, body: { deviceId, deviceName: 'Test PC' } });
  assert.equal(result.status, 201);
  return result.body.token;
}

const ask = (token, model = 'fast', path = '/v1/responses') =>
  call('POST', path, { token, body: { model, stream: true, input: [{ role: 'user', content: '总结这篇论文' }] } });
const balanceOf = async (user) => (await call('GET', '/v1/billing/summary', { token: user.token })).body.balance;

async function adminSession(phone) {
  const user = await signUp(phone);
  await db.query("UPDATE users SET admin_role = 'owner' WHERE id = $1", [user.id]);
  const headers = { 'x-scientify-admin': '1' };
  const login = await call('POST', '/admin/api/login', { body: { phone, password: 'abc12345' }, headers });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const cookie = login.headers.get('set-cookie').split(';')[0];
  return { ...user, headers: { ...headers, cookie } };
}

before(async () => {
  if (!databaseUrl) return;
  const admin = createDb({ databaseUrl });
  await admin.query('DROP SCHEMA IF EXISTS billing_test CASCADE; CREATE SCHEMA billing_test;');
  await admin.end();
  upstream = fakeUpstream();
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamBase = `http://127.0.0.1:${upstream.address().port}/v1`;
  db = createDb(config);
  await initDb(db);
  await db.query(
    `INSERT INTO channels(id, name, endpoint, key_cipher, key_hint) VALUES ('main', '主渠道', $1, $2, 'cret'),
                                                                    ('spare', '备用渠道', $1, $2, 'cret')`,
    [upstreamBase, sealKey(config, 'upstream-secret')],
  );
  await db.query(
    `INSERT INTO models(id, name, tier, upstream, channel_id, cost_input, cost_cached, cost_output,
                        price_input, price_cached, price_output, plans, active, is_default, sort)
     VALUES ('fast', 'Fast', '经济', 'up-fast', 'main', 2, 0.2, 3, 400, 40, 600, '{free,pro}', TRUE, TRUE, 0),
            ('smart', 'Smart', '高级', 'up-smart', 'main', 6, 1.2, 24, 880, 170, 3100, '{pro}', TRUE, FALSE, 1),
            ('broken', 'Broken', '标准', 'up-broken', 'main', 1, 1, 1, 100, 100, 100, '{free}', TRUE, FALSE, 2)`,
  );
  forgetModels();
  server = createServer(config, db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => resetLimits());

after(async () => {
  if (!databaseUrl) return;
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => upstream.close(resolve));
  await db.query('DROP SCHEMA IF EXISTS billing_test CASCADE');
  await db.end();
});

test('a new account has its sign-up gift and free month, and sees models with multipliers', options, async () => {
  const user = await signUp('13700000001');
  const summary = await call('GET', '/v1/billing/summary', { token: user.token });
  assert.equal(summary.body.plan.id, 'free');
  assert.equal(summary.body.balance, 1300);
  assert.deepEqual(summary.body.grants.map((grant) => grant.source).sort(), ['free', 'signup']);
  const models = await call('GET', '/v1/models', { token: user.token });
  assert.equal(models.body.defaultModel, 'fast');
  const smart = models.body.data.find((model) => model.id === 'smart');
  assert.equal(smart.available, false);
  assert.match(smart.name, /^Smart · 3\.0× · 专业版可用$/);
});

test('a model token streams through, and the points are taken once per request', options, async () => {
  const user = await signUp('13700000002');
  const token = await modelToken(user);
  const before = await balanceOf(user);
  const answer = await ask(token);
  assert.equal(answer.status, 200);
  assert.match(answer.body, /response\.completed/);
  const sent = upstreamRequests.at(-1);
  assert.equal(sent.auth, 'Bearer upstream-secret');
  assert.equal(sent.input.model, 'up-fast');
  assert.equal(await balanceOf(user), before - POINTS);
  const usage = await db.query('SELECT * FROM usage_events WHERE user_id = $1', [user.id]);
  assert.equal(usage.rows.length, 1);
  assert.equal(Number(usage.rows[0].cost_micros), 188_000);
  assert.equal(usage.rows[0].estimated, false);
  // Chat Completions asks the upstream to report usage.
  await ask(token, 'fast', '/v1/chat/completions');
  assert.equal(upstreamRequests.at(-1).input.stream_options.include_usage, true);
  assert.equal(await balanceOf(user), before - 2 * POINTS);
});

test('the plan, the balance and the daily limit each stop a request with their own code', options, async () => {
  const user = await signUp('13700000003');
  const token = await modelToken(user);
  const refused = await ask(token, 'smart');
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'model_not_in_plan');
  await db.query("INSERT INTO user_limits(user_id, daily_points) VALUES ($1, 10)", [user.id]);
  assert.equal((await ask(token)).status, 200);
  const daily = await ask(token);
  assert.equal(daily.status, 429);
  assert.equal(daily.body.code, 'daily_limit');
  await db.query('DELETE FROM user_limits WHERE user_id = $1', [user.id]);
  await db.query('UPDATE credit_grants SET points_left = 0 WHERE user_id = $1', [user.id]);
  const empty = await ask(token);
  assert.equal(empty.status, 402);
  assert.equal(empty.body.code, 'quota_exhausted');
});

test('admins refill the period\'s points and reset the daily limit, each with a reason', options, async () => {
  const user = await signUp('13700000020');
  const token = await modelToken(user);
  const admin = await adminSession('13700000021');
  const act = (action, body) => call('POST', `/admin/api/users/${user.id}/${action}`, { headers: admin.headers, body });
  await db.query('INSERT INTO user_limits(user_id, daily_points) VALUES ($1, 10)', [user.id]);
  assert.equal((await ask(token)).status, 200);
  assert.equal((await ask(token)).body.code, 'daily_limit');
  assert.equal((await act('reset-today', {})).status, 400);
  assert.equal((await act('reset-today', { reason: '赶截止' })).body.before, POINTS);
  assert.equal((await ask(token)).status, 200);
  assert.equal((await ask(token)).body.code, 'daily_limit');
  // The free month's 300 points expire first, so both requests came out of them.
  assert.equal((await act('refresh-period')).body.added, 0);
  const before = await balanceOf(user);
  assert.equal((await act('reset-period', { reason: '故障补偿' })).body.added, 2 * POINTS);
  assert.equal(await balanceOf(user), before + 2 * POINTS);
  assert.equal((await act('reset-period', { reason: '再点一次' })).body.added, 0);
  const audit = await db.query('SELECT action FROM admin_audit WHERE target_id = $1 ORDER BY created_at', [user.id]);
  assert.deepEqual(
    audit.rows.map((row) => row.action),
    ['重置今日用量', '刷新本周期额度', '重置本周期额度', '重置本周期额度'],
  );
});

test('the WeChat QR code an admin uploads reaches the app, and only images are taken', options, async () => {
  const user = await signUp('13700000023');
  const admin = await adminSession('13700000024');
  const set = (wechatQr) => call('POST', '/admin/api/settings/contact', { headers: admin.headers, body: { wechatQr } });
  assert.equal((await call('GET', '/v1/support/contact', { token: user.token })).body.wechatQr, null);
  assert.equal((await set('javascript:alert(1)')).status, 400);
  const image = 'data:image/png;base64,iVBORw0KGgo=';
  assert.equal((await set(image)).status, 200);
  assert.equal((await call('GET', '/v1/support/contact', { token: user.token })).body.wechatQr, image);
  assert.equal((await set('')).status, 200);
  assert.equal((await call('GET', '/v1/support/contact', { token: user.token })).body.wechatQr, null);
  assert.equal((await call('GET', '/v1/support/contact')).status, 401);
});

test('translation has its own allowance and leaves the conversation limits alone', options, async () => {
  const user = await signUp('13700000022');
  const token = await modelToken(user);
  await db.query('INSERT INTO user_limits(user_id, rpm) VALUES ($1, 1)', [user.id]);
  assert.equal((await ask(token)).status, 200);
  assert.equal((await ask(token)).body.code, 'rate_limited');
  const before = await balanceOf(user);
  const translations = await Promise.all(
    Array.from({ length: 4 }, () => ask(token, 'fast', '/v1/translate/chat/completions')),
  );
  assert.ok(translations.every((answer) => answer.status === 200));
  assert.ok(upstreamRequests.at(-1).path.endsWith('/chat/completions'));
  assert.equal(await balanceOf(user), before - 4 * POINTS);
});

test('requests that end together are each charged exactly once', options, async () => {
  const user = await signUp('13700000004');
  const token = await modelToken(user);
  await db.query("INSERT INTO user_limits(user_id, rpm, concurrency) VALUES ($1, 100, 20)", [user.id]);
  const before = await balanceOf(user);
  const answers = await Promise.all(Array.from({ length: 12 }, () => ask(token)));
  assert.ok(answers.every((answer) => answer.status === 200));
  assert.equal(await balanceOf(user), before - 12 * POINTS);
  const daily = await db.query('SELECT requests, points FROM usage_daily WHERE user_id = $1', [user.id]);
  assert.equal(Number(daily.rows[0].requests), 12);
  assert.equal(Number(daily.rows[0].points), 12 * POINTS);
});

test('a request that runs past zero leaves a debt that the next grant pays', options, async () => {
  const user = await signUp('13700000005');
  const token = await modelToken(user);
  await balanceOf(user);
  await db.query("UPDATE credit_grants SET points_left = 10 WHERE user_id = $1 AND source = 'signup'", [user.id]);
  await db.query("UPDATE credit_grants SET points_left = 0 WHERE user_id = $1 AND source = 'free'", [user.id]);
  assert.equal((await ask(token)).status, 200);
  assert.equal(await balanceOf(user), 10 - POINTS);
  assert.equal((await ask(token)).status, 402);
  const owner = await adminSession('13700000099');
  const added = await call('POST', `/admin/api/users/${user.id}/credits`, {
    headers: owner.headers,
    body: { delta: 100, days: 30, reason: '测试补偿' },
  });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.equal(await balanceOf(user), 10 - POINTS + 100);
  const settled = await db.query("SELECT credit_debt FROM users WHERE id = $1", [user.id]);
  assert.equal(Number(settled.rows[0].credit_debt), 0);
});

test('a failing channel is not charged and hands over to the backup', options, async () => {
  const user = await signUp('13700000006');
  const token = await modelToken(user);
  const before = await balanceOf(user);
  const failed = await ask(token, 'broken');
  assert.equal(failed.status, 500);
  assert.equal(await balanceOf(user), before);
  const events = await db.query("SELECT status FROM usage_events WHERE user_id = $1", [user.id]);
  assert.deepEqual(events.rows.map((row) => row.status), ['error']);
});

test('redeem codes work once per code and once per batch per account', options, async () => {
  const owner = await adminSession('13700000098');
  const created = await call('POST', '/admin/api/codes', {
    headers: owner.headers,
    body: { name: '测试批次', kind: 'plan', planId: 'pro', months: 1, count: 3, redeemUntil: '2099-01-01' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const [first, second] = created.body.codes;
  const user = await signUp('13700000007');
  const redeemed = await call('POST', '/v1/billing/redeem', { token: user.token, body: { code: first.toLowerCase() } });
  assert.equal(redeemed.status, 200, JSON.stringify(redeemed.body));
  const summary = await call('GET', '/v1/billing/summary', { token: user.token });
  assert.equal(summary.body.plan.id, 'pro');
  // Upgraded before the free month was ever granted: the gift and the paid month.
  assert.equal(summary.body.balance, 1000 + 3000);
  assert.equal((await call('POST', '/v1/billing/redeem', { token: user.token, body: { code: first } })).body.code, 'code_used');
  assert.equal((await call('POST', '/v1/billing/redeem', { token: user.token, body: { code: second } })).body.code, 'code_batch_used');
  const orders = await call('GET', '/admin/api/orders', { headers: owner.headers });
  assert.ok(orders.body.orders.some((order) => order.method === '兑换码' && order.userId === user.id));
});

test('disabling an account signs it out everywhere and refuses its tokens', options, async () => {
  const owner = await adminSession('13700000097');
  const user = await signUp('13700000008');
  const token = await modelToken(user);
  const refused = await call('POST', `/admin/api/users/${user.id}/status`, { headers: owner.headers, body: { disabled: true } });
  assert.equal(refused.status, 400);
  const disabled = await call('POST', `/admin/api/users/${user.id}/status`, {
    headers: owner.headers,
    body: { disabled: true, reason: '测试停用' },
  });
  assert.equal(disabled.status, 200);
  const me = await call('GET', '/v1/me', { token: user.token });
  assert.equal(me.status, 403);
  assert.equal(me.body.code, 'account_disabled');
  assert.equal((await ask(token)).status, 401);
  const audit = await call('GET', '/admin/api/audit', { headers: owner.headers });
  assert.ok(audit.body.entries.some((entry) => entry.action === '停用账号' && entry.reason === '测试停用'));
});

test('the admin API needs its header and a session, and read-only admins cannot change anything', options, async () => {
  const owner = await adminSession('13700000096');
  assert.equal((await call('GET', '/admin/api/overview', { headers: { cookie: owner.headers.cookie } })).status, 403);
  assert.equal((await call('GET', '/admin/api/overview', { headers: { 'x-scientify-admin': '1' } })).status, 401);
  const overview = await call('GET', '/admin/api/overview', { headers: owner.headers });
  assert.equal(overview.status, 200);
  assert.equal(overview.body.days.length, 30);
  await db.query("UPDATE users SET admin_role = 'viewer' WHERE id = $1", [owner.id]);
  const list = await call('GET', '/admin/api/users?q=137000000', { headers: owner.headers });
  assert.equal(list.status, 200);
  assert.ok(list.body.users.every((user) => /^\d{3}\*{4}\d{4}$/.test(user.phone)));
  const change = await call('POST', `/admin/api/users/${list.body.users[0].id}/credits`, {
    headers: owner.headers,
    body: { delta: 5, reason: 'x' },
  });
  assert.equal(change.status, 403);
  // The pages themselves are served with a strict content policy.
  const page = await fetch(`${base}/admin/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
});

test('teams are inferred from shared projects and named after the main owner', options, async () => {
  const owner = await adminSession('13700000095');
  const lead = await signUp('13700000009');
  const member = await signUp('13700000010');
  const created = await call('POST', '/v1/projects', { token: lead.token, body: { name: '共享项目' } });
  await call('POST', `/v1/projects/${created.body.id}/members`, { token: lead.token, body: { phone: member.phone, role: 'editor' } });
  const teams = await call('GET', '/admin/api/teams', { headers: owner.headers });
  const team = teams.body.teams.find((item) => item.ownerId === lead.id);
  assert.ok(team);
  assert.equal(team.members.length, 2);
  assert.deepEqual(team.edges, [{ a: [lead.id, member.id].sort()[0], b: [lead.id, member.id].sort()[1], weight: 1 }]);
  const detail = await call('GET', `/admin/api/teams/${lead.id}`, { headers: owner.headers });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.heat.length, 2);
});

test('expired grants are zeroed and their unused points recorded', options, async () => {
  const user = await signUp('13700000011');
  await balanceOf(user);
  await db.query("UPDATE credit_grants SET expires_at = NOW() - INTERVAL '1 minute' WHERE user_id = $1 AND source = 'signup'", [user.id]);
  await runJobs(db);
  const ledger = await db.query("SELECT delta FROM credit_ledger WHERE user_id = $1 AND reason = 'expire'", [user.id]);
  assert.deepEqual(ledger.rows.map((row) => Number(row.delta)), [-1000]);
  assert.equal(await balanceOf(user), 300);
});

test('admins sign in with a password and reset a forgotten one with an SMS code', options, async () => {
  const headers = { 'x-scientify-admin': '1' };
  // An admin who only ever signed in by SMS has no password: the reset sets one.
  const phone = '13700000094';
  await storeCode(phone);
  const first = await call('POST', '/v1/auth/login', { body: { phone, code: '123456' } });
  await db.query("UPDATE users SET admin_role = 'owner' WHERE phone = $1", [phone]);
  const refused = await call('POST', '/admin/api/login', { body: { phone, password: 'whatever1' }, headers });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /忘记密码/);
  assert.equal((await call('POST', '/admin/api/reset-password', { body: { phone, code: '000000', password: 'newpass123' }, headers })).status, 400);
  await storeCode(phone);
  const reset = await call('POST', '/admin/api/reset-password', { body: { phone, code: '123456', password: 'newpass123' }, headers });
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  const cookie = reset.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('GET', '/admin/api/me', { headers: { ...headers, cookie } })).status, 200);
  // It is the account's password: the desktop app signs out, and the new password signs in.
  const refreshed = await call('POST', '/v1/auth/refresh', { body: { refreshToken: first.body.refreshToken } });
  assert.equal(refreshed.status, 401);
  assert.equal((await call('POST', '/admin/api/login', { body: { phone, password: 'newpass123' }, headers })).status, 200);
  // A number that is not an administrator cannot reset through the admin pages.
  const member = await signUp('13700000093');
  await storeCode(member.phone);
  const other = await call('POST', '/admin/api/reset-password', { body: { phone: member.phone, code: '123456', password: 'newpass123' }, headers });
  assert.equal(other.status, 400);
});

test('a channel lists its upstream models, and picked ones are added unlisted', options, async () => {
  const owner = await adminSession('13700000092');
  const listed = await call('GET', '/admin/api/channels/main/models', { headers: owner.headers });
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  const byId = Object.fromEntries(listed.body.models.map((m) => [m.id, m]));
  assert.equal(byId['up-fast'].added, 'fast');
  assert.equal(byId['Qwen/Qwen3-32B'].name, 'Qwen3 32B');
  assert.equal(byId['Qwen/Qwen3-32B'].chat, true);
  assert.equal(byId['text-embedding-v3'].chat, false);
  assert.equal(byId.painter.chat, false);
  // Chat models come first.
  assert.equal(listed.body.models.at(-1).chat, false);
  const imported = await call('POST', '/admin/api/models/import', {
    headers: owner.headers,
    body: { channelId: 'main', models: [{ upstream: 'Qwen/Qwen3-32B', name: 'Qwen3 32B' }, { upstream: 'up-fast' }] },
  });
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  assert.deepEqual(imported.body.models.map((m) => m.id), ['qwen/qwen3-32b', 'up-fast']);
  const models = await call('GET', '/admin/api/models', { headers: owner.headers });
  const added = models.body.models.find((m) => m.id === 'qwen/qwen3-32b');
  assert.equal(added.active, false);
  assert.deepEqual(added.plans, ['pro']);
  assert.equal(added.upstream, 'Qwen/Qwen3-32B');
  // A second import of the same name gets its own ID.
  const again = await call('POST', '/admin/api/models/import', { headers: owner.headers, body: { channelId: 'main', models: [{ upstream: 'Qwen/Qwen3-32B' }] } });
  assert.equal(again.body.models[0].id, 'qwen/qwen3-32b-2');
});
