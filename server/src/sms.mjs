import crypto from 'node:crypto';

const encode = (value) => encodeURIComponent(String(value)).replace(/[!'()*]/g, (char) =>
  `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
);

function signature(parameters, secret) {
  const canonical = Object.keys(parameters)
    .sort()
    .map((key) => `${encode(key)}=${encode(parameters[key])}`)
    .join('&');
  const stringToSign = `POST&%2F&${encode(canonical)}`;
  return crypto.createHmac('sha1', `${secret}&`).update(stringToSign).digest('base64');
}

export function normalizePhone(value) {
  const phone = String(value ?? '').trim().replace(/^\+86/, '');
  if (!/^1[3-9]\d{9}$/.test(phone)) throw new Error('手机号格式无效。');
  return phone;
}

export async function sendVerificationCode(config, phone, code) {
  if (config.sms.dryRun) return;
  const sms = config.sms;
  if (!sms.accessKeyId || !sms.accessKeySecret || !sms.signName || !sms.templateCode) {
    throw new Error('短信服务尚未配置。');
  }
  const parameters = {
    AccessKeyId: sms.accessKeyId,
    Action: 'SendSms',
    Format: 'JSON',
    PhoneNumbers: phone,
    RegionId: sms.regionId,
    SignName: sms.signName,
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: crypto.randomUUID(),
    SignatureVersion: '1.0',
    TemplateCode: sms.templateCode,
    TemplateParam: JSON.stringify({ code }),
    Timestamp: new Date().toISOString(),
    Version: '2017-05-25',
  };
  const body = new URLSearchParams({ ...parameters, Signature: signature(parameters, sms.accessKeySecret) });
  const response = await fetch('https://dysmsapi.aliyuncs.com/', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.Code !== 'OK') {
    throw new Error(`短信发送失败：${result.Message ?? response.status}`);
  }
}
