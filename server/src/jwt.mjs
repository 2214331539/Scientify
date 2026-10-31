import crypto from 'node:crypto';

const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const decode = (value) => JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));

export function hashSecret(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function signToken(payload, secret, ttlSeconds, issuer, now = Math.floor(Date.now() / 1000)) {
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const body = encode({ ...payload, iss: issuer, iat: now, exp: now + ttlSeconds });
  const input = `${header}.${body}`;
  const signature = crypto.createHmac('sha256', secret).update(input).digest('base64url');
  return `${input}.${signature}`;
}

export function verifyToken(token, secret, issuer, now = Math.floor(Date.now() / 1000)) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) throw new Error('Invalid token');
  const input = `${parts[0]}.${parts[1]}`;
  const expected = crypto.createHmac('sha256', secret).update(input).digest('base64url');
  const actual = Buffer.from(parts[2]);
  const wanted = Buffer.from(expected);
  if (actual.length !== wanted.length || !crypto.timingSafeEqual(actual, wanted)) {
    throw new Error('Invalid token');
  }
  const payload = decode(parts[1]);
  if (payload.iss !== issuer || !payload.sub || Number(payload.exp) <= now) {
    throw new Error('Expired token');
  }
  return payload;
}
