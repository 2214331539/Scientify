import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { developmentWorkspace, refresh, releaseWorkspace } from './dev-data.mjs';

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
  workspace(release, {
    'workspace.json': '{"revision":381}',
    'note-assets/fig.png': 'png',
    'collaboration.json': '{"clientId":"release"}',
  });
  workspace(development, {
    'workspace.json': '{"revision":324}',
    'collaboration.json': '{"clientId":"dev"}',
    'collaboration-auth.json': '{"token":"dev"}',
    'collaboration/projects/p.json': '{"since":7}',
  });

  const previous = refresh(release, development);
  assert.equal(readFileSync(join(development, 'workspace.json'), 'utf8'), '{"revision":381}');
  assert.ok(existsSync(join(development, 'note-assets/fig.png')));
  assert.equal(readFileSync(join(development, 'collaboration.json'), 'utf8'), '{"clientId":"dev"}');
  assert.ok(existsSync(join(development, 'collaboration-auth.json')));
  assert.ok(existsSync(join(development, 'collaboration/projects/p.json')));
  assert.equal(readFileSync(join(previous, 'workspace.json'), 'utf8'), '{"revision":324}');
  assert.throws(() => refresh(join(base, 'missing'), development), /No workspace/);
  assert.throws(() => refresh(release, release), /same folder/);
});
