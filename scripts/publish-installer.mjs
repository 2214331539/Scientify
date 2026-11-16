// Uploads the installer staged in .release/ (scripts/stage-release.mjs) to the
// public download bucket the website links to: once under the version and once
// under latest/ with a fixed name, plus its SHA256SUMS line. Run on the machine
// that built it:
//   node scripts/stage-release.mjs && node scripts/publish-installer.mjs
// Credentials come from OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET, or from the
// [default] section of ~/.ossutilconfig. They are only used to sign requests here.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { signatureV4 } from '../server/src/oss.mjs';

const BUCKET = process.env.DOWNLOAD_BUCKET ?? 'soundingx-download-package';
const REGION = process.env.DOWNLOAD_REGION ?? 'cn-beijing';
const PREFIX = process.env.DOWNLOAD_PREFIX ?? 'scientify';
const HOST = `${BUCKET}.oss-${REGION}.aliyuncs.com`;
// The website's download buttons point at these names under latest/.
const LATEST = {
  windows_x64: 'Scientify_windows_x64_setup.exe',
  macos_arm64: 'Scientify_macos_arm64.dmg',
};
const TYPES = {
  '.exe': 'application/octet-stream',
  '.dmg': 'application/x-apple-diskimage',
  '.txt': 'text/plain; charset=utf-8',
};

function credentials() {
  if (process.env.OSS_ACCESS_KEY_ID && process.env.OSS_ACCESS_KEY_SECRET)
    return { id: process.env.OSS_ACCESS_KEY_ID, secret: process.env.OSS_ACCESS_KEY_SECRET };
  let text = '';
  try {
    text = readFileSync(join(homedir(), '.ossutilconfig'), 'utf8');
  } catch {
    throw new Error(
      'Set OSS_ACCESS_KEY_ID and OSS_ACCESS_KEY_SECRET, or configure ~/.ossutilconfig.',
    );
  }
  const section = text.split(/^\[/m).find((part) => part.startsWith('default]')) ?? '';
  const value = (name) => section.match(new RegExp(`^${name}\\s*=\\s*(.+)$`, 'mi'))?.[1].trim();
  const id = value('accessKeyID');
  const secret = value('accessKeySecret');
  if (!id || !secret)
    throw new Error('~/.ossutilconfig has no accessKeyID and accessKeySecret under [default].');
  return { id, secret };
}

const encode = (value) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
const encodedPath = (key) => key.split('/').map(encode).join('/');

/** A presigned PUT that also signs the public-read ACL, so the object is downloadable. */
function signedPut(key, contentType, { id, secret }) {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  const query = {
    'x-oss-credential': `${id}/${timestamp.slice(0, 8)}/${REGION}/oss/aliyun_v4_request`,
    'x-oss-date': timestamp,
    'x-oss-expires': '3600',
    'x-oss-signature-version': 'OSS4-HMAC-SHA256',
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((name) => `${encode(name)}=${encode(query[name])}`)
    .join('&');
  const headers = { 'content-type': contentType, 'x-oss-object-acl': 'public-read' };
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((name) => `${name}:${headers[name]}\n`)
    .join('');
  const canonicalRequest = [
    'PUT',
    `/${BUCKET}/${encodedPath(key)}`,
    canonicalQuery,
    canonicalHeaders,
    '',
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const signature = signatureV4({ secret, timestamp, region: REGION, canonicalRequest });
  return {
    url: `https://${HOST}/${encodedPath(key)}?${canonicalQuery}&x-oss-signature=${signature}`,
    headers,
  };
}

async function upload(file, key, keys) {
  const type = TYPES[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream';
  const { url, headers } = signedPut(key, type, keys);
  const body = readFileSync(file);
  const response = await fetch(url, { method: 'PUT', headers, body });
  if (!response.ok)
    throw new Error(
      `Upload of ${key} failed: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`,
    );
  // Anyone must be able to download it, as the website's buttons do.
  const check = await fetch(`https://${HOST}/${encodedPath(key)}`, { method: 'HEAD' });
  const size = Number(check.headers.get('content-length'));
  if (!check.ok || size !== body.length)
    throw new Error(
      `${key} is not publicly readable at the uploaded size (HTTP ${check.status}, ${size} bytes).`,
    );
  console.log(`  ${key}  ${(body.length / 1024 / 1024).toFixed(1)} MB`);
}

const directory = '.release';
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const keys = credentials();
const staged = readdirSync(directory).filter(
  (name) => /\.(exe|dmg)$/.test(name) && name.includes(version),
);
if (!staged.length)
  throw new Error(`No ${version} installer in ${directory}; run scripts/stage-release.mjs first.`);
for (const name of staged) {
  const label = Object.keys(LATEST).find((item) => name.includes(item));
  if (!label) throw new Error(`Unknown platform in ${name}.`);
  const file = join(directory, name);
  console.log(`${name} (${(statSync(file).size / 1024 / 1024).toFixed(1)} MB):`);
  await upload(file, `${PREFIX}/${version}/${name}`, keys);
  await upload(
    join(directory, `SHA256SUMS_${label}.txt`),
    `${PREFIX}/${version}/SHA256SUMS_${label}.txt`,
    keys,
  );
  await upload(file, `${PREFIX}/latest/${LATEST[label]}`, keys);
}
console.log(`Published to https://${HOST}/${PREFIX}/`);
