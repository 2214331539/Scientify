import crypto from 'node:crypto';

const encodedPath = (key) => key.split('/').map(encodeURIComponent).join('/');

function endpointHost(endpoint, bucket) {
  const host = endpoint.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  // Alibaba OSS virtual-hosted URLs put the bucket in the host. Accept both
  // `oss-cn-*.aliyuncs.com` and an already-qualified bucket endpoint so the
  // deployment file remains portable across regions and custom CNAMEs.
  return host === bucket || host.startsWith(`${bucket}.`) ? host : `${bucket}.${host}`;
}

function sign(config, method, key, expires, contentType = '') {
  const host = endpointHost(config.oss.endpoint, config.oss.bucket);
  // OSS V1 canonicalized resources retain the bucket segment even when the
  // request uses a virtual-hosted bucket URL.
  const resource = `/${config.oss.bucket}/${key}`;
  const stringToSign = `${method}\n\n${contentType}\n${expires}\n${resource}`;
  const signature = crypto
    .createHmac('sha1', config.oss.accessKeySecret)
    .update(stringToSign)
    .digest('base64');
  const url = new URL(`https://${host}/${encodedPath(key)}`);
  url.searchParams.set('OSSAccessKeyId', config.oss.accessKeyId);
  url.searchParams.set('Expires', String(expires));
  url.searchParams.set('Signature', signature);
  return url.toString();
}

export function objectKey(projectId, sha256) {
  return `projects/${projectId}/blobs/${sha256.toLowerCase()}`;
}

export function signedUploadUrl(config, key, contentType, now = Math.floor(Date.now() / 1000)) {
  return sign(config, 'PUT', key, now + config.oss.urlTtl, contentType);
}

export function signedDownloadUrl(config, key, now = Math.floor(Date.now() / 1000)) {
  return sign(config, 'GET', key, now + config.oss.urlTtl);
}

export function signedDeleteUrl(config, key, now = Math.floor(Date.now() / 1000)) {
  return sign(config, 'DELETE', key, now + config.oss.urlTtl);
}

export async function deleteObject(config, key) {
  const response = await fetch(signedDeleteUrl(config, key), { method: 'DELETE' });
  if (!response.ok && response.status !== 404) {
    throw new Error(`OSS 删除失败：${response.status}`);
  }
}
