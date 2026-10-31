import http from 'node:http';
import crypto from 'node:crypto';
import { readConfig, assertProductionConfig } from './config.mjs';
import { createDb, initDb, withTransaction } from './db.mjs';
import { hashSecret, signToken, verifyToken } from './jwt.mjs';
import { normalizePhone, sendVerificationCode } from './sms.mjs';
import { deleteObject, objectKey, signedDownloadUrl, signedUploadUrl } from './oss.mjs';

const json = (value) => JSON.stringify(value);
const now = () => new Date();
const uuid = () => crypto.randomUUID();

function send(response, status, value, headers = {}) {
  const body = Buffer.from(typeof value === 'string' ? value : json(value));
  response.writeHead(status, {
    'content-type':
      typeof value === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    ...headers,
  });
  response.end(body);
}

function cors(response) {
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-headers', 'authorization, content-type');
  response.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
}

async function body(request, limit = 10 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('请求体过大。'), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('请求体不是有效 JSON。'), { status: 400 });
  }
}

function bearer(request) {
  const header = request.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function authUser(request, config) {
  try {
    const payload = verifyToken(bearer(request), config.jwtSecret, config.jwtIssuer);
    if (payload.tokenType !== 'access') throw new Error('Not an access token');
    return payload;
  } catch {
    throw Object.assign(new Error('登录状态已失效。'), { status: 401 });
  }
}

async function member(db, projectId, userId) {
  const result = await db.query(
    'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2',
    [projectId, userId],
  );
  return result.rows[0]?.role ?? null;
}

function canWrite(role) {
  return role === 'owner' || role === 'editor';
}

async function requireMember(db, projectId, userId, write = false) {
  const role = await member(db, projectId, userId);
  if (!role || (write && !canWrite(role))) {
    throw Object.assign(new Error('没有该项目的访问权限。'), { status: 403 });
  }
  return role;
}

function phoneCode(config) {
  if (config.sms.developmentCode) return config.sms.developmentCode;
  return String(crypto.randomInt(100000, 1_000_000));
}

function issueTokens(config, user) {
  const accessToken = signToken(
    { sub: user.id, phone: user.phone, tokenType: 'access' },
    config.jwtSecret,
    config.accessTokenTtl,
    config.jwtIssuer,
  );
  const refreshToken = signToken(
    { sub: user.id, phone: user.phone, tokenType: 'refresh', nonce: uuid() },
    config.jwtSecret,
    config.refreshTokenTtl,
    config.jwtIssuer,
  );
  return { accessToken, refreshToken };
}

async function authenticateCode(db, config, phone, code) {
  const result = await db.query('SELECT * FROM auth_codes WHERE phone = $1', [phone]);
  const stored = result.rows[0];
  if (!stored || new Date(stored.expires_at).getTime() < Date.now()) {
    throw Object.assign(new Error('验证码已过期，请重新获取。'), { status: 400 });
  }
  if (stored.attempts >= 5) {
    throw Object.assign(new Error('验证码尝试次数过多，请重新获取。'), { status: 429 });
  }
  const valid = hashSecret(`${config.jwtSecret}:${phone}:${code}`) === stored.code_hash;
  if (!valid) {
    await db.query('UPDATE auth_codes SET attempts = attempts + 1 WHERE phone = $1', [phone]);
    throw Object.assign(new Error('验证码不正确。'), { status: 400 });
  }
  await db.query('DELETE FROM auth_codes WHERE phone = $1', [phone]);
}

async function login(db, config, phone, code) {
  await authenticateCode(db, config, phone, code);
  const existing = await db.query('SELECT id, phone FROM users WHERE phone = $1', [phone]);
  let user = existing.rows[0];
  if (!user) {
    const inserted = await db.query(
      `INSERT INTO users(id, phone) VALUES ($1, $2)
       ON CONFLICT (phone) DO NOTHING RETURNING id, phone`,
      [uuid(), phone],
    );
    user =
      inserted.rows[0] ??
      (await db.query('SELECT id, phone FROM users WHERE phone = $1', [phone])).rows[0];
    if (!user) throw Object.assign(new Error('账号创建失败，请重试。'), { status: 500 });
  }
  await withTransaction(db, async (client) => {
    await client.query(
      `INSERT INTO project_members(project_id, user_id, role)
       SELECT project_id, $1, role FROM project_invitations WHERE phone = $2
       ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [user.id, phone],
    );
    await client.query('DELETE FROM project_invitations WHERE phone = $1', [phone]);
  });
  const tokens = issueTokens(config, user);
  await db.query(
    "INSERT INTO refresh_tokens(id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, NOW() + ($4 * INTERVAL '1 second'))",
    [uuid(), user.id, hashSecret(tokens.refreshToken), config.refreshTokenTtl],
  );
  return { user, ...tokens };
}

function operationError(operationId, message, serverRevision = null) {
  return { operationId, message, serverRevision };
}

function modelEndpoint(endpoint, suffix) {
  const url = new URL(endpoint);
  const base = url.pathname
    .replace(/\/(?:responses|chat\/completions)\/?$/, '')
    .replace(/\/+$/, '');
  url.pathname = `${base}/${suffix}`;
  return url;
}

async function proxyOfficialModel(response, config, input, path) {
  const endpoint =
    path === '/v1/chat/completions'
      ? config.officialModel.chatEndpoint || config.officialModel.endpoint
      : config.officialModel.endpoint;
  if (!endpoint || !config.officialModel.apiKey) {
    throw Object.assign(new Error('官方模型服务尚未配置。'), { status: 503 });
  }
  const upstream = await fetch(
    modelEndpoint(endpoint, path.endsWith('responses') ? 'responses' : 'chat/completions'),
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.officialModel.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...input,
        model: String(input.model || config.officialModel.defaultModel || '').trim(),
      }),
    },
  );
  response.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') ?? 'application/json',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  if (upstream.body) {
    for await (const chunk of upstream.body) response.write(chunk);
  }
  response.end();
}

async function syncProject(db, projectId, userId, input) {
  const role = await requireMember(db, projectId, userId, false);
  const writable = canWrite(role);
  const operations = Array.isArray(input.operations) ? input.operations.slice(0, 500) : [];
  return withTransaction(db, async (client) => {
    const accepted = [];
    const conflicts = [];
    for (const operation of operations) {
      if (!operation || typeof operation !== 'object') continue;
      if (!writable) {
        conflicts.push(
          operationError(operation.operationId ?? '', '当前成员权限只能读取，不能提交协作变更。'),
        );
        continue;
      }
      const required = [
        'operationId',
        'clientId',
        'domain',
        'entityId',
        'baseRevision',
        'kind',
        'payload',
        'createdAt',
      ];
      if (required.some((key) => operation[key] === undefined)) {
        conflicts.push(operationError(operation.operationId ?? '', '协作变更格式无效。'));
        continue;
      }
      const duplicate = await client.query(
        'SELECT operation_id, server_revision FROM sync_operations WHERE operation_id = $1',
        [operation.operationId],
      );
      if (duplicate.rows[0]) {
        accepted.push({
          operationId: operation.operationId,
          serverRevision: duplicate.rows[0].server_revision,
        });
        continue;
      }
      const head = await client.query(
        'SELECT revision FROM entity_heads WHERE project_id = $1 AND domain = $2 AND entity_id = $3 FOR UPDATE',
        [projectId, operation.domain, operation.entityId],
      );
      const current = Number(head.rows[0]?.revision ?? 0);
      const base = Number(operation.baseRevision);
      if (!Number.isSafeInteger(base) || (base !== current && operation.kind !== 'create')) {
        conflicts.push(
          operationError(operation.operationId, '远程资源已发生变化，需要处理冲突。', current),
        );
        continue;
      }
      const next = current + 1;
      if (head.rows[0]) {
        await client.query(
          'UPDATE entity_heads SET revision = $4 WHERE project_id = $1 AND domain = $2 AND entity_id = $3',
          [projectId, operation.domain, operation.entityId, next],
        );
      } else {
        await client.query(
          'INSERT INTO entity_heads(project_id, domain, entity_id, revision) VALUES ($1, $2, $3, $4)',
          [projectId, operation.domain, operation.entityId, next],
        );
      }
      await client.query(
        `INSERT INTO sync_operations
          (operation_id, project_id, actor_id, client_id, domain, entity_id, base_revision, server_revision, kind, payload, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          operation.operationId,
          projectId,
          userId,
          operation.clientId,
          operation.domain,
          operation.entityId,
          base,
          next,
          operation.kind,
          operation.payload,
          operation.createdAt,
        ],
      );
      accepted.push({ operationId: operation.operationId, serverRevision: next });
    }
    const changeResult = await client.query(
      `SELECT operation_id AS "operationId", client_id AS "clientId", domain, entity_id AS "entityId",
              server_revision AS "serverRevision", kind, payload, created_at AS "createdAt", sequence
         FROM sync_operations WHERE project_id = $1 AND sequence > $2 ORDER BY sequence LIMIT 500`,
      [projectId, Number(input.cursor ?? 0) || 0],
    );
    const changes = changeResult.rows.map((change) => ({
      ...change,
      sequence: Number(change.sequence),
      serverRevision: Number(change.serverRevision),
    }));
    if (accepted.length)
      await client.query('UPDATE projects SET updated_at = NOW() WHERE id = $1', [projectId]);
    const nextCursor = changes.at(-1)?.sequence ?? (Number(input.cursor ?? 0) || 0);
    return { accepted, conflicts, changes, nextCursor };
  });
}

async function listChanges(db, projectId, userId, cursor) {
  await requireMember(db, projectId, userId);
  const result = await db.query(
    `SELECT operation_id AS "operationId", client_id AS "clientId", domain, entity_id AS "entityId",
            server_revision AS "serverRevision", kind, payload, created_at AS "createdAt", sequence
       FROM sync_operations WHERE project_id = $1 AND sequence > $2 ORDER BY sequence LIMIT 500`,
    [projectId, Number(cursor) || 0],
  );
  const changes = result.rows.map((change) => ({
    ...change,
    sequence: Number(change.sequence),
    serverRevision: Number(change.serverRevision),
  }));
  return { changes, nextCursor: changes.at(-1)?.sequence ?? (Number(cursor) || 0) };
}

async function projectBlob(db, projectId, blobId, userId) {
  const result = await db.query(
    'SELECT * FROM blobs WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL',
    [blobId, projectId],
  );
  if (!result.rows[0]) throw Object.assign(new Error('文件不存在。'), { status: 404 });
  await requireMember(db, projectId, userId, false);
  return result.rows[0];
}

async function handle(request, response, { config, db }) {
  cors(response);
  if (request.method === 'OPTIONS') return send(response, 204, '');
  const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  try {
    if (request.method === 'GET' && path === '/v1/health') {
      await db.query('SELECT 1');
      return send(response, 200, { ok: true, service: 'scientify-collaboration', database: 'ok' });
    }
    if (request.method === 'POST' && path === '/v1/auth/send-code') {
      const input = await body(request, 16_384);
      const phone = normalizePhone(input.phone);
      const existing = await db.query('SELECT last_sent_at FROM auth_codes WHERE phone = $1', [
        phone,
      ]);
      if (
        existing.rows[0] &&
        Date.now() - new Date(existing.rows[0].last_sent_at).getTime() < 60_000
      ) {
        throw Object.assign(new Error('验证码发送过于频繁，请稍后再试。'), { status: 429 });
      }
      const code = phoneCode(config);
      const hash = hashSecret(`${config.jwtSecret}:${phone}:${code}`);
      await db.query(
        `INSERT INTO auth_codes(phone, code_hash, expires_at, last_sent_at, attempts)
         VALUES ($1, $2, NOW() + INTERVAL '5 minutes', NOW(), 0)
         ON CONFLICT (phone) DO UPDATE SET code_hash = EXCLUDED.code_hash,
           expires_at = EXCLUDED.expires_at, last_sent_at = EXCLUDED.last_sent_at, attempts = 0`,
        [phone, hash],
      );
      await sendVerificationCode(config, phone, code);
      return send(response, 202, { accepted: true });
    }
    if (request.method === 'POST' && path === '/v1/auth/login') {
      const input = await body(request, 16_384);
      const result = await login(
        db,
        config,
        normalizePhone(input.phone),
        String(input.code ?? '').trim(),
      );
      return send(response, 200, result);
    }
    if (request.method === 'POST' && path === '/v1/auth/refresh') {
      const input = await body(request, 16_384);
      const payload = verifyToken(input.refreshToken, config.jwtSecret, config.jwtIssuer);
      if (payload.tokenType !== 'refresh')
        throw Object.assign(new Error('刷新令牌无效。'), { status: 401 });
      const result = await db.query(
        'SELECT u.id, u.phone FROM refresh_tokens r JOIN users u ON u.id = r.user_id WHERE r.token_hash = $1 AND r.expires_at > NOW()',
        [hashSecret(input.refreshToken)],
      );
      if (!result.rows[0]) throw Object.assign(new Error('刷新令牌已失效。'), { status: 401 });
      const tokens = issueTokens(config, result.rows[0]);
      await withTransaction(db, async (client) => {
        // Rotate refresh tokens. A replayed token is rejected after its first use.
        await client.query('DELETE FROM refresh_tokens WHERE token_hash = $1', [
          hashSecret(input.refreshToken),
        ]);
        await client.query(
          "INSERT INTO refresh_tokens(id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, NOW() + ($4 * INTERVAL '1 second'))",
          [uuid(), result.rows[0].id, hashSecret(tokens.refreshToken), config.refreshTokenTtl],
        );
      });
      return send(response, 200, { user: result.rows[0], ...tokens });
    }

    const user = authUser(request, config);
    if (request.method === 'GET' && path === '/v1/me') {
      return send(response, 200, { id: user.sub, phone: user.phone });
    }
    if (request.method === 'POST' && path === '/v1/auth/logout') {
      const input = await body(request, 16_384);
      if (input.refreshToken) {
        await db.query('DELETE FROM refresh_tokens WHERE token_hash = $1 AND user_id = $2', [
          hashSecret(input.refreshToken),
          user.sub,
        ]);
      }
      return send(response, 200, { ok: true });
    }
    if (request.method === 'GET' && path === '/v1/models') {
      return send(response, 200, {
        models: config.officialModel.models,
        defaultModel: config.officialModel.defaultModel,
      });
    }
    if (request.method === 'POST' && path === '/v1/projects') {
      const input = await body(request, 16_384);
      const name = String(input.name ?? '').trim();
      if (!name || name.length > 160)
        throw Object.assign(new Error('项目名称无效。'), { status: 400 });
      const timestamp = now().toISOString();
      const project = {
        id: uuid(),
        name,
        ownerId: user.sub,
        role: 'owner',
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await withTransaction(db, async (client) => {
        await client.query('INSERT INTO projects(id, name, owner_id) VALUES ($1, $2, $3)', [
          project.id,
          name,
          user.sub,
        ]);
        await client.query(
          "INSERT INTO project_members(project_id, user_id, role) VALUES ($1, $2, 'owner')",
          [project.id, user.sub],
        );
      });
      return send(response, 201, project);
    }
    if (request.method === 'GET' && path === '/v1/projects') {
      const result = await db.query(
        `SELECT p.id, p.name, p.owner_id AS "ownerId", p.created_at AS "createdAt", p.updated_at AS "updatedAt", m.role
           FROM projects p JOIN project_members m ON m.project_id = p.id
          WHERE m.user_id = $1 ORDER BY p.updated_at DESC`,
        [user.sub],
      );
      return send(response, 200, { projects: result.rows });
    }
    const projectMatch = path.match(/^\/v1\/projects\/([^/]+)(?:\/(.*))?$/);
    if (projectMatch) {
      const projectId = projectMatch[1];
      const suffix = projectMatch[2] ?? '';
      if (request.method === 'GET' && suffix === 'members') {
        await requireMember(db, projectId, user.sub);
        const result = await db.query(
          `SELECT u.id, u.phone, m.role, m.created_at AS "createdAt", FALSE AS pending
             FROM project_members m JOIN users u ON u.id = m.user_id
            WHERE m.project_id = $1
            UNION ALL
           SELECT 'invite:' || i.phone, i.phone, i.role, i.created_at AS "createdAt", TRUE AS pending
             FROM project_invitations i
            WHERE i.project_id = $1
            ORDER BY "createdAt"`,
          [projectId],
        );
        return send(response, 200, { members: result.rows });
      }
      if (request.method === 'POST' && suffix === 'members') {
        await requireMember(db, projectId, user.sub, true);
        const currentRole = await member(db, projectId, user.sub);
        if (currentRole !== 'owner')
          throw Object.assign(new Error('只有项目所有者可以管理成员。'), { status: 403 });
        const input = await body(request, 16_384);
        const phone = normalizePhone(input.phone);
        const role = ['editor', 'reviewer', 'viewer'].includes(input.role) ? input.role : 'viewer';
        const target = await db.query('SELECT id FROM users WHERE phone = $1', [phone]);
        if (target.rows[0]?.id === user.sub) {
          throw Object.assign(new Error('你已经是该项目成员。'), { status: 409 });
        }
        if (target.rows[0]) {
          await db.query(
            `INSERT INTO project_members(project_id, user_id, role) VALUES ($1, $2, $3)
             ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
            [projectId, target.rows[0].id, role],
          );
          await db.query('DELETE FROM project_invitations WHERE project_id = $1 AND phone = $2', [
            projectId,
            phone,
          ]);
          return send(response, 200, { ok: true, pending: false });
        }
        await db.query(
          `INSERT INTO project_invitations(project_id, phone, role, invited_by)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (project_id, phone) DO UPDATE SET role = EXCLUDED.role,
             invited_by = EXCLUDED.invited_by, created_at = NOW()`,
          [projectId, phone, role, user.sub],
        );
        return send(response, 200, { ok: true, pending: true });
      }
      if (request.method === 'GET' && suffix === 'sync') {
        return send(
          response,
          200,
          await listChanges(db, projectId, user.sub, url.searchParams.get('cursor')),
        );
      }
      if (request.method === 'POST' && suffix === 'sync') {
        return send(response, 200, await syncProject(db, projectId, user.sub, await body(request)));
      }
      if (request.method === 'POST' && suffix === 'blobs/presign-upload') {
        await requireMember(db, projectId, user.sub, true);
        const input = await body(request, 16_384);
        const sha256 = String(input.sha256 ?? '').toLowerCase();
        const size = Number(input.size);
        const contentType = String(input.contentType ?? 'application/octet-stream').slice(0, 160);
        if (
          !/^[a-f0-9]{64}$/.test(sha256) ||
          !Number.isSafeInteger(size) ||
          size < 0 ||
          size > 200 * 1024 * 1024
        ) {
          throw Object.assign(new Error('文件摘要或大小无效。'), { status: 400 });
        }
        const existing = await db.query(
          `SELECT id, object_key AS "objectKey", size_bytes AS "size", content_type AS "contentType"
             FROM blobs WHERE project_id = $1 AND sha256 = $2 AND status = 'complete' AND deleted_at IS NULL LIMIT 1`,
          [projectId, sha256],
        );
        if (existing.rows[0]) {
          return send(response, 200, {
            existing: true,
            blob: existing.rows[0],
            downloadUrl: signedDownloadUrl(config, existing.rows[0].objectKey),
          });
        }
        const id = uuid();
        const key = objectKey(projectId, sha256);
        await db.query(
          `INSERT INTO blobs(id, project_id, object_key, sha256, size_bytes, content_type, status, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
           ON CONFLICT (object_key) DO UPDATE SET size_bytes = EXCLUDED.size_bytes, content_type = EXCLUDED.content_type`,
          [id, projectId, key, sha256, size, contentType, user.sub],
        );
        return send(response, 200, {
          existing: false,
          blob: { id, objectKey: key },
          uploadUrl: signedUploadUrl(config, key, contentType),
        });
      }
    }
    const blobMatch = path.match(/^\/v1\/blobs\/([^/]+)(?:\/(.*))?$/);
    if (blobMatch) {
      const blobId = blobMatch[1];
      const suffix = blobMatch[2] ?? '';
      const found = await db.query('SELECT project_id FROM blobs WHERE id = $1', [blobId]);
      if (!found.rows[0]) throw Object.assign(new Error('文件不存在。'), { status: 404 });
      const blob = await projectBlob(db, found.rows[0].project_id, blobId, user.sub);
      if (request.method === 'POST' && suffix === 'complete') {
        if (blob.status !== 'pending') return send(response, 200, { ok: true });
        await db.query("UPDATE blobs SET status = 'complete' WHERE id = $1", [blobId]);
        return send(response, 200, { ok: true, blob: { id: blob.id, objectKey: blob.object_key } });
      }
      if (request.method === 'GET' && !suffix) {
        if (blob.status !== 'complete')
          throw Object.assign(new Error('文件尚未上传完成。'), { status: 409 });
        return send(response, 200, { downloadUrl: signedDownloadUrl(config, blob.object_key) });
      }
      if (request.method === 'DELETE' && !suffix) {
        await deleteObject(config, blob.object_key);
        await db.query("UPDATE blobs SET status = 'deleted', deleted_at = NOW() WHERE id = $1", [
          blobId,
        ]);
        return send(response, 200, { ok: true });
      }
    }
    if (
      request.method === 'POST' &&
      ['/v1/models/responses', '/v1/responses', '/v1/chat/completions'].includes(path)
    ) {
      const input = await body(request, config.officialModel.maxBodyBytes);
      const model = String(input.model || config.officialModel.defaultModel || '').trim();
      if (!model) throw Object.assign(new Error('未选择官方模型。'), { status: 400 });
      return proxyOfficialModel(
        response,
        config,
        { ...input, model },
        path === '/v1/models/responses' ? '/v1/responses' : path,
      );
    }
    return send(response, 404, { error: 'not_found' });
  } catch (error) {
    const status = Number(error?.status) || (error?.code === '23505' ? 409 : 500);
    if (status >= 500) console.error(error);
    return send(response, status, { error: error?.message ?? '服务器内部错误。' });
  }
}

export function createServer(config, db) {
  return http.createServer((request, response) => {
    handle(request, response, { config, db });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = readConfig();
  if (process.env.NODE_ENV === 'production') assertProductionConfig(config);
  const db = createDb(config);
  await initDb(db);
  const server = createServer(config, db);
  server.listen(config.port, config.host, () => {
    console.log(`Scientify collaboration server listening on ${config.host}:${config.port}`);
  });
  const close = async () => {
    server.close();
    await db.end();
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
}
