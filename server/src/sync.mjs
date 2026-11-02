// Project sync keeps the latest state of every file and record. Devices push the
// changes they made against a known revision and pull everything above their
// cursor, so a new device reads the current state instead of replaying history.

/** File domains carry an OSS blob; record domains carry JSON content. */
export const DOMAINS = {
  project: 'record',
  record: 'record',
  experiment: 'record',
  run: 'record',
  library: 'file',
  code: 'file',
  asset: 'file',
};

const RECORD_ID = /^[A-Za-z0-9_-]{1,80}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const KEEP_VERSIONS = 20;

/** Owners and editors write everything; reviewers may only edit notes. */
export function canWriteDomain(role, domain) {
  if (role === 'owner' || role === 'editor') return true;
  return role === 'reviewer' && domain === 'record';
}

export function validPath(domain, path) {
  if (typeof path !== 'string' || !path || path.length > 1024) return false;
  if (DOMAINS[domain] === 'record') return domain === 'project' ? path === 'meta' : RECORD_ID.test(path);
  if (/[\0\\:*?"<>|]/.test(path) || path.startsWith('/')) return false;
  return path.split('/').every((part) => part && part !== '.' && part !== '..' && part.trim() === part);
}

function validate(change, role) {
  if (!change || typeof change !== 'object') return '同步变更格式无效。';
  const { domain, path } = change;
  if (!DOMAINS[domain]) return '未知的同步类型。';
  if (!validPath(domain, path)) return '同步路径无效。';
  if (!canWriteDomain(role, domain)) return '当前成员权限不能修改这部分内容。';
  if (!Number.isSafeInteger(change.baseRevision) || change.baseRevision < 0) return '同步版本无效。';
  if (change.deleted === true) return null;
  if (typeof change.hash !== 'string' || !HASH.test(change.hash)) return '同步内容摘要无效。';
  if (DOMAINS[domain] === 'file') {
    if (typeof change.blobId !== 'string' || !change.blobId) return '缺少文件内容。';
    if (!Number.isSafeInteger(change.size) || change.size < 0) return '文件大小无效。';
    return null;
  }
  if (change.content === undefined || change.content === null) return '缺少记录内容。';
  if (Buffer.byteLength(JSON.stringify(change.content)) > MAX_RECORD_BYTES) return '记录内容过大。';
  return null;
}

const sameState = (row, change) =>
  row.deleted === (change.deleted === true) && (row.deleted || row.hash === change.hash);

const entity = (row) => ({
  domain: row.domain,
  path: row.path,
  revision: Number(row.revision),
  changeSeq: Number(row.change_seq),
  deleted: row.deleted,
  hash: row.hash,
  size: row.size_bytes === null ? null : Number(row.size_bytes),
  blobId: row.blob_id,
  content: row.content,
  updatedBy: row.updated_by,
  deviceId: row.device_id,
  updatedAt: row.updated_at,
});

/**
 * Apply a device's changes. Each accepted change gets the next per-project
 * change number; a change made against an older revision is reported back so
 * the device can pull the newer state and reconcile.
 */
export async function pushEntities(client, projectId, userId, role, input) {
  const deviceId = String(input.deviceId ?? '').slice(0, 80);
  if (!deviceId) throw Object.assign(new Error('缺少设备标识。'), { status: 400 });
  const changes = Array.isArray(input.changes) ? input.changes.slice(0, 200) : [];
  const project = await client.query('SELECT change_seq FROM projects WHERE id = $1 FOR UPDATE', [
    projectId,
  ]);
  if (!project.rows[0]) throw Object.assign(new Error('项目不存在。'), { status: 404 });
  const initial = Number(project.rows[0].change_seq);
  let seq = initial;
  const accepted = [];
  const rejected = [];
  for (const change of changes) {
    const problem = validate(change, role);
    const key = { domain: change?.domain, path: change?.path };
    if (problem) {
      rejected.push({ ...key, message: problem });
      continue;
    }
    const found = await client.query(
      'SELECT * FROM sync_entities WHERE project_id = $1 AND domain = $2 AND path = $3',
      [projectId, change.domain, change.path],
    );
    const current = found.rows[0];
    const revision = current ? Number(current.revision) : 0;
    // A retry whose first attempt already landed, or two devices making the same edit.
    if (current && sameState(current, change)) {
      accepted.push({ ...key, revision, changeSeq: Number(current.change_seq) });
      continue;
    }
    if (!current && change.deleted === true) {
      accepted.push({ ...key, revision: 0, changeSeq: seq });
      continue;
    }
    if (change.baseRevision !== revision) {
      rejected.push({
        ...key,
        conflict: true,
        serverRevision: revision,
        message: '远程内容已更新，需要先同步。',
      });
      continue;
    }
    if (DOMAINS[change.domain] === 'file' && change.deleted !== true) {
      const blob = await client.query(
        "SELECT sha256 FROM blobs WHERE id = $1 AND project_id = $2 AND status = 'complete'",
        [change.blobId, projectId],
      );
      if (blob.rows[0]?.sha256 !== change.hash) {
        rejected.push({ ...key, message: '文件尚未上传完成。' });
        continue;
      }
    }
    if (current) {
      await client.query(
        `INSERT INTO sync_entity_versions
           (project_id, domain, path, revision, deleted, hash, size_bytes, blob_id, content, updated_by, device_id, updated_at)
         SELECT project_id, domain, path, revision, deleted, hash, size_bytes, blob_id, content, updated_by, device_id, updated_at
           FROM sync_entities WHERE project_id = $1 AND domain = $2 AND path = $3
         ON CONFLICT DO NOTHING`,
        [projectId, change.domain, change.path],
      );
      await client.query(
        `DELETE FROM sync_entity_versions
          WHERE project_id = $1 AND domain = $2 AND path = $3 AND revision <= $4`,
        [projectId, change.domain, change.path, revision - KEEP_VERSIONS],
      );
    }
    seq += 1;
    const deleted = change.deleted === true;
    const file = DOMAINS[change.domain] === 'file';
    await client.query(
      `INSERT INTO sync_entities
         (project_id, domain, path, revision, change_seq, deleted, hash, size_bytes, blob_id, content, updated_by, device_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
       ON CONFLICT (project_id, domain, path) DO UPDATE SET
         revision = EXCLUDED.revision, change_seq = EXCLUDED.change_seq, deleted = EXCLUDED.deleted,
         hash = EXCLUDED.hash, size_bytes = EXCLUDED.size_bytes, blob_id = EXCLUDED.blob_id,
         content = EXCLUDED.content, updated_by = EXCLUDED.updated_by,
         device_id = EXCLUDED.device_id, updated_at = EXCLUDED.updated_at`,
      [
        projectId,
        change.domain,
        change.path,
        revision + 1,
        seq,
        deleted,
        deleted ? null : change.hash,
        deleted || !file ? null : change.size,
        deleted || !file ? null : change.blobId,
        deleted || file ? null : JSON.stringify(change.content),
        userId,
        deviceId,
      ],
    );
    const name = typeof change.content?.name === 'string' ? change.content.name.trim() : '';
    if (change.domain === 'project' && !deleted && name && name.length <= 160) {
      await client.query('UPDATE projects SET name = $2 WHERE id = $1', [projectId, name]);
    }
    accepted.push({ ...key, revision: revision + 1, changeSeq: seq });
  }
  if (seq !== initial) {
    await client.query('UPDATE projects SET change_seq = $2, updated_at = NOW() WHERE id = $1', [
      projectId,
      seq,
    ]);
  }
  return { accepted, rejected, changeSeq: seq };
}

/** Entities changed after `since`, oldest first; `since = 0` returns the whole project. */
export async function pullEntities(db, projectId, since, limit = 500) {
  const cursor = Number.isSafeInteger(since) && since > 0 ? since : 0;
  const size = Math.min(Math.max(Number(limit) || 500, 1), 1000);
  const result = await db.query(
    `SELECT domain, path, revision, change_seq, deleted, hash, size_bytes, blob_id, content,
            updated_by, device_id, updated_at
       FROM sync_entities WHERE project_id = $1 AND change_seq > $2
      ORDER BY change_seq LIMIT $3`,
    [projectId, cursor, size + 1],
  );
  const rows = result.rows.slice(0, size);
  const project = await db.query('SELECT change_seq FROM projects WHERE id = $1', [projectId]);
  return {
    entities: rows.map(entity),
    nextSince: rows.length ? Number(rows.at(-1).change_seq) : cursor,
    hasMore: result.rows.length > size,
    changeSeq: Number(project.rows[0]?.change_seq ?? 0),
  };
}
