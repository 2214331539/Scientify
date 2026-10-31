import test from 'node:test';
import assert from 'node:assert/strict';
import { signedDownloadUrl, signedUploadUrl } from '../src/oss.mjs';

const config = {
  oss: {
    endpoint: 'oss-cn-beijing.aliyuncs.com',
    bucket: 'scientify-files',
    accessKeyId: 'key-id',
    accessKeySecret: 'secret',
    urlTtl: 900,
  },
};

test('OSS URLs use a virtual-hosted bucket and sign the same resource path', () => {
  const download = new URL(signedDownloadUrl(config, 'projects/p1/blobs/a b', 1000));
  assert.equal(download.host, 'scientify-files.oss-cn-beijing.aliyuncs.com');
  assert.equal(download.pathname, '/projects/p1/blobs/a%20b');
  assert.equal(download.searchParams.get('Expires'), '1900');
  assert.ok(download.searchParams.get('Signature'));
});

test('upload signatures include the content type', () => {
  const first = signedUploadUrl(config, 'projects/p1/blobs/hash', 'application/pdf', 1000);
  const second = signedUploadUrl(config, 'projects/p1/blobs/hash', 'text/plain', 1000);
  assert.notEqual(first, second);
});
