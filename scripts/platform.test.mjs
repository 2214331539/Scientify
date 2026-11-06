import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { hostTarget, targetInfo } from './platform.mjs';

const read = (path) => readFileSync(new URL(`../src-tauri/${path}`, import.meta.url), 'utf8');

test('macOS uses native window chrome and Windows keeps the custom one', () => {
  // Platform config is a JSON merge patch: a windows array replaces the base one whole.
  const [base] = JSON.parse(read('tauri.conf.json')).app.windows;
  const [mac] = JSON.parse(read('tauri.macos.conf.json')).app.windows;
  assert.equal(base.decorations, false);
  assert.deepEqual(mac, { ...base, decorations: true, titleBarStyle: 'Visible' });
  assert.match(read('src/windows.rs'), /\.decorations\(cfg!\(target_os = "macos"\)\)/);
});

test('supported native builds package executable files for the matching OS', () => {
  assert.equal(targetInfo(hostTarget('darwin', 'arm64')).suffix, '');
  assert.equal(targetInfo(hostTarget('win32', 'x64')).suffix, '.exe');
  assert.throws(() => hostTarget('darwin', 'x64'), /Unsupported/);
  assert.throws(() => targetInfo('universal-apple-darwin'), /Unsupported/);
});
