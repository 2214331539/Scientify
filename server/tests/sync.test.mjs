import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createDb, initDb } from '../src/db.mjs';
import { signToken } from '../src/jwt.mjs';
import { createServer } from '../src/server.mjs';

// Runs against a throwaway PostgreSQL database; its public schema is recreated.
const databaseUrl = process.env.TEST_DATABASE_URL;
const options = { skip: databaseUrl ? false : 'set TEST_DATABASE_URL to run the sync API tests' };

const config = {
  host: '127.0.0.1',
  port: 0,
  trustProxy: false,
  databaseUrl,
  jwtSecret: 'x'.repeat(40),
  jwtIssuer: 'test',
  accessTokenTtl: 900,
  refreshTokenTtl: 3600,
  oss: {
    endpoint: 'oss-cn-hangzhou.aliyuncs.com',
    region: 'cn-hangzhou',
    bucket: 'test-bucket',
    accessKeyId: 'key',
    accessKeySecret: 'secret',
    urlTtl: 900,
  },
  sms: { dryRun: true, developmentCode: '123456' },
  officialModel: { models: [], maxBodyBytes: 4_194_304 },
};

const users = {
  owner: { id: 'user-owner', phone: '13800000001' },
  editor: { id: 'user-editor', phone: '13800000002' },
  reviewer: { id: 'user-reviewer', phone: '13800000003' },
  viewer: { id: 'user-viewer', phone: '13800000004' },
  outsider: { id: 'user-outsider', phone: '13800000005' },
};
const token = (user) =>
  signToken({ sub: user.id, phone: user.phone, tokenType: 'access' }, config.jwtSecret, 900, 'test');
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');

let db;
let server;
let base;

async function api(user, method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token(user)}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

const record = (path, content, baseRevision = 0, domain = 'record') => ({
  domain,
  path,
  baseRevision,
  hash: sha(JSON.stringify(content)),
  content,
});

async function project(id) {
  const created = await api(users.owner, 'POST', '/v1/projects', { id, name: `Project ${id}` });
  assert.equal(created.status, 201);
  for (const role of ['editor', 'reviewer', 'viewer']) {
    await db.query("INSERT INTO project_members(project_id, user_id, role) VALUES ($1, $2, $3)", [
      id,
      users[role].id,
      role,
    ]);
  }
  return id;
}

async function blob(projectId, content) {
  const id = crypto.randomUUID();
  const hash = sha(content);
  await db.query(
    `INSERT INTO blobs(id, project_id, object_key, sha256, size_bytes, content_type, status, created_by)
     VALUES ($1, $2, $3, $4, $5, 'application/pdf', 'complete', $6)`,
    [id, projectId, `projects/${projectId}/blobs/${hash}`, hash, content.length, users.owner.id],
  );
  return { id, hash, size: content.length };
}

before(async () => {
  if (!databaseUrl) return;
  db = createDb(config);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await initDb(db);
  for (const user of Object.values(users)) {
    await db.query('INSERT INTO users(id, phone) VALUES ($1, $2)', [user.id, user.phone]);
  }
  server = createServer(config, db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (!databaseUrl) return;
  await new Promise((resolve) => server.close(resolve));
  await db.end();
});

test('a project published with its local id keeps it and repeats idempotently', options, async () => {
  const id = 'local-project-0001';
  assert.equal((await api(users.owner, 'POST', '/v1/projects', { id, name: 'Local' })).status, 201);
  const again = await api(users.owner, 'POST', '/v1/projects', { id, name: 'Local' });
  assert.equal(again.status, 200);
  assert.equal(again.body.id, id);
  assert.equal((await api(users.outsider, 'POST', '/v1/projects', { id, name: 'Mine' })).status, 409);
  assert.equal((await api(users.owner, 'POST', '/v1/projects', { id: '../x', name: 'Bad' })).status, 400);
});

test('pushes version each entity and a pull from zero returns the current state', options, async () => {
  const id = await project('project-state-01');
  const file = await blob(id, 'pdf bytes');
  const pushed = await api(users.owner, 'POST', `/v1/projects/${id}/entities`, {
    deviceId: 'device-a',
    changes: [
      record('note-1', { title: 'First', body: 'hello' }),
      { domain: 'library', path: 'papers/a.pdf', baseRevision: 0, hash: file.hash, size: file.size, blobId: file.id },
    ],
  });
  assert.equal(pushed.status, 200);
  assert.deepEqual(
    pushed.body.accepted.map((change) => [change.path, change.revision, change.changeSeq]),
    [
      ['note-1', 1, 1],
      ['papers/a.pdf', 1, 2],
    ],
  );
  const update = await api(users.editor, 'POST', `/v1/projects/${id}/entities`, {
    deviceId: 'device-b',
    changes: [record('note-1', { title: 'First', body: 'hello again' }, 1)],
  });
  assert.equal(update.body.accepted[0].revision, 2);

  const pulled = await api(users.viewer, 'GET', `/v1/projects/${id}/entities?since=0`);
  assert.equal(pulled.status, 200);
  assert.equal(pulled.body.changeSeq, 3);
  assert.equal(pulled.body.hasMore, false);
  const byPath = Object.fromEntries(pulled.body.entities.map((entity) => [entity.path, entity]));
  assert.equal(byPath['note-1'].revision, 2);
  assert.equal(byPath['note-1'].content.body, 'hello again');
  assert.equal(byPath['note-1'].deviceId, 'device-b');
  assert.equal(byPath['papers/a.pdf'].blobId, file.id);
  assert.equal(pulled.body.nextSince, 3);
  const later = await api(users.viewer, 'GET', `/v1/projects/${id}/entities?since=3`);
  assert.deepEqual(later.body.entities, []);
  const history = await db.query(
    "SELECT revision FROM sync_entity_versions WHERE project_id = $1 AND path = 'note-1'",
    [id],
  );
  assert.deepEqual(history.rows.map((row) => Number(row.revision)), [1]);
});

test('a stale base revision is refused and a retried push lands once', options, async () => {
  const id = await project('project-stale-01');
  const first = record('note-1', { body: 'one' });
  await api(users.owner, 'POST', `/v1/projects/${id}/entities`, { deviceId: 'a', changes: [first] });
  await api(users.owner, 'POST', `/v1/projects/${id}/entities`, {
    deviceId: 'b',
    changes: [record('note-1', { body: 'two' }, 1)],
  });
  const stale = await api(users.owner, 'POST', `/v1/projects/${id}/entities`, {
    deviceId: 'a',
    changes: [record('note-1', { body: 'three' }, 1)],
  });
  assert.deepEqual(stale.body.accepted, []);
  assert.equal(stale.body.rejected[0].conflict, true);
  assert.equal(stale.body.rejected[0].serverRevision, 2);
  const retried = await api(users.owner, 'POST', `/v1/projects/${id}/entities`, {
    deviceId: 'b',
    changes: [record('note-1', { body: 'two' }, 1)],
  });
  assert.equal(retried.body.accepted[0].revision, 2);
  assert.equal(retried.body.changeSeq, 2);
});

test('deletions travel as tombstones', options, async () => {
  const id = await project('project-delete-1');
  await api(users.owner, 'POST', `/v1/projects/${id}/entities`, {
    deviceId: 'a',
    changes: [record('note-1', { body: 'x' })],
  });
  const removed = await api(users.owner, 'POST', `/v1/projects/${id}/entities`, {
    deviceId: 'a',
    changes: [{ domain: 'record', path: 'note-1', baseRevision: 1, deleted: true }],
  });
  assert.equal(removed.body.accepted[0].revision, 2);
  const pulled = await api(users.owner, 'GET', `/v1/projects/${id}/entities?since=1`);
  assert.equal(pulled.body.entities[0].deleted, true);
  assert.equal(pulled.body.entities[0].content, null);
  const never = await api(users.owner, 'POST', `/v1/projects/${id}/entities`, {
    deviceId: 'a',
    changes: [{ domain: 'record', path: 'note-2', baseRevision: 0, deleted: true }],
  });
  assert.equal(never.body.accepted[0].revision, 0);
});

test('roles decide which parts of a project a member may change', options, async () => {
  const id = await project('project-roles-01');
  const file = await blob(id, 'code');
  const code = { domain: 'code', path: 'main.py', baseRevision: 0, hash: file.hash, size: file.size, blobId: file.id };
  const reviewer = await api(users.reviewer, 'POST', `/v1/projects/${id}/entities`, {
    deviceId: 'r',
    changes: [record('note-1', { body: 'review' }), code],
  });
  assert.deepEqual(reviewer.body.accepted.map((change) => change.path), ['note-1']);
  assert.match(reviewer.body.rejected[0].message, /权限/);
  const viewer = await api(users.viewer, 'POST', `/v1/projects/${id}/entities`, {
    deviceId: 'v',
    changes: [record('note-2', { body: 'no' })],
  });
  assert.equal(viewer.body.accepted.length, 0);
  const outsider = await api(users.outsider, 'GET', `/v1/projects/${id}/entities?since=0`);
  assert.equal(outsider.status, 403);
});

test('a file change needs a completed upload with the same content', options, async () => {
  const id = await project('project-files-1');
  const file = await blob(id, 'pdf');
  await db.query("UPDATE blobs SET status = 'pending' WHERE id = $1", [file.id]);
  const pending = await api(users.owner, 'POST', `/v1/projects/${id}/entities`, {
    deviceId: 'a',
    changes: [{ domain: 'library', path: 'a.pdf', baseRevision: 0, hash: file.hash, size: 3, blobId: file.id }],
  });
  assert.match(pending.body.rejected[0].message, /尚未上传/);
  await db.query("UPDATE blobs SET status = 'complete' WHERE id = $1", [file.id]);
  const mismatched = await api(users.owner, 'POST', `/v1/projects/${id}/entities`, {
    deviceId: 'a',
    changes: [{ domain: 'library', path: 'a.pdf', baseRevision: 0, hash: sha('other'), size: 3, blobId: file.id }],
  });
  assert.equal(mismatched.body.accepted.length, 0);
});

test('paths that leave the project folder are refused', options, async () => {
  const id = await project('project-paths-1');
  const file = await blob(id, 'x');
  const change = (path) => ({ domain: 'code', path, baseRevision: 0, hash: file.hash, size: 1, blobId: file.id });
  const result = await api(users.owner, 'POST', `/v1/projects/${id}/entities`, {
    deviceId: 'a',
    changes: ['../escape.py', '/abs.py', 'a\\b.py', 'a//b.py', 'ok/fine.py'].map(change),
  });
  assert.deepEqual(result.body.accepted.map((accepted) => accepted.path), ['ok/fine.py']);
  assert.equal(result.body.rejected.length, 4);
});

test('the project meta record renames the project', options, async () => {
  const id = await project('project-rename-1');
  await api(users.editor, 'POST', `/v1/projects/${id}/entities`, {
    deviceId: 'a',
    changes: [record('meta', { name: 'Renamed', question: 'Why?' }, 0, 'project')],
  });
  const listed = await api(users.viewer, 'GET', '/v1/projects');
  const found = listed.body.projects.find((item) => item.id === id);
  assert.equal(found.name, 'Renamed');
  assert.equal(found.changeSeq, 1);
});

test('concurrent pushes receive distinct change numbers in commit order', options, async () => {
  const id = await project('project-concurrent');
  await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      api(users.owner, 'POST', `/v1/projects/${id}/entities`, {
        deviceId: `device-${index % 3}`,
        changes: [record(`note-${index}`, { body: String(index) })],
      }),
    ),
  );
  const pulled = await api(users.owner, 'GET', `/v1/projects/${id}/entities?since=0`);
  assert.deepEqual(
    pulled.body.entities.map((entity) => entity.changeSeq),
    Array.from({ length: 12 }, (_, index) => index + 1),
  );
});

test('re-signing an unfinished upload keeps its blob id', options, async () => {
  const id = await project('project-upload-1');
  const request = { sha256: sha('bytes'), size: 5, contentType: 'application/pdf' };
  const first = await api(users.owner, 'POST', `/v1/projects/${id}/blobs/presign-upload`, request);
  const second = await api(users.owner, 'POST', `/v1/projects/${id}/blobs/presign-upload`, request);
  assert.equal(first.body.blob.id, second.body.blob.id);
  assert.match(first.body.uploadUrl, /x-oss-signature-version=OSS4-HMAC-SHA256/);
  const viewerComplete = await api(users.viewer, 'POST', `/v1/blobs/${first.body.blob.id}/complete`);
  assert.equal(viewerComplete.status, 403);
  assert.equal((await api(users.editor, 'POST', `/v1/blobs/${first.body.blob.id}/complete`)).status, 200);
});

test('owners remove members and members may leave', options, async () => {
  const id = await project('project-members');
  assert.equal(
    (await api(users.editor, 'DELETE', `/v1/projects/${id}/members/${users.viewer.id}`)).status,
    403,
  );
  assert.equal(
    (await api(users.owner, 'DELETE', `/v1/projects/${id}/members/${users.viewer.id}`)).status,
    200,
  );
  assert.equal(
    (await api(users.reviewer, 'DELETE', `/v1/projects/${id}/members/${users.reviewer.id}`)).status,
    200,
  );
  assert.equal(
    (await api(users.owner, 'DELETE', `/v1/projects/${id}/members/${users.owner.id}`)).status,
    409,
  );
  const members = await api(users.owner, 'GET', `/v1/projects/${id}/members`);
  assert.deepEqual(members.body.members.map((item) => item.role).sort(), ['editor', 'owner']);
});
