// The admin pages: static files at /admin and their API at /admin/api. Every
// change is written to the audit log with the administrator, before and after.

import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { body, clientAddress, fail, integer, send } from '../http.mjs';
import { withTransaction } from '../db.mjs';
import { normalizePhone } from '../sms.mjs';
import { sendCode } from '../signin.mjs';
import { forgetStatus } from '../auth.mjs';
import { withAutoPrices } from '../billing/pricing.mjs';
import { addGrant, balance, debit, ensureGrants, resetPeriodGrant } from '../billing/ledger.mjs';
import { addDays, plans as allPlans } from '../billing/plans.mjs';
import { addOrder, codeHash, extendPlan, newCode, resetToday, usedToday } from '../billing/account.mjs';
import { catalog, channelView, forgetModels, keyHint, openKey, sealKey } from '../billing/models.mjs';
import { typical } from '../billing/meter.mjs';
import { resetLimits } from '../billing/limits.mjs';
import { upstreamUrl } from '../billing/proxy.mjs';
import { requireAdmin, resetPassword, signIn, signOut, ROLES } from './session.mjs';
import { auditView, maskPhone, modelStats, overview, teamDetail, teams, usageReport, userDetail, users } from './queries.mjs';

const DEFAULT_DIR = fileURLToPath(new URL('../../admin/', import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
/** Nothing from other sites: scripts, styles and requests stay on this server. */
const CSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

async function serveStatic(response, config, path) {
  const root = resolve(config.adminDir || DEFAULT_DIR);
  if (!existsSync(join(root, 'index.html'))) return send(response, 404, { error: 'not_found' });
  if (path === '/admin') {
    response.writeHead(302, { location: '/admin/' });
    return response.end();
  }
  const wanted = decodeURIComponent(path.slice('/admin/'.length)) || 'index.html';
  let file = resolve(root, wanted);
  if (file !== root && !file.startsWith(root + sep)) file = join(root, 'index.html');
  const isFile = await stat(file).then(
    (entry) => entry.isFile(),
    () => false,
  );
  if (!isFile) file = join(root, 'index.html');
  const data = await readFile(file);
  response.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'content-length': data.length,
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'content-security-policy': CSP,
  });
  response.end(data);
}

async function audit(db, admin, request, config, entry) {
  await db.query(
    `INSERT INTO admin_audit(admin_id, admin_phone, action, target_type, target_id, target_label, before, after, reason, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      admin.id,
      admin.phone,
      entry.action,
      entry.targetType ?? null,
      entry.targetId ?? null,
      entry.target ?? null,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
      entry.reason ?? null,
      clientAddress(request, config),
    ],
  );
}

const text = (value, max, name) => {
  const out = String(value ?? '').trim();
  if (out.length > max) throw fail(400, `${name}过长。`);
  return out;
};
const required = (value, max, name) => {
  const out = text(value, max, name);
  if (!out) throw fail(400, `请填写${name}。`);
  return out;
};
const MODEL_ID = /^[A-Za-z0-9._:/-]{1,80}$/;

/** A model ID from an upstream name, made unique among `taken`. */
export function uniqueModelId(source, taken) {
  const base =
    String(source)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._:/-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 72) || 'model';
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  return id;
}

// Names that are almost never chat models; the picker hides them unless asked.
const NOT_CHAT = /(embed|rerank|tts|whisper|dall-?e|image|audio|speech|asr|moderation|cosyvoice|paraformer|sambert|wanx|flux|diffusion|video|ocr|realtime)/i;

/** What a model service says it offers at {endpoint}/models, in any of the common shapes. */
export function readModelList(value) {
  const list = Array.isArray(value?.data)
    ? value.data
    : Array.isArray(value?.models)
      ? value.models
      : Array.isArray(value?.output?.models)
        ? value.output.models
        : null;
  if (!list) return null;
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    const id = String(entry?.id ?? entry?.model ?? entry?.name ?? '').trim();
    if (!id || id.length > 120 || seen.has(id)) continue;
    seen.add(id);
    const modalities = entry?.architecture?.output_modalities ?? entry?.output_modalities;
    const textOut = Array.isArray(modalities) ? modalities.some((m) => String(m).toLowerCase() === 'text') : true;
    const name = String(entry?.display_name ?? entry?.displayName ?? entry?.name ?? id).trim().slice(0, 80);
    out.push({ id, name: name === id ? id : name, ownedBy: String(entry?.owned_by ?? ''), chat: textOut && !NOT_CHAT.test(id) });
  }
  return out.sort((a, b) => Number(b.chat) - Number(a.chat) || a.id.localeCompare(b.id));
}

async function upstreamModels(config, channel) {
  const url = upstreamUrl(channel, 'responses');
  url.pathname = url.pathname.replace(/\/responses$/, '/models');
  const started = Date.now();
  try {
    const answer = await fetch(url, {
      headers: { authorization: `Bearer ${openKey(config, channel.key_cipher)}` },
      signal: AbortSignal.timeout(15_000),
    });
    const value = await answer.json().catch(() => ({}));
    const models = answer.ok ? readModelList(value) : null;
    return {
      ok: answer.ok && !!models,
      status: answer.status,
      latencyMs: Date.now() - started,
      models,
      ...(answer.ok && !models ? { error: '服务没有返回模型列表' } : {}),
    };
  } catch (error) {
    return { ok: false, status: null, latencyMs: Date.now() - started, models: null, error: String(error.message ?? error) };
  }
}

async function userLabel(db, userId) {
  const result = await db.query('SELECT phone, nickname FROM users WHERE id = $1', [userId]);
  const row = result.rows[0];
  if (!row) throw fail(404, '用户不存在。');
  return `${row.nickname || ''}${row.nickname ? ' ' : ''}${maskPhone(row.phone)}`;
}

function nonNegative(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1e9) throw fail(400, `${name}无效。`);
  return parsed;
}

function readModel(input, existing = {}) {
  const read = (key, fallback) => (input[key] === undefined ? fallback : input[key]);
  // Prices follow the cost (plus 10%): all of them when the form asks, otherwise the ones left at 0.
  return withAutoPrices({
    name: required(read('name', existing.name), 80, '对外名称'),
    tier: text(read('tier', existing.tier ?? '标准'), 20, '档位') || '标准',
    upstream: required(read('upstream', existing.upstream), 120, '上游模型'),
    channelId: required(read('channelId', existing.channelId), 80, '渠道'),
    backupChannelId: text(read('backupChannelId', existing.backupChannelId ?? ''), 80, '备用渠道') || null,
    costInput: nonNegative(read('costInput', existing.costInput ?? 0), '成本价'),
    costCached: nonNegative(read('costCached', existing.costCached ?? 0), '成本价'),
    costOutput: nonNegative(read('costOutput', existing.costOutput ?? 0), '成本价'),
    priceInput: Math.round(nonNegative(read('priceInput', existing.priceInput ?? 0), '售价')),
    priceCached: Math.round(nonNegative(read('priceCached', existing.priceCached ?? 0), '售价')),
    priceOutput: Math.round(nonNegative(read('priceOutput', existing.priceOutput ?? 0), '售价')),
    plans: (Array.isArray(read('plans', existing.plans)) ? read('plans', existing.plans) : [])
      .map(String)
      .filter((plan) => /^[a-z0-9_-]{1,40}$/.test(plan)),
    active: !!read('active', existing.active ?? false),
    isDefault: !!read('isDefault', existing.isDefault ?? false),
    sort: integer(read('sort', existing.sort ?? 0), 0, -1000, 1000),
  }, input.autoPrice === true);
}

export async function handleAdmin(request, response, context, path, url) {
  if (!path.startsWith('/admin/api/')) {
    if (request.method !== 'GET') return send(response, 405, { error: 'method_not_allowed' });
    return serveStatic(response, context.config, path).catch((error) => sendAdminError(response, error));
  }
  try {
    await route(request, response, context, path.slice('/admin/api'.length).replace(/\/+$/, ''), url);
  } catch (error) {
    sendAdminError(response, error);
  }
}

function sendAdminError(response, error) {
  const status = Number(error?.status) || (error?.code === '23505' ? 409 : 500);
  if (status >= 500) console.error(error);
  if (response.headersSent) return response.end();
  const code = typeof error?.code === 'string' && /^[a-z_]+$/.test(error.code) ? error.code : undefined;
  send(response, status, { error: status >= 500 ? '服务器内部错误。' : error.message, ...(code ? { code } : {}) });
}

async function route(request, response, { config, db }, path, url) {
  const method = request.method;
  const ip = clientAddress(request, config);
  if (request.headers['x-scientify-admin'] !== '1') throw fail(403, '请求来源无效。');

  if (method === 'POST' && path === '/send-code') {
    const input = await body(request, 4096);
    const phone = normalizePhone(input.phone);
    // Only administrators get a text (to reset the password); everyone gets the same answer.
    const admin = await db.query('SELECT 1 FROM users WHERE phone = $1 AND admin_role IS NOT NULL', [phone]);
    if (admin.rows[0]) await sendCode(db, config, phone, ip);
    return send(response, 202, { accepted: true });
  }
  if (method === 'POST' && (path === '/login' || path === '/reset-password')) {
    const input = await body(request, 4096);
    const phone = normalizePhone(input.phone);
    const reset = path === '/reset-password';
    const { cookie, admin } = reset
      ? await resetPassword(db, config, { phone, code: input.code, password: input.password }, ip)
      : await signIn(db, config, { phone, password: input.password }, ip);
    await audit(db, admin, request, config, { action: reset ? '用验证码重设密码' : '登录后台' });
    return send(response, 200, { admin: { phone: maskPhone(admin.phone), role: admin.role, roleName: ROLES[admin.role] } }, { 'set-cookie': cookie });
  }
  if (method === 'POST' && path === '/logout') {
    return send(response, 200, { ok: true }, { 'set-cookie': await signOut(db, config, request) });
  }

  const write = method !== 'GET';
  const admin = await requireAdmin(db, request, { write });
  const record = (entry) => audit(db, admin, request, config, entry);

  if (method === 'GET' && path === '/me')
    return send(response, 200, { phone: maskPhone(admin.phone), role: admin.role, roleName: ROLES[admin.role] });
  if (method === 'GET' && path === '/overview') return send(response, 200, await overview(db));
  if (method === 'GET' && path === '/users') return send(response, 200, await users(db, Object.fromEntries(url.searchParams)));
  if (method === 'GET' && path === '/teams') return send(response, 200, { teams: await teams(db) });
  if (method === 'GET' && path === '/usage') return send(response, 200, await usageReport(db, Object.fromEntries(url.searchParams)));
  if (method === 'GET' && path === '/plans') return send(response, 200, { plans: await allPlans(db) });

  // The WeChat group QR code the app's upgrade card shows. WeChat renews it weekly.
  if (method === 'GET' && path === '/settings/contact') {
    const result = await db.query("SELECT value, updated_at FROM app_settings WHERE key = 'wechat_qr'");
    return send(response, 200, { wechatQr: result.rows[0]?.value ?? null, updatedAt: result.rows[0]?.updated_at ?? null });
  }
  if (method === 'POST' && path === '/settings/contact') {
    const input = await body(request, 3 * 1024 * 1024);
    const image = String(input.wechatQr ?? '');
    if (image && !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(image))
      throw fail(400, '请上传 PNG、JPG 或 WebP 图片。');
    if (image.length > 2_800_000) throw fail(400, '图片不能超过 2 MB。');
    if (image)
      await db.query(
        `INSERT INTO app_settings(key, value, updated_by, updated_at) VALUES ('wechat_qr', $1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        [image, admin.id],
      );
    else await db.query("DELETE FROM app_settings WHERE key = 'wechat_qr'");
    await record({ targetType: 'settings', targetId: 'wechat_qr', target: '微信群二维码', action: image ? '更换微信群二维码' : '删除微信群二维码' });
    return send(response, 200, { ok: true });
  }

  const teamMatch = path.match(/^\/teams\/([^/]+)$/);
  if (method === 'GET' && teamMatch) {
    const detail = await teamDetail(db, decodeURIComponent(teamMatch[1]));
    if (!detail) throw fail(404, '团队不存在。');
    return send(response, 200, detail);
  }

  const userMatch = path.match(/^\/users\/([^/]+)(?:\/(.+))?$/);
  if (userMatch) {
    const userId = decodeURIComponent(userMatch[1]);
    const action = userMatch[2] ?? '';
    if (method === 'GET' && !action) {
      const detail = await userDetail(db, userId);
      if (!detail) throw fail(404, '用户不存在。');
      return send(response, 200, detail);
    }
    const label = await userLabel(db, userId);
    const target = { targetType: 'user', targetId: userId, target: label };
    if (method === 'POST' && action === 'reveal') {
      const result = await db.query('SELECT phone FROM users WHERE id = $1', [userId]);
      const input = await body(request, 4096);
      await record({ ...target, action: '显示手机号', reason: text(input.reason, 200, '原因') || null });
      return send(response, 200, { phone: result.rows[0].phone });
    }
    if (method === 'POST' && action === 'credits') {
      const input = await body(request, 4096);
      const delta = integer(input.delta, null, -1_000_000, 1_000_000);
      if (!delta) throw fail(400, '请输入要调整的点数。');
      const reason = required(input.reason, 200, '原因');
      const note = text(input.note, 500, '备注');
      const days = integer(input.days, 90, 1, 3650);
      const now = new Date();
      await withTransaction(db, async (client) => {
        await ensureGrants(client, userId, now);
        if (delta > 0)
          await addGrant(client, userId, {
            source: 'adjust',
            points: delta,
            startsAt: now,
            expiresAt: addDays(now, days),
            note: [reason, note].filter(Boolean).join('：'),
            adminId: admin.id,
            now,
          });
        else
          await debit(
            client,
            userId,
            -delta,
            { reason: 'adjust', adminId: admin.id, note: [reason, note].filter(Boolean).join('：'), allowDebt: false },
            now,
          );
      });
      await record({ ...target, action: delta > 0 ? '增加额度' : '扣减额度', after: { points: delta, days: delta > 0 ? days : null }, reason: [reason, note].filter(Boolean).join('：') });
      return send(response, 200, { ok: true });
    }
    if (method === 'POST' && action === 'refresh-period') {
      // Grants are added when the user next asks; this adds a missing one now.
      const before = await balance(db, userId);
      await withTransaction(db, (client) => ensureGrants(client, userId, new Date()));
      const added = (await balance(db, userId)) - before;
      await record({ ...target, action: '刷新本周期额度', after: { points: added } });
      return send(response, 200, { added });
    }
    if (method === 'POST' && action === 'reset-period') {
      const input = await body(request, 4096);
      const reason = required(input.reason, 200, '原因');
      const added = await withTransaction(db, (client) =>
        resetPeriodGrant(client, userId, { adminId: admin.id, note: `重置本周期额度：${reason}` }),
      );
      if (added === null) throw fail(400, '当前套餐没有按周期发放的点数。');
      await record({ ...target, action: '重置本周期额度', after: { points: added }, reason });
      return send(response, 200, { added });
    }
    if (method === 'POST' && action === 'reset-today') {
      const input = await body(request, 4096);
      const reason = required(input.reason, 200, '原因');
      const before = await usedToday(db, userId);
      await resetToday(db, userId, admin.id);
      await record({ ...target, action: '重置今日用量', before: { points: before }, reason });
      return send(response, 200, { before });
    }
    if (method === 'POST' && action === 'plan') {
      const input = await body(request, 4096);
      const planId = required(input.planId, 40, '套餐');
      const months = planId === 'free' ? 0 : integer(input.months, null, 1, 60);
      if (planId !== 'free' && !months) throw fail(400, '请选择时长。');
      const method_ = required(input.method, 20, '收款方式');
      const amount = Math.round(nonNegative(input.amount ?? 0, '金额') * 100);
      const note = text(input.note, 500, '备注');
      const plan = (await allPlans(db)).find((item) => item.id === planId);
      if (!plan) throw fail(400, '套餐不存在。');
      const endsAt = await withTransaction(db, async (client) => {
        const orderId =
          planId === 'free'
            ? null
            : await addOrder(client, {
                userId,
                item: `${plan.name} · ${months} 个月`,
                planId,
                months,
                amount,
                method: method_,
                note,
                adminId: admin.id,
              });
        return extendPlan(client, userId, planId, months, 'manual', { orderId, adminId: admin.id });
      });
      await record({
        ...target,
        action: planId === 'free' ? '改为免费版' : '开通套餐',
        after: { plan: plan.name, months, method: method_, amount: amount / 100, endsAt },
        reason: note || null,
      });
      return send(response, 200, { ok: true, endsAt });
    }
    if (method === 'POST' && action === 'limits') {
      const input = await body(request, 4096);
      const before = (await db.query('SELECT rpm, concurrency, daily_points, until FROM user_limits WHERE user_id = $1', [userId])).rows[0] ?? null;
      if (input.clear) {
        await db.query('DELETE FROM user_limits WHERE user_id = $1', [userId]);
        resetLimits(userId);
        await record({ ...target, action: '恢复套餐限制', before });
        return send(response, 200, { ok: true });
      }
      const rpm = integer(input.rpm, null, 1, 10_000);
      const concurrency = integer(input.concurrency, null, 1, 100);
      const daily = integer(input.dailyPoints, null, 0, 100_000_000);
      const days = integer(input.days, null, 1, 3650);
      const reason = required(input.reason, 200, '原因');
      const until = days ? addDays(new Date(), days) : null;
      await db.query(
        `INSERT INTO user_limits(user_id, rpm, concurrency, daily_points, until, reason, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (user_id) DO UPDATE SET rpm = EXCLUDED.rpm, concurrency = EXCLUDED.concurrency,
           daily_points = EXCLUDED.daily_points, until = EXCLUDED.until, reason = EXCLUDED.reason,
           updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        [userId, rpm, concurrency, daily, until, reason, admin.id],
      );
      resetLimits(userId);
      await record({ ...target, action: '单独限制', before, after: { rpm, concurrency, dailyPoints: daily, until }, reason });
      return send(response, 200, { ok: true });
    }
    if (method === 'POST' && action === 'status') {
      const input = await body(request, 4096);
      const disabled = !!input.disabled;
      const reason = disabled ? required(input.reason, 200, '原因') : text(input.reason, 200, '原因');
      if (userId === admin.id && disabled) throw fail(400, '不能停用自己的账号。');
      await withTransaction(db, async (client) => {
        await client.query('UPDATE users SET status = $2, disabled_reason = $3, updated_at = NOW() WHERE id = $1', [
          userId,
          disabled ? 'disabled' : 'active',
          disabled ? reason : null,
        ]);
        if (disabled) {
          await client.query('DELETE FROM refresh_tokens WHERE user_id = $1', [userId]);
          await client.query('UPDATE model_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
          await client.query('DELETE FROM admin_sessions WHERE user_id = $1', [userId]);
        }
      });
      forgetStatus(userId);
      await record({ ...target, action: disabled ? '停用账号' : '恢复账号', reason: reason || null });
      return send(response, 200, { ok: true });
    }
    if (method === 'POST' && action === 'sign-out') {
      const tokens = await db.query('DELETE FROM refresh_tokens WHERE user_id = $1', [userId]);
      const models = await db.query('UPDATE model_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
      await record({ ...target, action: '强制下线', after: { sessions: tokens.rowCount, modelTokens: models.rowCount } });
      return send(response, 200, { ok: true, sessions: tokens.rowCount, modelTokens: models.rowCount });
    }
    const deviceMatch = action.match(/^devices\/([^/]+)$/);
    if (method === 'DELETE' && deviceMatch) {
      const id = decodeURIComponent(deviceMatch[1]);
      const result = await db.query(
        'UPDATE model_tokens SET revoked_at = NOW() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING device_name',
        [id, userId],
      );
      if (result.rows[0]) await record({ ...target, action: '吊销模型令牌', after: { device: result.rows[0].device_name } });
      return send(response, 200, { ok: true });
    }
    throw fail(404, '未知操作。');
  }

  const planMatch = path.match(/^\/plans\/([^/]+)$/);
  if (method === 'PUT' && planMatch) {
    const planId = decodeURIComponent(planMatch[1]);
    const before = (await allPlans(db)).find((plan) => plan.id === planId);
    if (!before) throw fail(404, '套餐不存在。');
    const input = await body(request, 8192);
    const next = {
      name: required(input.name ?? before.name, 40, '名称'),
      priceMonth: integer(input.priceMonth, before.priceMonth, 0, 100_000_000),
      priceYear: integer(input.priceYear, before.priceYear, 0, 100_000_000),
      monthlyPoints: integer(input.monthlyPoints, before.monthlyPoints, 0, 100_000_000),
      dailyPoints: integer(input.dailyPoints, before.dailyPoints, 0, 100_000_000),
      storageBytes: integer(input.storageBytes, before.storageBytes, 0, 1e15),
      maxMembers: input.maxMembers === null ? null : integer(input.maxMembers, before.maxMembers, 1, 100_000),
      historyDays: integer(input.historyDays, before.historyDays, 1, 36500),
      rpm: integer(input.rpm, before.rpm, 1, 10_000),
      concurrency: integer(input.concurrency, before.concurrency, 1, 100),
      maxOutputTokens: integer(input.maxOutputTokens, before.maxOutputTokens, 256, 1_000_000),
      active: input.active === undefined ? before.active : !!input.active,
    };
    if (planId === 'free' && !next.active) throw fail(400, '免费版不能下架。');
    await db.query(
      `UPDATE plans SET name = $2, price_month = $3, price_year = $4, monthly_points = $5, daily_points = $6,
              storage_bytes = $7, max_members = $8, history_days = $9, rpm = $10, concurrency = $11,
              max_output_tokens = $12, active = $13, updated_at = NOW() WHERE id = $1`,
      [planId, next.name, next.priceMonth, next.priceYear, next.monthlyPoints, next.dailyPoints, next.storageBytes,
        next.maxMembers, next.historyDays, next.rpm, next.concurrency, next.maxOutputTokens, next.active],
    );
    await record({ action: '修改套餐', targetType: 'plan', targetId: planId, target: next.name, before, after: next });
    return send(response, 200, { ok: true });
  }

  if (method === 'GET' && path === '/models') {
    const [{ models, channels }, stats] = await Promise.all([catalog(db), modelStats(db)]);
    return send(response, 200, {
      models: models.map((model) => ({ ...model, margin: typical(model).margin, points30: stats.points[model.id] ?? 0 })),
      channels: [...channels.values()].map((row) => ({ ...channelView(row), health: stats.channels[row.id] ?? null })),
    });
  }
  if ((method === 'POST' && path === '/models') || (method === 'PUT' && path.startsWith('/models/'))) {
    const input = await body(request, 8192);
    const { models, channels } = await catalog(db);
    const existingId = method === 'PUT' ? decodeURIComponent(path.slice('/models/'.length)) : null;
    const existing = existingId ? models.find((model) => model.id === existingId) : null;
    if (existingId && !existing) throw fail(404, '模型不存在。');
    const id = existing ? existing.id : required(input.id, 80, '模型 ID');
    if (!MODEL_ID.test(id)) throw fail(400, '模型 ID 只能用字母、数字和 . _ : / -。');
    if (!existing && models.some((model) => model.id === id)) throw fail(409, '模型 ID 已存在。');
    const next = readModel(input, existing ?? {});
    if (!channels.has(next.channelId)) throw fail(400, '渠道不存在。');
    if (next.backupChannelId && !channels.has(next.backupChannelId)) throw fail(400, '备用渠道不存在。');
    if (next.active && !(next.priceInput || next.priceOutput)) throw fail(400, '上架前请先填写成本价，售价会按成本加 10% 算出。');
    await withTransaction(db, async (client) => {
      if (next.isDefault) await client.query('UPDATE models SET is_default = FALSE WHERE id <> $1', [id]);
      await client.query(
        `INSERT INTO models(id, name, tier, upstream, channel_id, backup_channel_id, cost_input, cost_cached, cost_output,
                            price_input, price_cached, price_output, plans, active, is_default, sort, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW())
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, tier = EXCLUDED.tier, upstream = EXCLUDED.upstream,
           channel_id = EXCLUDED.channel_id, backup_channel_id = EXCLUDED.backup_channel_id,
           cost_input = EXCLUDED.cost_input, cost_cached = EXCLUDED.cost_cached, cost_output = EXCLUDED.cost_output,
           price_input = EXCLUDED.price_input, price_cached = EXCLUDED.price_cached, price_output = EXCLUDED.price_output,
           plans = EXCLUDED.plans, active = EXCLUDED.active, is_default = EXCLUDED.is_default, sort = EXCLUDED.sort,
           updated_at = NOW()`,
        [id, next.name, next.tier, next.upstream, next.channelId, next.backupChannelId, next.costInput, next.costCached,
          next.costOutput, next.priceInput, next.priceCached, next.priceOutput, next.plans, next.active, next.isDefault, next.sort],
      );
    });
    forgetModels();
    await record({ action: existing ? '修改模型' : '新增模型', targetType: 'model', targetId: id, target: next.name, before: existing ?? undefined, after: next });
    return send(response, 200, { ok: true });
  }

  if ((method === 'POST' && path === '/channels') || (method === 'PUT' && /^\/channels\/[^/]+$/.test(path))) {
    const input = await body(request, 8192);
    const existingId = method === 'PUT' ? decodeURIComponent(path.slice('/channels/'.length)) : null;
    const { channels } = await catalog(db);
    const existing = existingId ? channels.get(existingId) : null;
    if (existingId && !existing) throw fail(404, '渠道不存在。');
    const name = required(input.name ?? existing?.name, 60, '名称');
    const endpoint = required(input.endpoint ?? existing?.endpoint, 500, '地址');
    const chatEndpoint = text(input.chatEndpoint ?? existing?.chat_endpoint ?? '', 500, '地址') || null;
    for (const value of [endpoint, chatEndpoint].filter(Boolean)) {
      let parsed;
      try {
        parsed = new URL(value);
      } catch {
        throw fail(400, '渠道地址格式无效。');
      }
      if (parsed.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(parsed.hostname))
        throw fail(400, '渠道地址必须使用 HTTPS。');
    }
    const key = text(input.key, 4096, '密钥');
    if (!existing && !key) throw fail(400, '请填写密钥。');
    const active = input.active === undefined ? (existing?.active ?? true) : !!input.active;
    const id = existing?.id ?? crypto.randomUUID();
    await db.query(
      `INSERT INTO channels(id, name, endpoint, chat_endpoint, key_cipher, key_hint, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, endpoint = EXCLUDED.endpoint, chat_endpoint = EXCLUDED.chat_endpoint,
         key_cipher = EXCLUDED.key_cipher, key_hint = EXCLUDED.key_hint, active = EXCLUDED.active, updated_at = NOW()`,
      [id, name, endpoint, chatEndpoint, key ? sealKey(config, key) : existing.key_cipher, key ? keyHint(key) : existing.key_hint, active],
    );
    forgetModels();
    await record({
      action: existing ? '修改渠道' : '新增渠道',
      targetType: 'channel',
      targetId: id,
      target: name,
      before: existing ? channelView(existing) : undefined,
      after: { name, endpoint, chatEndpoint, active, keyHint: key ? keyHint(key) : existing.key_hint, keyChanged: !!key },
    });
    return send(response, 200, { ok: true, id });
  }
  const channelMatch = path.match(/^\/channels\/([^/]+)\/(test|models)$/);
  if (channelMatch && ((method === 'POST' && channelMatch[2] === 'test') || (method === 'GET' && channelMatch[2] === 'models'))) {
    const { models, channels } = await catalog(db);
    const channel = channels.get(decodeURIComponent(channelMatch[1]));
    if (!channel) throw fail(404, '渠道不存在。');
    const found = await upstreamModels(config, channel);
    if (channelMatch[2] === 'test')
      return send(response, 200, { ...found, models: found.models ? found.models.length : null });
    if (!found.ok) throw fail(502, `读取上游模型列表失败：${found.status ? `HTTP ${found.status}` : found.error}`);
    // Mark the ones already added from this channel, by their upstream name.
    const added = new Map(models.filter((m) => m.channelId === channel.id).map((m) => [m.upstream, m.id]));
    return send(response, 200, { models: found.models.map((m) => ({ ...m, added: added.get(m.id) ?? null })) });
  }
  if (method === 'POST' && path === '/models/import') {
    const input = await body(request, 65_536);
    const { models, channels } = await catalog(db);
    const channel = channels.get(String(input.channelId ?? ''));
    if (!channel) throw fail(400, '渠道不存在。');
    const wanted = (Array.isArray(input.models) ? input.models : []).slice(0, 200);
    if (!wanted.length) throw fail(400, '请选择要添加的模型。');
    const taken = new Set(models.map((m) => m.id));
    const sort = models.reduce((max, m) => Math.max(max, m.sort), 0);
    const created = [];
    await withTransaction(db, async (client) => {
      for (const [index, item] of wanted.entries()) {
        const upstream = required(item?.upstream, 120, '上游模型');
        const id = uniqueModelId(text(item?.id, 80, '模型 ID') || upstream, taken);
        const name = text(item?.name, 80, '对外名称') || upstream;
        taken.add(id);
        // Added unlisted and without prices: they are listed after pricing.
        await client.query(
          `INSERT INTO models(id, name, tier, upstream, channel_id, plans, active, is_default, sort, updated_at)
           VALUES ($1, $2, '标准', $3, $4, '{pro}', FALSE, FALSE, $5, NOW())`,
          [id, name, upstream, channel.id, sort + index + 1],
        );
        created.push({ id, name, upstream });
      }
    });
    forgetModels();
    await record({ action: '导入模型', targetType: 'channel', targetId: channel.id, target: channel.name, after: { models: created } });
    return send(response, 201, { models: created });
  }

  if (method === 'GET' && path === '/codes') {
    const result = await db.query(
      `SELECT b.*, p.name AS plan_name, COUNT(c.used_by) AS used, u.phone AS creator
         FROM redeem_batches b LEFT JOIN redeem_codes c ON c.batch_id = b.id
         LEFT JOIN plans p ON p.id = b.plan_id LEFT JOIN users u ON u.id = b.created_by
        GROUP BY b.id, p.name, u.phone ORDER BY b.created_at DESC`,
    );
    return send(response, 200, {
      batches: result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind,
        face: row.kind === 'plan' ? `${row.plan_name} · ${row.months} 个月` : `${Number(row.points).toLocaleString('en-US')} 点 · ${row.valid_days} 天`,
        count: Number(row.count),
        used: Number(row.used),
        redeemUntil: row.redeem_until,
        createdAt: row.created_at,
        creator: maskPhone(row.creator),
        voided: !!row.voided_at,
      })),
    });
  }
  if (method === 'POST' && path === '/codes') {
    const input = await body(request, 4096);
    const name = required(input.name, 60, '批次名称');
    const kind = input.kind === 'points' ? 'points' : 'plan';
    const count = integer(input.count, null, 1, 1000);
    if (!count) throw fail(400, '请填写数量。');
    const until = new Date(String(input.redeemUntil ?? ''));
    if (Number.isNaN(until.getTime()) || until <= new Date()) throw fail(400, '兑换截止日期无效。');
    let planId = null;
    let months = null;
    let points = null;
    let validDays = null;
    if (kind === 'plan') {
      planId = required(input.planId, 40, '套餐');
      if (!(await allPlans(db)).some((plan) => plan.id === planId && plan.id !== 'free')) throw fail(400, '套餐不存在。');
      months = integer(input.months, null, 1, 36);
      if (!months) throw fail(400, '请选择时长。');
    } else {
      points = integer(input.points, null, 1, 10_000_000);
      validDays = integer(input.validDays, 90, 1, 3650);
      if (!points) throw fail(400, '请填写点数。');
    }
    const id = crypto.randomUUID();
    const codes = Array.from({ length: count }, newCode);
    await withTransaction(db, async (client) => {
      await client.query(
        `INSERT INTO redeem_batches(id, name, kind, plan_id, months, points, valid_days, count, redeem_until, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, name, kind, planId, months, points, validDays, count, until, admin.id],
      );
      for (const code of codes)
        await client.query('INSERT INTO redeem_codes(code_hash, batch_id) VALUES ($1, $2)', [codeHash(code), id]);
    });
    await record({ action: '生成兑换码', targetType: 'codes', targetId: id, target: name, after: { kind, planId, months, points, validDays, count, redeemUntil: until } });
    // The codes are shown this once; only their hashes are kept.
    return send(response, 201, { id, codes });
  }
  const voidMatch = path.match(/^\/codes\/([^/]+)\/void$/);
  if (method === 'POST' && voidMatch) {
    const id = decodeURIComponent(voidMatch[1]);
    const result = await db.query('UPDATE redeem_batches SET voided_at = NOW() WHERE id = $1 AND voided_at IS NULL RETURNING name', [id]);
    if (result.rows[0]) await record({ action: '作废兑换码', targetType: 'codes', targetId: id, target: result.rows[0].name });
    return send(response, 200, { ok: true });
  }

  if (method === 'GET' && path === '/orders') {
    const result = await db.query(
      `SELECT o.*, u.phone, u.nickname, a.phone AS admin_phone FROM orders o JOIN users u ON u.id = o.user_id
         LEFT JOIN users a ON a.id = o.created_by ORDER BY o.created_at DESC LIMIT 200`,
    );
    return send(response, 200, {
      orders: result.rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        user: row.nickname || maskPhone(row.phone),
        phone: maskPhone(row.phone),
        item: row.item,
        amount: Number(row.amount) / 100,
        method: row.method,
        status: row.status,
        note: row.note ?? '',
        invoice: row.invoice,
        createdAt: row.created_at,
        admin: maskPhone(row.admin_phone),
      })),
    });
  }
  if (method === 'GET' && path === '/lookup') {
    const phone = normalizePhone(url.searchParams.get('phone'));
    const result = await db.query('SELECT id, phone, nickname FROM users WHERE phone = $1', [phone]);
    const row = result.rows[0];
    if (!row) throw fail(404, '这个手机号还没有注册。');
    return send(response, 200, { id: row.id, name: row.nickname || maskPhone(row.phone), phone: maskPhone(row.phone) });
  }
  if (method === 'GET' && path === '/audit') {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
    const result = await db.query('SELECT * FROM admin_audit ORDER BY created_at DESC LIMIT $1', [limit]);
    return send(response, 200, { entries: result.rows.map(auditView) });
  }
  if (method === 'GET' && path === '/errors') {
    const all = url.searchParams.get('all') === '1';
    const result = await db.query(
      `SELECT e.*, u.phone, u.nickname,
              (SELECT COUNT(*) FROM client_error_devices d WHERE d.fingerprint = e.fingerprint) AS devices
         FROM client_errors e LEFT JOIN users u ON u.id = e.last_user_id
        WHERE $1 OR e.resolved_at IS NULL
        ORDER BY e.last_at DESC LIMIT 200`,
      [all],
    );
    return send(response, 200, {
      all,
      errors: result.rows.map((row) => ({
        id: row.fingerprint,
        message: row.message,
        stack: row.stack,
        source: row.source,
        page: row.page,
        version: row.version,
        platform: row.platform,
        count: Number(row.count),
        devices: Number(row.devices),
        user: row.last_user_id ? row.nickname || maskPhone(row.phone) : '',
        userId: row.last_user_id,
        firstAt: row.first_at,
        lastAt: row.last_at,
        resolved: !!row.resolved_at,
      })),
    });
  }
  const errorMatch = path.match(/^\/errors\/([0-9a-f]{32})\/resolve$/);
  if (method === 'POST' && errorMatch) {
    const result = await db.query(
      'UPDATE client_errors SET resolved_at = NOW() WHERE fingerprint = $1 AND resolved_at IS NULL RETURNING message',
      [errorMatch[1]],
    );
    if (result.rows[0])
      await record({ action: '标记错误已处理', targetType: 'errors', targetId: errorMatch[1], target: result.rows[0].message.slice(0, 80) });
    return send(response, 200, { ok: true });
  }
  throw fail(404, '未知接口。');
}
