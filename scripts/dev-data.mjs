// Development data for `pnpm tauri dev`, kept apart from the data the
// release build uses.
//
//   pnpm dev:data                   show both locations and what they hold
//   pnpm dev:data refresh           replace the development projects with a
//                                   copy of the release data
//   pnpm dev:data refresh --from <workspace folder>
//
// Close both apps before refreshing. Each instance keeps its own device id,
// sign-in and sync progress, so those files survive a refresh, and the
// previous development workspace stays in `workspace.before-refresh`.
// Paths the copy records inside the release data folder (managed project
// code, Agent bindings and history) are moved to the development folder, the
// way the app's own data move does, so the development build never writes
// into the release data.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Files that belong to one instance rather than to the research data. */
export const PER_INSTANCE = ['collaboration.json', 'collaboration-auth.json', 'collaboration'];

// The fields and tables `rewrite_owned_metadata` in
// crates/scientify-core/src/storage_location.rs moves; keep the two in step.
const PATH_FIELDS = new Set([
  'path',
  'root',
  'cwd',
  'agentCwd',
  'directory',
  'executable',
  'workspaceRoot',
  'rollout_path',
  'writable_roots',
]);
const PATH_COLUMNS = [
  ['threads', 'cwd'],
  ['threads', 'rollout_path'],
  ['project_roots', 'path'],
  ['rollout_migration_skipped_rollouts', 'rollout_path'],
];
const VERBATIM = '\\\\?\\';

/**
 * `text` moved from under `from` to under `to`, or null when it lies
 * elsewhere. Mirrors `relocate_path`: on Windows the `\\?\` prefix and slash
 * direction do not matter, letter case is ignored, and the original suffix
 * and prefix style are kept.
 */
export function relocatePath(text, from, to, windows = process.platform === 'win32') {
  const plain = (value) => (value.startsWith(VERBATIM) ? value.slice(VERBATIM.length) : value);
  const key = (value) => (windows ? plain(value).replaceAll('/', '\\') : value);
  const lower = (value) => value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  const value = key(text);
  const prefix = key(from);
  if (lower(value.slice(0, prefix.length)) !== lower(prefix)) return null;
  const rest = value.slice(prefix.length);
  if (rest && !rest.startsWith(windows ? '\\' : '/')) return null;
  const original = windows ? plain(text) : text;
  const target = windows && text.startsWith(VERBATIM) ? VERBATIM + plain(to) : plain(to);
  return target + original.slice(prefix.length);
}

function relocateJson(value, from, to) {
  let changed = false;
  if (Array.isArray(value)) {
    for (const item of value) changed = relocateJson(item, from, to) || changed;
  } else if (value && typeof value === 'object') {
    for (const [name, field] of Object.entries(value)) {
      if (PATH_FIELDS.has(name)) {
        if (typeof field === 'string') {
          const next = relocatePath(field, from, to);
          if (next !== null) {
            value[name] = next;
            changed = true;
          }
        } else if (Array.isArray(field)) {
          field.forEach((item, index) => {
            const next = typeof item === 'string' ? relocatePath(item, from, to) : null;
            if (next !== null) {
              field[index] = next;
              changed = true;
            }
          });
        }
      }
      changed = relocateJson(value[name], from, to) || changed;
    }
  }
  return changed;
}

function rewriteJson(file, from, to) {
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (relocateJson(value, from, to)) writeFileSync(file, JSON.stringify(value, null, 2));
}

function files(folder, keep) {
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && keep(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

function rewriteDatabase(file, from, to) {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const db = new DatabaseSync(file);
  try {
    if (Object.values(db.prepare('PRAGMA quick_check').get())[0] !== 'ok')
      throw new Error(`Agent history database failed its check: ${file}`);
    db.exec('BEGIN');
    for (const [table, column] of PATH_COLUMNS) {
      const exists = db
        .prepare("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?) AS e")
        .get(table).e;
      if (!exists) continue;
      const rows = db
        .prepare(`SELECT rowid AS id, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`)
        .all();
      const update = db.prepare(`UPDATE ${table} SET ${column}=? WHERE rowid=?`);
      for (const row of rows) {
        const next = typeof row.value === 'string' ? relocatePath(row.value, from, to) : null;
        if (next !== null) update.run(next, row.id);
      }
    }
    db.exec('COMMIT');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}

/** Move recorded paths in a copied workspace from the `from` data folder to `to`. */
export function relocateWorkspace(workspace, from, to) {
  for (const name of readdirSync(workspace)) {
    const file = join(workspace, name);
    if (!name.endsWith('.json') || !statSync(file).isFile()) continue;
    if (name === 'literature-roots.json') {
      const roots = JSON.parse(readFileSync(file, 'utf8'));
      for (const [id, root] of Object.entries(roots))
        roots[id] = relocatePath(root, from, to) ?? root;
      writeFileSync(file, JSON.stringify(roots, null, 2));
    } else if (name.startsWith('workspace')) {
      rewriteJson(file, from, to);
    }
  }
  for (const file of files(join(workspace, 'agent', 'bindings'), (n) => n.endsWith('.json')))
    rewriteJson(file, from, to);
  for (const file of files(
    join(workspace, 'experiments'),
    (n) => n === 'record.json' || n === 'request.json',
  ))
    rewriteJson(file, from, to);
  for (const domain of ['code', 'literature']) {
    const home = join(workspace, 'agent', domain);
    for (const folder of ['sessions', 'archived_sessions']) {
      for (const file of files(join(home, folder), (n) => n.endsWith('.jsonl'))) {
        let changed = false;
        const lines = readFileSync(file, 'utf8')
          .split('\n')
          .filter((line) => line.length)
          .map((line) => {
            const value = JSON.parse(line);
            const meta = value.type === 'session_meta' || value.type === 'turn_context';
            if (!meta || !relocateJson(value, from, to)) return line;
            changed = true;
            return JSON.stringify(value);
          });
        if (changed) writeFileSync(file, `${lines.join('\n')}\n`);
      }
    }
    if (existsSync(home))
      for (const name of readdirSync(home))
        if (name.endsWith('.sqlite')) rewriteDatabase(join(home, name), from, to);
  }
}

/** The same rule as `development_directory` in `src-tauri/src/data_location.rs`. */
export function developmentWorkspace(env = process.env, root = checkout) {
  if (env.SCIENTIFY_DATA_DIR) return resolve(env.SCIENTIFY_DATA_DIR);
  return join(dirname(root), 'ScientifyDevData', 'workspace');
}

/**
 * The release build's workspace: where its storage pointer says, else the
 * default container. A Windows build started from this checkout (via
 * Scientify-MVP.cmd) treats the checkout as its installation folder.
 */
export function releaseWorkspace(platform = process.platform, root = checkout, home = homedir()) {
  const installation =
    platform === 'darwin' ? join(home, 'Library', 'Application Support', 'Scientify') : root;
  const pointer = join(installation, 'scientify-storage.json');
  const container = existsSync(pointer)
    ? JSON.parse(readFileSync(pointer, 'utf8')).directory.replace(/^\\\\\?\\/, '')
    : join(installation, 'ScientifyData');
  return join(container, 'workspace');
}

export function describe(workspace) {
  const file = join(workspace, 'workspace.json');
  if (!existsSync(file)) return 'no workspace yet';
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const projects = (data.projects ?? []).map((project) => project.name).join(', ');
  const saved = statSync(file).mtime.toISOString().slice(0, 16).replace('T', ' ');
  return `${data.projects?.length ?? 0} projects (${projects}), ${data.records?.length ?? 0} notes, saved ${saved} UTC`;
}

/** Replace the development workspace with the release one, keeping per-instance files. */
export function refresh(from, to) {
  if (!existsSync(join(from, 'workspace.json'))) throw new Error(`No workspace at ${from}`);
  if (resolve(from) === resolve(to))
    throw new Error('Release and development data are the same folder');
  const previous = join(dirname(to), 'workspace.before-refresh');
  if (existsSync(to)) {
    rmSync(previous, { recursive: true, force: true });
    // Renaming fails while the development app still has the workspace open.
    renameSync(to, previous);
  }
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, {
    recursive: true,
    filter: (source) => {
      const top = relative(from, source).split(sep)[0];
      return !PER_INSTANCE.includes(top) && !source.endsWith('.lock');
    },
  });
  for (const name of PER_INSTANCE) {
    const kept = join(previous, name);
    if (existsSync(kept)) cpSync(kept, join(to, name), { recursive: true });
  }
  keepSyncedProjects(previous, to);
  relocateWorkspace(to, dirname(resolve(from)), dirname(resolve(to)));
  return previous;
}

/**
 * Which projects an instance syncs is recorded on the projects themselves (the
 * member role and the collaboration space), so carry that over as well.
 */
function keepSyncedProjects(previous, workspace) {
  const before = join(previous, 'workspace.json');
  if (!existsSync(before)) return;
  const old = JSON.parse(readFileSync(before, 'utf8'));
  const file = join(workspace, 'workspace.json');
  const data = JSON.parse(readFileSync(file, 'utf8'));
  let changed = false;
  for (const project of old.projects ?? []) {
    const target = (data.projects ?? []).find((item) => item.id === project.id);
    if (!project.collaborationRole || !target) continue;
    target.collaborationRole = project.collaborationRole;
    target.space = project.space;
    const team = (old.teams ?? []).find((item) => item.id === project.space);
    data.teams ??= [];
    if (team && !data.teams.some((item) => item.id === team.id)) data.teams.push(team);
    changed = true;
  }
  if (changed) writeFileSync(file, JSON.stringify(data, null, 2));
}

function main(args) {
  const to = developmentWorkspace();
  const fromFlag = args.indexOf('--from');
  const from = fromFlag >= 0 ? resolve(args[fromFlag + 1] ?? '') : releaseWorkspace();
  if (args[0] === 'refresh') {
    const previous = refresh(from, to);
    console.log(`Copied the release data into ${to}`);
    console.log(`The previous development data is in ${previous}`);
  } else if (args.length) {
    throw new Error(`Unknown command: ${args.join(' ')}`);
  }
  console.log(`Release data:     ${from}\n  ${describe(from)}`);
  console.log(`Development data: ${to}\n  ${describe(to)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
