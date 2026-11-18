import test from 'node:test';
import assert from 'node:assert/strict';
import { allowReport, cleanReport, fingerprint, scrub } from '../src/errors.mjs';

test('account names in home-folder paths are blanked', () => {
  assert.equal(scrub('ENOENT C:\\Users\\li\\data\\a.pdf'), 'ENOENT C:\\Users\\~\\data\\a.pdf');
  assert.equal(scrub('at /Users/wang/app.js and /home/zhao/x'), 'at /Users/~/app.js and /home/~/x');
});

test('a report needs a message; fields are cut to size', () => {
  assert.throws(
    () => cleanReport({ message: '  ' }),
    (error) => error.status === 400,
  );
  const report = cleanReport({ message: 'x'.repeat(5000), version: '0.4.0', extra: 'dropped' });
  assert.equal(report.message.length, 1000);
  assert.equal(report.version, '0.4.0');
  assert.equal('extra' in report, false);
});

test('one error in one version is one group, whatever its numbers and positions', () => {
  const a = {
    message: 'Cannot read "foo" of item 12',
    stack: 'at f (app.js:10:4)',
    version: '0.4.0',
  };
  const b = {
    message: 'Cannot read "bar" of item 7',
    stack: 'at f (app.js:11:9)',
    version: '0.4.0',
  };
  assert.equal(fingerprint(a), fingerprint(b));
  assert.notEqual(fingerprint(a), fingerprint({ ...a, version: '0.4.1' }));
  assert.notEqual(fingerprint(a), fingerprint({ ...a, stack: 'at g (other.js:1:1)' }));
});

test('an address sends at most 30 reports in ten minutes', () => {
  const start = 1_000_000;
  const results = Array.from({ length: 31 }, () => allowReport('10.0.0.1', start));
  assert.equal(results.filter(Boolean).length, 30);
  assert.equal(allowReport('10.0.0.1', start + 11 * 60_000), true);
});
