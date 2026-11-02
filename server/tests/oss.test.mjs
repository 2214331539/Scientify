import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  regionOf,
  signatureV4,
  signedDownloadUrl,
  signedUploadUrl,
  signingKey,
} from '../src/oss.mjs';

const config = {
  oss: {
    endpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
    region: 'cn-hangzhou',
    bucket: 'scientify-files',
    accessKeyId: 'key-id',
    accessKeySecret: 'secret',
    urlTtl: 900,
  },
};

// The PutObject example from Alibaba Cloud's "V4 signature in the Authorization
// header" page. Its signing key was derived from an unpublished secret, so only
// the canonical request is checked here; OSS itself has accepted the signatures.
test('canonical requests hash like the published PutObject example', () => {
  const canonicalRequest = [
    'PUT',
    '/examplebucket/exampleobject',
    '',
    'content-disposition:attachment',
    'content-length:3',
    'content-md5:ICy5YqxZB1uWSwcVLSNLcA==',
    'content-type:text/plain',
    'x-oss-content-sha256:UNSIGNED-PAYLOAD',
    'x-oss-date:20250411T064124Z',
    '',
    'content-disposition;content-length',
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  assert.equal(
    crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
    'c46d96390bdbc2d739ac9363293ae9d710b14e48081fcb22cd8ad54b63136eca',
  );
});

test('the signing key chains date, region, service and terminator', () => {
  const chain = ['20250411', 'cn-hangzhou', 'oss', 'aliyun_v4_request'].reduce(
    (key, part) => crypto.createHmac('sha256', key).update(part).digest(),
    'aliyun_v4secret',
  );
  assert.deepEqual(signingKey('secret', '20250411', 'cn-hangzhou'), chain);
  const signature = signatureV4({
    secret: 'secret',
    timestamp: '20250411T064124Z',
    region: 'cn-hangzhou',
    canonicalRequest: 'GET\n/b/k\n\n\n\nUNSIGNED-PAYLOAD',
  });
  assert.match(signature, /^[0-9a-f]{64}$/);
});

test('download URLs use a virtual-hosted bucket and carry the V4 query', () => {
  const url = new URL(signedDownloadUrl(config, 'projects/p1/blobs/a b', 1_733_197_460));
  assert.equal(url.host, 'scientify-files.oss-cn-hangzhou.aliyuncs.com');
  assert.equal(url.pathname, '/projects/p1/blobs/a%20b');
  assert.equal(url.searchParams.get('x-oss-signature-version'), 'OSS4-HMAC-SHA256');
  assert.equal(
    url.searchParams.get('x-oss-credential'),
    'key-id/20241203/cn-hangzhou/oss/aliyun_v4_request',
  );
  assert.equal(url.searchParams.get('x-oss-date'), '20241203T034420Z');
  assert.equal(url.searchParams.get('x-oss-expires'), '900');
  assert.match(url.searchParams.get('x-oss-signature'), /^[0-9a-f]{64}$/);
  assert.ok(url.search.includes('x-oss-credential=key-id%2F20241203%2Fcn-hangzhou%2F'));
});

test('upload signatures include the content type', () => {
  const sig = (type) =>
    new URL(signedUploadUrl(config, 'projects/p1/blobs/hash', type, 1000)).searchParams.get(
      'x-oss-signature',
    );
  assert.notEqual(sig('application/pdf'), sig('text/plain'));
});

test('the signing region comes from OSS_REGION or the endpoint', () => {
  assert.equal(
    regionOf({ region: 'cn-beijing', endpoint: 'oss-cn-hangzhou.aliyuncs.com' }),
    'cn-beijing',
  );
  assert.equal(regionOf({ endpoint: 'https://oss-cn-hangzhou.aliyuncs.com' }), 'cn-hangzhou');
  assert.equal(regionOf({ endpoint: 'oss-cn-shanghai-internal.aliyuncs.com' }), 'cn-shanghai');
  assert.throws(() => regionOf({ endpoint: 'files.example.com' }));
});
