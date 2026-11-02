import crypto from 'node:crypto';

// Presigned OSS URLs with signature V4 (OSS4-HMAC-SHA256). V1 is unavailable to
// accounts created after 2025-03-01 and to buckets created after 2025-09-01.
const ALGORITHM = 'OSS4-HMAC-SHA256';

// RFC 3986 encoding: only unreserved characters stay literal.
const uriEncode = (value) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
const encodedPath = (key) => key.split('/').map(uriEncode).join('/');

function endpointHost(endpoint, bucket) {
  const host = endpoint.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  // Alibaba OSS virtual-hosted URLs put the bucket in the host. Accept both
  // `oss-cn-*.aliyuncs.com` and an already-qualified bucket endpoint so the
  // deployment file remains portable across regions and custom CNAMEs.
  return host === bucket || host.startsWith(`${bucket}.`) ? host : `${bucket}.${host}`;
}

/** The region in the signing scope: OSS_REGION, or the `oss-<region>` part of the endpoint. */
export function regionOf(oss) {
  if (oss.region) return oss.region;
  const match = /(?:^|\.|\/\/)oss-([a-z0-9-]+?)(?:-internal)?\.aliyuncs\.com/.exec(oss.endpoint);
  if (!match) throw new Error('OSS_REGION is required when the endpoint does not name a region');
  return match[1];
}

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');

export function signingKey(secret, date, region) {
  const dateKey = hmac(`aliyun_v4${secret}`, date);
  return hmac(hmac(hmac(dateKey, region), 'oss'), 'aliyun_v4_request');
}

/** Hex signature of a canonical request, per the OSS V4 string-to-sign. */
export function signatureV4({ secret, timestamp, region, canonicalRequest }) {
  const date = timestamp.slice(0, 8);
  const stringToSign = [
    ALGORITHM,
    timestamp,
    `${date}/${region}/oss/aliyun_v4_request`,
    sha256Hex(canonicalRequest),
  ].join('\n');
  return crypto
    .createHmac('sha256', signingKey(secret, date, region))
    .update(stringToSign)
    .digest('hex');
}

const isoBasic = (seconds) =>
  new Date(seconds * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function sign(config, method, key, now, contentType = '') {
  const { bucket, accessKeyId, accessKeySecret, urlTtl } = config.oss;
  const region = regionOf(config.oss);
  const timestamp = isoBasic(now);
  const query = {
    'x-oss-credential': `${accessKeyId}/${timestamp.slice(0, 8)}/${region}/oss/aliyun_v4_request`,
    'x-oss-date': timestamp,
    'x-oss-expires': String(urlTtl),
    'x-oss-signature-version': ALGORITHM,
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((name) => `${uriEncode(name)}=${uriEncode(query[name])}`)
    .join('&');
  // Content-Type is signed whenever a request carries it, so an upload must send
  // exactly this value and a download must send none.
  const headers = contentType ? `content-type:${contentType.trim()}\n` : '';
  const canonicalRequest = [
    method,
    // The canonical URI names the bucket even for virtual-hosted URLs.
    `/${bucket}/${encodedPath(key)}`,
    canonicalQuery,
    headers,
    '',
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const signature = signatureV4({
    secret: accessKeySecret,
    timestamp,
    region,
    canonicalRequest,
  });
  const host = endpointHost(config.oss.endpoint, bucket);
  return `https://${host}/${encodedPath(key)}?${canonicalQuery}&x-oss-signature=${signature}`;
}

export function objectKey(projectId, sha256) {
  return `projects/${projectId}/blobs/${sha256.toLowerCase()}`;
}

export function signedUploadUrl(config, key, contentType, now = Math.floor(Date.now() / 1000)) {
  return sign(config, 'PUT', key, now, contentType);
}

export function signedDownloadUrl(config, key, now = Math.floor(Date.now() / 1000)) {
  return sign(config, 'GET', key, now);
}

export function signedDeleteUrl(config, key, now = Math.floor(Date.now() / 1000)) {
  return sign(config, 'DELETE', key, now);
}

export async function deleteObject(config, key) {
  const response = await fetch(signedDeleteUrl(config, key), { method: 'DELETE' });
  if (!response.ok && response.status !== 404) {
    throw new Error(`OSS 删除失败：${response.status}`);
  }
}
