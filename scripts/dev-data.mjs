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
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Files that belong to one instance rather than to the research data. */
export const PER_INSTANCE = ['collaboration.json', 'collaboration-auth.json', 'collaboration'];

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
  return previous;
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
