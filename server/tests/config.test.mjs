import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../src/config.mjs';

test('deployment aliases accept the Alibaba SMS environment names', () => {
  const config = readConfig({
    PORT: '8081',
    DATABASE_URL: 'postgresql://example',
    JWT_SECRET: 'x'.repeat(40),
    OSS_ENDPOINT: 'oss-cn-beijing.aliyuncs.com',
    OSS_BUCKET: 'bucket',
    OSS_ACCESS_KEY_ID: 'oss-id',
    OSS_ACCESS_KEY_SECRET: 'oss-secret',
    ALIBABA_CLOUD_ACCESS_KEY_ID: 'sms-id',
    ALIBABA_CLOUD_ACCESS_KEY_SECRET: 'sms-secret',
    ALIBABA_CLOUD_SMS_SIGN_NAME: '清屿科技',
    ALIBABA_CLOUD_SMS_TEMPLATE_CODE: 'SMS_306496012',
  });
  assert.equal(config.sms.accessKeyId, 'sms-id');
  assert.equal(config.sms.accessKeySecret, 'sms-secret');
  assert.equal(config.sms.signName, '清屿科技');
  assert.equal(config.sms.templateCode, 'SMS_306496012');
});
