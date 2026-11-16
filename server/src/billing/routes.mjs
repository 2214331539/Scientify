// Billing routes for the desktop app: the official model list, the account's
// plan and points, usage, redeem codes and the per-device model tokens.

import crypto from 'node:crypto';
import { body, fail, send } from '../http.mjs';
import { hashSecret } from '../jwt.mjs';
import { caller, newModelToken } from '../auth.mjs';
import { currentPlan } from './plans.mjs';
import { availableTo, catalog, multiplier } from './models.mjs';
import { effectiveLimits } from './limits.mjs';
import { isModelPath, proxyModel } from './proxy.mjs';
import { redeem, summary, usageByDay } from './account.mjs';

const redeemTries = new Map();
function limitRedeem(userId) {
  const now = Date.now();
  const recent = (redeemTries.get(userId) ?? []).filter((at) => now - at < 10 * 60_000);
  if (recent.length >= 10) throw fail(429, '兑换尝试过多，请 10 分钟后再试。');
  recent.push(now);
  redeemTries.set(userId, recent);
}

/** Answers billing and model routes; returns false for any other path. */
export async function handleBilling(request, response, context, path, url) {
  const { db } = context;
  const method = request.method;
  if (method === 'POST' && isModelPath(path)) {
    const who = await caller(request, context, { models: true });
    await proxyModel(request, response, context, path, who);
    return true;
  }
  if (method === 'GET' && path === '/v1/models') {
    const who = await caller(request, context, { models: true });
    const { models } = await catalog(db);
    const { plan } = await currentPlan(db, who.sub);
    const listed = models.filter((model) => model.active);
    const data = listed.map((model) => {
      const available = model.plans.includes(plan.id);
      const times = multiplier(model, listed);
      return {
        id: model.id,
        object: 'model',
        owned_by: 'scientify',
        name: `${model.name} · ${times}${available ? '' : ` · ${availableTo(model)}可用`}`,
        multiplier: times,
        tier: model.tier,
        available,
      };
    });
    const preferred = listed.find((model) => model.isDefault) ?? listed[0];
    send(response, 200, { object: 'list', data, defaultModel: preferred?.id ?? null });
    return true;
  }
  if (method === 'GET' && path === '/v1/billing/summary') {
    const who = await caller(request, context, { models: true });
    send(
      response,
      200,
      await summary(db, who.sub, (plan) => effectiveLimits(db, who.sub, plan)),
    );
    return true;
  }
  if (method === 'GET' && path === '/v1/billing/usage') {
    const who = await caller(request, context);
    const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days')) || 30));
    send(response, 200, await usageByDay(db, who.sub, days));
    return true;
  }
  if (method === 'POST' && path === '/v1/billing/redeem') {
    const who = await caller(request, context);
    limitRedeem(who.sub);
    const input = await body(request, 4096);
    const code = String(input.code ?? '').trim();
    if (!code || code.length > 64) throw fail(400, '请输入兑换码。');
    const result = await redeem(db, who.sub, code);
    send(response, 200, { ok: true, result });
    return true;
  }
  if (path === '/v1/model-tokens' && method === 'POST') {
    const who = await caller(request, context);
    const input = await body(request, 4096);
    const deviceId = String(input.deviceId ?? '').trim().slice(0, 80);
    const deviceName = String(input.deviceName ?? '').trim().slice(0, 120) || '未命名设备';
    if (!deviceId) throw fail(400, '缺少设备标识。');
    const token = newModelToken();
    const id = crypto.randomUUID();
    // A device keeps one token: asking again replaces the old one.
    await db.query(
      `UPDATE model_tokens SET revoked_at = NOW()
        WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL`,
      [who.sub, deviceId],
    );
    await db.query(
      `INSERT INTO model_tokens(id, user_id, device_id, device_name, token_hash) VALUES ($1, $2, $3, $4, $5)`,
      [id, who.sub, deviceId, deviceName, hashSecret(token)],
    );
    send(response, 201, { id, token });
    return true;
  }
  if (path === '/v1/model-tokens' && method === 'GET') {
    const who = await caller(request, context);
    const result = await db.query(
      `SELECT id, device_id AS "deviceId", device_name AS "deviceName", created_at AS "createdAt",
              last_used_at AS "lastUsedAt"
         FROM model_tokens WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC`,
      [who.sub],
    );
    send(response, 200, { devices: result.rows });
    return true;
  }
  const tokenMatch = path.match(/^\/v1\/model-tokens\/([^/]+)$/);
  if (tokenMatch && method === 'DELETE') {
    const who = await caller(request, context);
    await db.query(
      'UPDATE model_tokens SET revoked_at = NOW() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL',
      [decodeURIComponent(tokenMatch[1]), who.sub],
    );
    send(response, 200, { ok: true });
    return true;
  }
  return false;
}
