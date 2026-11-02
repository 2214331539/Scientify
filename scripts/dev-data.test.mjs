import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { developmentWorkspace, refresh, relocatePath, releaseWorkspace } from './dev-data.mjs';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

function workspace(dir, files) {
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
}

test('every checkout shares the development data next to it', () => {
  const root = join('repos', 'Scientify-Desktop');
  assert.equal(developmentWorkspace({}, root), join('repos', 'ScientifyDevData', 'workspace'));
  assert.match(developmentWorkspace({ SCIENTIFY_DATA_DIR: 'elsewhere' }, root), /elsewhere$/);
});

test('the release data follows the storage pointer, else the default container', () => {
  const root = mkdtempSync(join(tmpdir(), 'scientify-checkout-'));
  assert.equal(releaseWorkspace('win32', root), join(root, 'ScientifyData', 'workspace'));
  writeFileSync(
    join(root, 'scientify-storage.json'),
    JSON.stringify({ directory: '\\\\?\\F:\\Data\\ScientifyData', pending: null, cleanup: [] }),
  );
  assert.equal(releaseWorkspace('win32', root), join('F:\\Data\\ScientifyData', 'workspace'));
  const home = mkdtempSync(join(tmpdir(), 'scientify-home-'));
  assert.equal(
    releaseWorkspace('darwin', root, home),
    join(home, 'Library', 'Application Support', 'Scientify', 'ScientifyData', 'workspace'),
  );
});

test('a refresh copies the research data and keeps each instance its own sign-in', () => {
  const base = mkdtempSync(join(tmpdir(), 'scientify-data-'));
  const release = join(base, 'ScientifyData', 'workspace');
  const development = join(base, 'ScientifyDevData', 'workspace');
  const team = { id: 'scientify-collaboration', name: 'Team' };
  workspace(release, {
    'workspace.json': JSON.stringify({
      revision: 381,
      teams: [],
      projects: [
        { id: 'p', space: 'personal' },
        { id: 'q', space: 'personal' },
      ],
    }),
    'note-assets/fig.png': 'png',
    'collaboration.json': '{"clientId":"release"}',
  });
  workspace(development, {
    'workspace.json': JSON.stringify({
      revision: 324,
      teams: [team],
      projects: [{ id: 'p', space: team.id, collaborationRole: 'owner' }],
    }),
    'collaboration.json': '{"clientId":"dev"}',
    'collaboration-auth.json': '{"token":"dev"}',
    'collaboration/projects/p.json': '{"since":7}',
  });

  const previous = refresh(release, development);
  const data = JSON.parse(readFileSync(join(development, 'workspace.json'), 'utf8'));
  assert.equal(data.revision, 381);
  // The project this instance syncs stays a cloud project; the others stay personal.
  assert.deepEqual(data.projects, [
    { id: 'p', space: team.id, collaborationRole: 'owner' },
    { id: 'q', space: 'personal' },
  ]);
  assert.deepEqual(data.teams, [team]);
  assert.ok(existsSync(join(development, 'note-assets/fig.png')));
  assert.equal(readFileSync(join(development, 'collaboration.json'), 'utf8'), '{"clientId":"dev"}');
  assert.ok(existsSync(join(development, 'collaboration-auth.json')));
  assert.ok(existsSync(join(development, 'collaboration/projects/p.json')));
  assert.equal(JSON.parse(readFileSync(join(previous, 'workspace.json'), 'utf8')).revision, 324);
  assert.throws(() => refresh(join(base, 'missing'), development), /No workspace/);
  assert.throws(() => refresh(release, release), /same folder/);
});

test('paths move between data folders the way the app relocates them', () => {
  const from = String.raw`F:\Data\ScientifyData`;
  const to = String.raw`F:\Data\ScientifyDevData`;
  const move = (text) => relocatePath(text, from, to, true);
  assert.equal(
    move(String.raw`F:\Data\ScientifyData\workspace\projects\p`),
    String.raw`F:\Data\ScientifyDevData\workspace\projects\p`,
  );
  // The \\?\ prefix stays, letter case is ignored and the suffix keeps its own case.
  assert.equal(
    move(String.raw`\\?\f:\data\scientifydata\Workspace`),
    String.raw`\\?\F:\Data\ScientifyDevData\Workspace`,
  );
  assert.equal(move('F:/Data/ScientifyData/agent/x.jsonl'), `${to}/agent/x.jsonl`);
  assert.equal(move(from), to);
  assert.equal(move(String.raw`F:\Data\ScientifyDataOld\workspace`), null);
  assert.equal(move(String.raw`D:\AScience\Proactive`), null);
  assert.equal(
    relocatePath('/Users/a/Data/x', '/Users/a/Data', '/Users/a/Dev', false),
    '/Users/a/Dev/x',
  );
  assert.equal(relocatePath('/Users/a/Database', '/Users/a/Data', '/Users/a/Dev', false), null);
});

test('a refresh points the copied bindings, sessions and history at the development folder', () => {
  const base = mkdtempSync(join(tmpdir(), 'scientify-move-'));
  const releaseRoot = join(base, 'ScientifyData');
  const devRoot = join(base, 'ScientifyDevData');
  const release = join(releaseRoot, 'workspace');
  const development = join(devRoot, 'workspace');
  const project = join(release, 'projects', 'p1');
  const outside = join(base, 'Papers');
  workspace(release, {
    'workspace.json': JSON.stringify({ revision: 1, projects: [{ id: 'p1', root: project }] }),
    'literature-roots.json': JSON.stringify({ p1: outside, p2: join(release, 'library') }),
    'agent/bindings/p1/b.json': JSON.stringify({ root: project, note: project }),
    'experiments/e1/record.json': JSON.stringify({ cwd: project }),
    'agent/code/sessions/2026/s.jsonl': [
      JSON.stringify({ type: 'session_meta', payload: { cwd: project } }),
      JSON.stringify({ type: 'event_msg', payload: { cwd: project } }),
    ].join('\n'),
  });
  const db = new DatabaseSync(join(release, 'agent', 'code', 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (cwd TEXT, rollout_path TEXT)');
  db.prepare('INSERT INTO threads VALUES (?, ?)').run(project, join(release, 'agent', 'r.jsonl'));
  db.close();

  refresh(release, development);
  const moved = join(development, 'projects', 'p1');
  const read = (name) => JSON.parse(readFileSync(join(development, name), 'utf8'));
  assert.equal(read('workspace.json').projects[0].root, moved);
  assert.deepEqual(read('literature-roots.json'), {
    p1: outside,
    p2: join(development, 'library'),
  });
  // Only path fields move; free text keeps the original wording.
  assert.deepEqual(read('agent/bindings/p1/b.json'), { root: moved, note: project });
  assert.equal(read('experiments/e1/record.json').cwd, moved);
  const [meta, event] = readFileSync(join(development, 'agent/code/sessions/2026/s.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(meta.payload.cwd, moved);
  assert.equal(event.payload.cwd, project);
  const copy = new DatabaseSync(join(development, 'agent', 'code', 'state_5.sqlite'));
  assert.deepEqual(
    { ...copy.prepare('SELECT cwd, rollout_path FROM threads').get() },
    { cwd: moved, rollout_path: join(development, 'agent', 'r.jsonl') },
  );
  copy.close();
  // The release data itself is untouched.
  assert.equal(
    JSON.parse(readFileSync(join(release, 'workspace.json'), 'utf8')).projects[0].root,
    project,
  );
});
