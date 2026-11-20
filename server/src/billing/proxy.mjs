// The official model gateway: checks the plan, points and limits, relays the
// request to the model's channel, counts the tokens on the way back and takes
// the points. Nothing of what is asked or answered is stored.

import { body, fail } from '../http.mjs';
import { withTransaction } from '../db.mjs';
import { balance, ensureGrants } from './ledger.mjs';
import { currentPlan } from './plans.mjs';
import { catalog, availableTo, openKey } from './models.mjs';
import { acquire, effectiveLimits } from './limits.mjs';
import { charge, createMeter, promptChars } from './meter.mjs';
import { recordUsage, usedToday } from './account.mjs';

const KINDS = {
  '/v1/responses': 'responses',
  '/v1/models/responses': 'responses',
  '/v1/chat/completions': 'chat/completions',
  '/v1/translate/chat/completions': 'chat/completions',
};

// Full-text translation sends one short request per paragraph, several at a time, in the
// background. It gets its own allowance so it neither waits behind the plan's limit of a few
// requests at once nor takes those slots from the user's conversations. Points and the daily
// limit apply as usual.
export const TRANSLATION_LIMITS = { rpm: 600, concurrency: 8 };

export const isModelPath = (path) => path in KINDS;

export function upstreamUrl(channel, kind) {
  const endpoint = kind === 'chat/completions' ? channel.chat_endpoint || channel.endpoint : channel.endpoint;
  const url = new URL(endpoint);
  const base = url.pathname.replace(/\/(?:responses|chat\/completions)\/?$/, '').replace(/\/+$/, '');
  url.pathname = `${base}/${kind}`;
  return url;
}

/** Keeps a requested output length within the plan's cap; never adds one that was not asked for. */
function capOutput(input, kind, cap) {
  const next = { ...input };
  const keys = kind === 'responses' ? ['max_output_tokens'] : ['max_tokens', 'max_completion_tokens'];
  for (const key of keys) if (Number(next[key]) > cap) next[key] = cap;
  return next;
}

export async function proxyModel(request, response, { config, db }, path, who) {
  const kind = KINDS[path];
  const input = await body(request, config.officialModel?.maxBodyBytes ?? 4_194_304);
  const { models, channels } = await catalog(db);
  const wanted = String(input.model ?? '').trim();
  const model = wanted
    ? models.find((item) => item.id === wanted && item.active)
    : (models.find((item) => item.isDefault && item.active) ?? models.find((item) => item.active));
  if (!model)
    throw fail(404, wanted ? `官方模型“${wanted}”不存在或已下架。` : '还没有可用的官方模型。', 'model_not_found');
  const now = new Date();
  const userId = who.sub;
  const { plan } = await currentPlan(db, userId, now);
  if (!model.plans.includes(plan.id))
    throw fail(403, `${model.name} 只对${availableTo(model)}开放。`, 'model_not_in_plan');
  const limits = await effectiveLimits(db, userId, plan, now);
  const available = await withTransaction(db, async (client) => {
    await ensureGrants(client, userId, now);
    return balance(client, userId, now);
  });
  if (available <= 0) throw fail(402, '官方模型额度已用完。', 'quota_exhausted');
  if ((await usedToday(db, userId, now)) >= limits.dailyPoints)
    throw fail(429, `今天的用量已到单日上限 ${limits.dailyPoints} 点，明天 0 点恢复。`, 'daily_limit');
  const translating = path.startsWith('/v1/translate/');
  const release = translating
    ? acquire(`${userId}:translate`, TRANSLATION_LIMITS)
    : acquire(userId, limits);
  try {
    await relay({ request, response, config, db, kind, input, model, channels, plan, userId });
  } finally {
    release();
  }
}

async function relay({ response, config, db, kind, input, model, channels, plan, userId }) {
  let payload = capOutput({ ...input, model: model.upstream }, kind, plan.maxOutputTokens);
  if (kind === 'chat/completions' && payload.stream)
    payload = { ...payload, stream_options: { ...(payload.stream_options ?? {}), include_usage: true } };
  const attempts = [model.channelId, model.backupChannelId]
    .map((id) => id && channels.get(id))
    .filter((channel) => channel && channel.active);
  if (!attempts.length) throw fail(503, '这个模型暂时不可用，请换一个模型。', 'channel_unavailable');

  const started = Date.now();
  const abort = new AbortController();
  let gone = false;
  response.on('close', () => {
    if (!response.writableEnded) {
      gone = true;
      abort.abort();
    }
  });
  const record = (channel, tokens, status, httpStatus) => {
    const { points, costMicros } =
      status === 'error' ? { points: 0, costMicros: 0 } : charge(model, tokens);
    return recordUsage(db, {
      userId,
      modelId: model.id,
      modelName: model.name,
      channelId: channel?.id,
      tokens,
      points,
      costMicros,
      status,
      httpStatus,
      latencyMs: Date.now() - started,
    }).catch((error) => console.error('usage', error));
  };
  const zero = { input: 0, cached: 0, output: 0, reasoning: 0, estimated: false };

  let upstream;
  let channel;
  for (const [index, candidate] of attempts.entries()) {
    const last = index === attempts.length - 1;
    try {
      upstream = await fetch(upstreamUrl(candidate, kind), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${openKey(config, candidate.key_cipher)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: abort.signal,
      });
      channel = candidate;
      // A failing primary hands over to the backup before anything reached the user.
      if (upstream.status >= 500 && !last) {
        await record(candidate, zero, 'error', upstream.status);
        await upstream.body?.cancel().catch(() => {});
        continue;
      }
      break;
    } catch (error) {
      if (gone) return;
      await record(candidate, zero, 'error', null);
      if (last) throw fail(502, '模型服务连接失败，请稍后再试。', 'upstream_unreachable');
    }
  }

  response.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') ?? 'application/json',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const meter = createMeter();
  const decoder = new TextDecoder();
  let status = upstream.ok ? 'ok' : 'error';
  try {
    if (upstream.body)
      for await (const chunk of upstream.body) {
        if (upstream.ok) meter.push(decoder.decode(chunk, { stream: true }));
        response.write(chunk);
      }
  } catch {
    if (!gone) status = 'error';
  }
  if (gone) status = 'aborted';
  // A refused request is not charged; a stopped or broken one pays for what was produced.
  // The points are taken before the answer ends, so a balance read right after it is current.
  const tokens = upstream.ok ? meter.finish(promptChars(input)) : zero;
  await record(channel, tokens, upstream.ok ? (status === 'error' ? 'aborted' : status) : 'error', upstream.status);
  if (!response.writableEnded) response.end();
}
