import http from 'node:http';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import { readConfig, assertProductionConfig } from './config.mjs';
import { createDb, initDb, withTransaction } from './db.mjs';
import { hashSecret, signToken, verifyToken } from './jwt.mjs';
import { normalizePhone } from './sms.mjs';
import { deleteObject, objectKey, signedDownloadUrl, signedUploadUrl } from './oss.mjs';
import { pullEntities, pushEntities } from './sync.mjs';
import { body, clientAddress, send } from './http.mjs';
import { caller, requireActive } from './auth.mjs';
import {
  authenticateCode,
  checkPassword,
  clearPasswordFailures,
  guardPassword,
  hashPassword,
  notePasswordFailure,
  passwordMatches,
  sendCode,
} from './signin.mjs';
import { handleBilling } from './billing/routes.mjs';
import { importFromEnvironment } from './billing/models.mjs';
import { handleAdmin } from './admin/routes.mjs';
import { startJobs } from './jobs.mjs';
import { clientPolicy, requireSupportedClient } from './client-policy.mjs';
import { recordError } from './errors.mjs';

const now = () => new Date();
const uuid = () => crypto.randomUUID();

function cors(response) {
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-headers', 'authorization, content-type');
  response.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
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

async function findOrCreateUser(db, phone) {
  const existing = await db.query('SELECT id, phone FROM users WHERE phone = $1', [phone]);
  if (existing.rows[0]) return existing.rows[0];
  const inserted = await db.query(
    `INSERT INTO users(id, phone) VALUES ($1, $2)
     ON CONFLICT (phone) DO NOTHING RETURNING id, phone`,
    [uuid(), phone],
  );
  const user =
    inserted.rows[0] ??
    (await db.query('SELECT id, phone FROM users WHERE phone = $1', [phone])).rows[0];
  if (!user) throw Object.assign(new Error('账号创建失败，请重试。'), { status: 500 });
  return user;
}

async function login(db, config, phone, code) {
  await authenticateCode(db, config, phone, code);
  return startSession(db, config, await findOrCreateUser(db, phone));
}

async function passwordLogin(db, config, phone, password) {
  guardPassword(phone);
  const result = await db.query('SELECT id, phone, password_hash FROM users WHERE phone = $1', [phone]);
  const user = result.rows[0];
  if (user && !user.password_hash)
    throw Object.assign(new Error('这个账号还没有设置密码，请用验证码登录。'), { status: 400 });
  if (!user || !passwordMatches(String(password ?? ''), user.password_hash)) {
    notePasswordFailure(phone);
    throw Object.assign(new Error('手机号或密码不正确。'), { status: 400 });
  }
  clearPasswordFailures(phone);
  return startSession(db, config, { id: user.id, phone: user.phone });
}

/** Creates an account with a password; a number that only signed in by SMS gets its password. */
async function register(db, config, phone, code, password) {
  const secret = hashPassword(checkPassword(password));
  await authenticateCode(db, config, phone, code);
  const existing = await db.query('SELECT password_hash FROM users WHERE phone = $1', [phone]);
  if (existing.rows[0]?.password_hash)
    throw Object.assign(new Error('这个手机号已经注册，请直接登录。'), { status: 409 });
  const user = await findOrCreateUser(db, phone);
  await db.query('UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1', [
    user.id,
    secret,
  ]);
  return startSession(db, config, user);
}

/** A new password signs out every other device. */
async function resetPassword(db, config, phone, code, password) {
  const secret = hashPassword(checkPassword(password));
  await authenticateCode(db, config, phone, code);
  const result = await db.query('SELECT id, phone FROM users WHERE phone = $1', [phone]);
  const user = result.rows[0];
  if (!user) throw Object.assign(new Error('这个手机号还没有注册。'), { status: 404 });
  await withTransaction(db, async (client) => {
    await client.query('UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1', [
      user.id,
      secret,
    ]);
    await client.query('DELETE FROM refresh_tokens WHERE user_id = $1', [user.id]);
  });
  clearPasswordFailures(phone);
  return startSession(db, config, user);
}

/** Joins pending invitations and issues tokens for a signed-in user. */
async function startSession(db, config, user) {
  const phone = user.phone;
  await requireActive(db, user.id);
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

async function projectBlob(db, projectId, blobId, userId) {
  const result = await db.query(
    'SELECT * FROM blobs WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL',
    [blobId, projectId],
  );
  if (!result.rows[0]) throw Object.assign(new Error('文件不存在。'), { status: 404 });
  await requireMember(db, projectId, userId, false);
  return result.rows[0];
}

async function handle(request, response, context) {
  const { config, db } = context;
  const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  // The admin pages are same-origin only: no CORS headers for them. They need the
  // raw path, where "/admin" and "/admin/" differ.
  if (url.pathname === '/admin' || url.pathname.startsWith('/admin/'))
    return handleAdmin(request, response, context, url.pathname, url);
  cors(response);
  if (request.method === 'OPTIONS') return send(response, 204, '');
  try {
    if (request.method === 'GET' && path === '/v1/health') {
      await db.query('SELECT 1');
      return send(response, 200, { ok: true, service: 'scientify-collaboration', database: 'ok' });
    }
    if (request.method === 'GET' && path === '/v1/client-policy')
      return send(response, 200, clientPolicy(config));
    // Before the version check: an outdated app's errors still help.
    if (request.method === 'POST' && path === '/v1/errors') {
      const input = await body(request, 32_768);
      await recordError(db, config, request, clientAddress(request, config), input);
      return send(response, 202, { accepted: true });
    }
    requireSupportedClient(request, config);
    if (request.method === 'POST' && path === '/v1/auth/send-code') {
      const input = await body(request, 16_384);
      await sendCode(db, config, normalizePhone(input.phone), clientAddress(request, config));
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
    if (request.method === 'POST' && path === '/v1/auth/password-login') {
      const input = await body(request, 16_384);
      return send(
        response,
        200,
        await passwordLogin(db, config, normalizePhone(input.phone), input.password),
      );
    }
    if (request.method === 'POST' && path === '/v1/auth/register') {
      const input = await body(request, 16_384);
      const phone = normalizePhone(input.phone);
      return send(
        response,
        200,
        await register(db, config, phone, String(input.code ?? '').trim(), input.password),
      );
    }
    if (request.method === 'POST' && path === '/v1/auth/reset-password') {
      const input = await body(request, 16_384);
      const phone = normalizePhone(input.phone);
      return send(
        response,
        200,
        await resetPassword(db, config, phone, String(input.code ?? '').trim(), input.password),
      );
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
      await requireActive(db, result.rows[0].id);
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

    if (await handleBilling(request, response, context, path, url)) return;

    const user = await caller(request, context);
    if (request.method === 'GET' && path === '/v1/me') {
      const result = await db.query('SELECT password_hash FROM users WHERE id = $1', [user.sub]);
      return send(response, 200, {
        id: user.sub,
        phone: user.phone,
        hasPassword: !!result.rows[0]?.password_hash,
      });
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
    if (request.method === 'POST' && path === '/v1/projects') {
      const input = await body(request, 16_384);
      const name = String(input.name ?? '').trim();
      if (!name || name.length > 160)
        throw Object.assign(new Error('项目名称无效。'), { status: 400 });
      // Publishing a local project keeps its id so its files and records stay linked.
      const id = input.id === undefined ? uuid() : String(input.id);
      if (!/^[A-Za-z0-9_-]{8,80}$/.test(id))
        throw Object.assign(new Error('项目标识无效。'), { status: 400 });
      const taken = await db.query('SELECT owner_id FROM projects WHERE id = $1', [id]);
      if (taken.rows[0]) {
        if (taken.rows[0].owner_id !== user.sub)
          throw Object.assign(new Error('项目标识已被使用。'), { status: 409 });
        const mine = await db.query(
          `SELECT id, name, owner_id AS "ownerId", created_at AS "createdAt", updated_at AS "updatedAt",
                  change_seq AS "changeSeq", 'owner' AS role FROM projects WHERE id = $1`,
          [id],
        );
        return send(response, 200, { ...mine.rows[0], changeSeq: Number(mine.rows[0].changeSeq) });
      }
      const timestamp = now().toISOString();
      const project = {
        id,
        name,
        ownerId: user.sub,
        role: 'owner',
        createdAt: timestamp,
        updatedAt: timestamp,
        changeSeq: 0,
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
        `SELECT p.id, p.name, p.owner_id AS "ownerId", p.created_at AS "createdAt", p.updated_at AS "updatedAt",
                p.change_seq AS "changeSeq", m.role
           FROM projects p JOIN project_members m ON m.project_id = p.id
          WHERE m.user_id = $1 ORDER BY p.updated_at DESC`,
        [user.sub],
      );
      return send(response, 200, {
        projects: result.rows.map((row) => ({ ...row, changeSeq: Number(row.changeSeq) })),
      });
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
      if (request.method === 'DELETE' && suffix.startsWith('members/')) {
        const role = await requireMember(db, projectId, user.sub);
        const target = decodeURIComponent(suffix.slice('members/'.length));
        if (target === user.sub) {
          if (role === 'owner')
            throw Object.assign(new Error('项目所有者不能退出项目。'), { status: 409 });
        } else if (role !== 'owner') {
          throw Object.assign(new Error('只有项目所有者可以管理成员。'), { status: 403 });
        }
        if (target.startsWith('invite:')) {
          await db.query('DELETE FROM project_invitations WHERE project_id = $1 AND phone = $2', [
            projectId,
            target.slice('invite:'.length),
          ]);
        } else {
          await db.query(
            "DELETE FROM project_members WHERE project_id = $1 AND user_id = $2 AND role <> 'owner'",
            [projectId, target],
          );
        }
        return send(response, 200, { ok: true });
      }
      if (request.method === 'GET' && suffix === 'entities') {
        await requireMember(db, projectId, user.sub);
        return send(
          response,
          200,
          await pullEntities(
            db,
            projectId,
            Number(url.searchParams.get('since') ?? 0),
            Number(url.searchParams.get('limit') ?? 500),
          ),
        );
      }
      if (request.method === 'POST' && suffix === 'entities') {
        const role = await requireMember(db, projectId, user.sub);
        const input = await body(request, 8 * 1024 * 1024);
        return send(
          response,
          200,
          await withTransaction(db, (client) =>
            pushEntities(client, projectId, user.sub, role, input),
          ),
        );
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
        const key = objectKey(projectId, sha256);
        // An interrupted or deleted upload of the same content keeps its row id.
        const row = await db.query(
          `INSERT INTO blobs(id, project_id, object_key, sha256, size_bytes, content_type, status, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
           ON CONFLICT (object_key) DO UPDATE SET size_bytes = EXCLUDED.size_bytes,
             content_type = EXCLUDED.content_type, status = 'pending', deleted_at = NULL
           RETURNING id`,
          [uuid(), projectId, key, sha256, size, contentType, user.sub],
        );
        return send(response, 200, {
          existing: false,
          blob: { id: row.rows[0].id, objectKey: key },
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
        await requireMember(db, found.rows[0].project_id, user.sub, true);
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
        const role = await member(db, found.rows[0].project_id, user.sub);
        if (role !== 'owner')
          throw Object.assign(new Error('只有项目所有者可以删除云端文件。'), { status: 403 });
        const used = await db.query(
          'SELECT 1 FROM sync_entities WHERE blob_id = $1 AND NOT deleted LIMIT 1',
          [blobId],
        );
        if (used.rows[0])
          throw Object.assign(new Error('文件仍在同步中使用，不能删除。'), { status: 409 });
        await deleteObject(config, blob.object_key);
        await db.query("UPDATE blobs SET status = 'deleted', deleted_at = NOW() WHERE id = $1", [
          blobId,
        ]);
        return send(response, 200, { ok: true });
      }
    }
    return send(response, 404, { error: 'not_found' });
  } catch (error) {
    return sendError(response, error);
  }
}

/** Turns a thrown error into a JSON answer; `code` is set for errors the app tells apart. */
export function sendError(response, error) {
  const status = Number(error?.status) || (error?.code === '23505' ? 409 : 500);
  if (status >= 500) console.error(error);
  if (response.headersSent) return response.end();
  const code = typeof error?.code === 'string' && /^[a-z_]+$/.test(error.code) ? error.code : undefined;
  return send(response, status, { error: error?.message ?? '服务器内部错误。', ...(code ? { code } : {}) });
}

export function createServer(config, db) {
  return http.createServer((request, response) => {
    handle(request, response, { config, db });
  });
}

// Run when started directly (node src/server.mjs); tests import createServer instead.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = readConfig();
  if (config.production) assertProductionConfig(config);
  const db = createDb(config);
  await initDb(db);
  if (await importFromEnvironment(db, config))
    console.log('Imported the OFFICIAL_MODEL_* settings as a channel; set prices in /admin to list its models.');
  const stopJobs = startJobs(db);
  const server = createServer(config, db);
  server.listen(config.port, config.host, () => {
    console.log(`Scientify collaboration server listening on ${config.host}:${config.port}`);
  });
  const close = async () => {
    stopJobs();
    server.close();
    await db.end();
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
}
