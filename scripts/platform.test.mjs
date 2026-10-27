import assert from 'node:assert/strict';
import test from 'node:test';
import { hostTarget, targetInfo } from './platform.mjs';

test('supported native builds package executable files for the matching OS', () => {
  assert.equal(targetInfo(hostTarget('darwin', 'arm64')).suffix, '');
  assert.equal(targetInfo(hostTarget('win32', 'x64')).suffix, '.exe');
  assert.throws(() => hostTarget('darwin', 'x64'), /Unsupported/);
  assert.throws(() => targetInfo('universal-apple-darwin'), /Unsupported/);
});
