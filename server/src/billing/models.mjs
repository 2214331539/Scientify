// Official models and the upstream channels that serve them. Channel keys are
// stored encrypted and never leave the server; the admin pages see the last four
// characters.

import crypto from 'node:crypto';
import { typical } from './meter.mjs';

const uuid = () => crypto.randomUUID();

/** MODEL_KEY_SECRET when set; otherwise a key derived from the JWT secret. */
function cipherKey(config) {
  const secret = config.modelKeySecret || config.jwtSecret;
  if (!secret) throw new Error('No secret for channel keys');
  return Buffer.from(crypto.hkdfSync('sha256', secret, 'scientify', 'channel-keys', 32));
}

export function sealKey(config, plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', cipherKey(config), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

export function openKey(config, sealed) {
  const raw = Buffer.from(String(sealed), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', cipherKey(config), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

export const keyHint = (plain) => String(plain).slice(-4);

export function modelView(row) {
  return {
    id: row.id,
    name: row.name,
    tier: row.tier,
    upstream: row.upstream,
    channelId: row.channel_id,
    backupChannelId: row.backup_channel_id,
    costInput: Number(row.cost_input),
    costCached: Number(row.cost_cached),
    costOutput: Number(row.cost_output),
    priceInput: Number(row.price_input),
    priceCached: Number(row.price_cached),
    priceOutput: Number(row.price_output),
    plans: row.plans ?? [],
    active: row.active,
    isDefault: row.is_default,
    sort: Number(row.sort),
  };
}

export const channelView = (row) => ({
  id: row.id,
  name: row.name,
  endpoint: row.endpoint,
  chatEndpoint: row.chat_endpoint,
  keyHint: row.key_hint,
  active: row.active,
});

// Models change rarely and are read on every request, so they are cached briefly;
// admin edits clear the cache at once.
let cache = null;
export function forgetModels() {
  cache = null;
}

export async function catalog(db) {
  if (cache && cache.at > Date.now() - 30_000) return cache;
  const [models, channels] = await Promise.all([
    db.query('SELECT * FROM models ORDER BY sort, name'),
    db.query('SELECT * FROM channels ORDER BY name'),
  ]);
  cache = {
    at: Date.now(),
    models: models.rows.map(modelView),
    channels: new Map(channels.rows.map((row) => [row.id, row])),
  };
  return cache;
}

/** How much a typical request costs next to the default model, e.g. "2.7×". */
export function multiplier(model, models) {
  const base = models.find((item) => item.isDefault && item.active) ?? models.find((item) => item.active);
  const own = typical(model).sale;
  const reference = base ? typical(base).sale : 0;
  if (!reference || !own) return '1×';
  if (base.id === model.id) return '1×';
  return `${(own / reference).toFixed(1)}×`;
}

/** The plans' display names, for "专业版可用" hints. */
const PLAN_SHORT = { free: '免费版', pro: '专业版', team: '课题组版' };
export const availableTo = (model) =>
  model.plans.map((plan) => PLAN_SHORT[plan] ?? plan).join('、') || '暂不开放';

/**
 * The first time a server runs with channels in the database empty but the old
 * OFFICIAL_MODEL_* settings present, they become a channel and its models.
 * The models start unlisted, without prices: an administrator sets prices and
 * lists them, so nothing is ever served without being charged.
 */
export async function importFromEnvironment(db, config) {
  const official = config.officialModel ?? {};
  if (!official.endpoint || !official.apiKey) return false;
  const existing = await db.query('SELECT 1 FROM channels LIMIT 1');
  if (existing.rows[0]) return false;
  const channelId = uuid();
  await db.query(
    `INSERT INTO channels(id, name, endpoint, chat_endpoint, key_cipher, key_hint)
     VALUES ($1, '默认渠道', $2, $3, $4, $5)`,
    [channelId, official.endpoint, official.chatEndpoint || null, sealKey(config, official.apiKey), keyHint(official.apiKey)],
  );
  const listed = (official.models ?? [])
    .map((item) => (typeof item === 'string' ? { id: item } : item))
    .filter((item) => item && typeof item.id === 'string' && item.id.trim());
  if (official.defaultModel && !listed.some((item) => item.id === official.defaultModel))
    listed.unshift({ id: official.defaultModel });
  for (const [index, item] of listed.entries()) {
    await db.query(
      `INSERT INTO models(id, name, upstream, channel_id, plans, active, is_default, sort)
       VALUES ($1, $2, $1, $3, '{}', FALSE, $4, $5) ON CONFLICT (id) DO NOTHING`,
      [item.id.trim(), String(item.name || item.id).trim(), channelId, item.id === official.defaultModel, index],
    );
  }
  forgetModels();
  return true;
}
