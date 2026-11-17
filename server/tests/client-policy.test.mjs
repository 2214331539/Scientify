import test from 'node:test';
import assert from 'node:assert/strict';
import { clientPolicy, compareVersions, requireSupportedClient } from '../src/client-policy.mjs';

test('versions compare as releases do, previews before their release', () => {
  assert.equal(compareVersions('0.4.0-alpha.2', '0.4.0-alpha.10'), -1);
  assert.equal(compareVersions('0.4.0-alpha.1', '0.4.0'), -1);
  assert.equal(compareVersions('0.10.0', '0.9.3'), 1);
  assert.equal(compareVersions('v0.4.0', '0.4.0'), 0);
  assert.equal(compareVersions('0.3.0-alpha.5', '0.4.0-alpha.1'), -1);
});

test('apps below the minimum are asked to update; older ones without a version pass', () => {
  const config = { minClientVersion: '0.4.0-alpha.1', recommendedClientVersion: '0.4.0-alpha.2' };
  const request = (version) => ({ headers: version ? { 'x-scientify-version': version } : {} });
  assert.throws(() => requireSupportedClient(request('0.3.9'), config), (error) => {
    assert.equal(error.status, 426);
    assert.equal(error.code, 'client_outdated');
    return true;
  });
  assert.doesNotThrow(() => requireSupportedClient(request('0.4.0-alpha.1'), config));
  assert.doesNotThrow(() => requireSupportedClient(request(''), config));
  assert.doesNotThrow(() => requireSupportedClient(request('0.1.0'), {}));
  assert.deepEqual(clientPolicy(config), { minimum: '0.4.0-alpha.1', recommended: '0.4.0-alpha.2' });
  assert.deepEqual(clientPolicy({}), { minimum: null, recommended: null });
});
