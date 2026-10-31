import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineTarget } from './prepare-agent.mjs';

test('chooses native sidecars for Windows, Apple Silicon and Intel Macs', () => {
  assert.deepEqual(engineTarget('win32', 'x64'), {
    triple: 'x86_64-pc-windows-msvc',
    suffix: '.exe',
  });
  assert.deepEqual(engineTarget('darwin', 'arm64'), { triple: 'aarch64-apple-darwin', suffix: '' });
  assert.deepEqual(engineTarget('darwin', 'x64'), { triple: 'x86_64-apple-darwin', suffix: '' });
  assert.throws(() => engineTarget('darwin', 'arm64', '../../wrong-target'));
});
