// Uploads the installer staged in .release/ (scripts/stage-release.mjs) to the
// public download bucket the website links to: once under the version and once
// under latest/ with a fixed name, plus its SHA256SUMS line. Run on the machine
// that built it:
//   node scripts/build-release.mjs && node scripts/publish-installer.mjs [windows_x64|macos_arm64]
// An installer built elsewhere can be copied into .release/ with its
// SHA256SUMS_<platform>.txt (and update package .sig) and published from here.
// Credentials come from OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET, or from the
// [default] section of ~/.ossutilconfig. They are only used to sign requests here.
//
// When the update package is signed (scripts/build-release.mjs), its platform
// is also entered in the preview channel's manifest, updates/preview/latest.json,
// which installed copies check. Another version's platforms are dropped; this
// version's other platform stays. Options:
//   --notes <file>      what's new, shown in the app (default .release/UPDATE_NOTES.md)
//   --rollout <0-100>   share of devices offered the update (default: unchanged, else 100)
//   --manifest-only     only change the manifest's notes or rollout, e.g. --rollout 0 to stop

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { signatureV4 } from '../server/src/oss.mjs';

const BUCKET = process.env.DOWNLOAD_BUCKET ?? 'soundingx-download-package';
const REGION = process.env.DOWNLOAD_REGION ?? 'cn-beijing';
const PREFIX = process.env.DOWNLOAD_PREFIX ?? 'scientify';
const HOST = `${BUCKET}.oss-${REGION}.aliyuncs.com`;
// The address built into release builds (src-tauri/tauri.updater.conf.json).
const MANIFEST = `${PREFIX}/updates/preview/latest.json`;
// The website's download buttons point at these names under latest/.
const LATEST = {
  windows_x64: 'Scientify_windows_x64_setup.exe',
  macos_arm64: 'Scientify_macos_arm64.dmg',
};
// The updater's names for the platforms.
const TARGETS = { windows_x64: 'windows-x86_64', macos_arm64: 'darwin-aarch64' };
const TYPES = {
  '.exe': 'application/octet-stream',
  '.dmg': 'application/x-apple-diskimage',
  '.gz': 'application/gzip',
  '.json': 'application/json; charset=utf-8',
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

async function upload(file, key, keys, body = readFileSync(file)) {
  const type = TYPES[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream';
  const { url, headers } = signedPut(key, type, keys);
  const response = await fetch(url, { method: 'PUT', headers, body });
  if (!response.ok)
    throw new Error(
      `Upload of ${key} failed: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`,
    );
  // Anyone must be able to download it, as the website's buttons do.
  // Uncompressed, or OSS answers text types without a length.
  const check = await fetch(`https://${HOST}/${encodedPath(key)}`, {
    method: 'HEAD',
    headers: { 'accept-encoding': 'identity' },
  });
  const size = Number(check.headers.get('content-length'));
  if (!check.ok || size !== body.length)
    throw new Error(
      `${key} is not publicly readable at the uploaded size (HTTP ${check.status}, ${size} bytes).`,
    );
  console.log(`  ${key}  ${(body.length / 1024 / 1024).toFixed(1)} MB`);
}

/** The manifest installed copies check now, or null before the first update. */
async function currentManifest() {
  const response = await fetch(`https://${HOST}/${MANIFEST}`, { cache: 'no-store' });
  if (response.status === 404 || response.status === 403) return null;
  if (!response.ok) throw new Error(`Reading ${MANIFEST} failed: HTTP ${response.status}`);
  return response.json();
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

/** Enters `platforms` (updater target → url and signature) for `version` in the manifest. */
async function publishManifest(version, platforms, keys) {
  const current = await currentManifest();
  const same = current?.version === version;
  if (!same && !Object.keys(platforms).length)
    throw new Error(`The manifest is for ${current?.version ?? 'no version'}, not ${version}.`);
  const notesFile = option('--notes') ?? join(directory, 'UPDATE_NOTES.md');
  const notes = existsSync(notesFile)
    ? readFileSync(notesFile, 'utf8').trim()
    : same
      ? current.notes
      : `Scientify ${version}`;
  const rolloutOption = option('--rollout');
  const rollout =
    rolloutOption !== undefined ? Number(rolloutOption) : same ? (current.rollout ?? 100) : 100;
  if (!Number.isInteger(rollout) || rollout < 0 || rollout > 100)
    throw new Error('--rollout takes a whole number from 0 to 100.');
  const manifest = {
    version,
    notes,
    pub_date: same && current.pub_date ? current.pub_date : new Date().toISOString(),
    rollout,
    platforms: { ...(same ? current.platforms : {}), ...platforms },
  };
  const body = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Update manifest (${Object.keys(manifest.platforms).join(', ')}, ${rollout}%):`);
  await upload('latest.json', MANIFEST, keys, body);
}

const directory = '.release';
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const keys = credentials();
// Platforms named on the command line (windows_x64, macos_arm64) limit the upload to them.
const only = process.argv
  .slice(2)
  .filter(
    (arg, index, args) =>
      !arg.startsWith('--') && !['--notes', '--rollout'].includes(args[index - 1]),
  );
if (process.argv.includes('--manifest-only')) {
  await publishManifest(version, {}, keys);
  process.exit(0);
}
const staged = readdirSync(directory).filter(
  (name) =>
    /\.(exe|dmg)$/.test(name) &&
    name.includes(version) &&
    (!only.length || only.some((label) => name.includes(label))),
);
if (!staged.length)
  throw new Error(`No ${version} installer in ${directory}; run scripts/stage-release.mjs first.`);
const updates = {};
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
  // Windows updates with the installer itself; macOS with the app as a .tar.gz.
  const update = label === 'macos_arm64' ? `Scientify_${version}_${label}.app.tar.gz` : name;
  if (!existsSync(join(directory, `${update}.sig`))) {
    console.log(`  no ${update}.sig: not offered as an update`);
    continue;
  }
  if (update !== name)
    await upload(join(directory, update), `${PREFIX}/${version}/${update}`, keys);
  updates[TARGETS[label]] = {
    signature: readFileSync(join(directory, `${update}.sig`), 'utf8').trim(),
    url: `https://${HOST}/${encodedPath(`${PREFIX}/${version}/${update}`)}`,
  };
}
if (Object.keys(updates).length) await publishManifest(version, updates, keys);
console.log(`Published to https://${HOST}/${PREFIX}/`);
