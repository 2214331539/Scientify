import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { download } from './download.mjs';

// uv builds the full-text translation engine (BabelDOC) that ships in the installer
// (prepare-babeldoc.mjs). It is a build tool only and is not redistributed; the
// manifest pins the version and checksums.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'scripts', 'uv-assets.json'), 'utf8'));

function target() {
  const triple =
    process.env.SCIENTIFY_CODEX_TRIPLE ||
    {
      'win32-x64': 'x86_64-pc-windows-msvc',
      'darwin-arm64': 'aarch64-apple-darwin',
      'darwin-x64': 'x86_64-apple-darwin',
    }[`${process.platform}-${process.arch}`];
  const asset = Object.hasOwn(manifest.assets, triple ?? '') ? manifest.assets[triple] : null;
  if (!asset) return null;
  return { triple, suffix: triple.endsWith('windows-msvc') ? '.exe' : '', asset };
}

/** The system's own tar: on Windows the bsdtar in System32, which also reads zip files. */
function systemTar() {
  if (process.platform !== 'win32') return 'tar';
  const tar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  if (!existsSync(tar)) throw new Error('System32\\tar.exe is required to unpack uv');
  return tar;
}

function find(directory, name, depth = 2) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory() && depth > 0) {
      const found = find(path, name, depth - 1);
      if (found) return found;
    }
  }
  return null;
}

const platform = target();
if (!platform) {
  console.log(
    `uv: no build for ${process.platform}-${process.arch}; full-text translation is off.`,
  );
  process.exit(0);
}
const { triple, suffix, asset } = platform;
const binaries = join(root, 'src-tauri', 'binaries');
const binary = join(binaries, `uv-${triple}${suffix}`);
const stamp = join(binaries, `uv-${triple}.version`);
const ready = () =>
  console.log(
    `Translation setup tool ready: uv ${manifest.version} (${(statSync(binary).size / 1024 / 1024).toFixed(1)} MB)`,
  );
if (
  existsSync(binary) &&
  existsSync(stamp) &&
  readFileSync(stamp, 'utf8').trim() === manifest.version
) {
  ready();
  process.exit(0);
}
mkdirSync(binaries, { recursive: true });
const archive = join(binaries, `${asset.file}.download`);
const staging = join(binaries, `uv-${triple}.staging`);
try {
  console.log(`Downloading uv ${manifest.version}...`);
  download(
    `https://github.com/astral-sh/uv/releases/download/${manifest.version}/${asset.file}`,
    archive,
  );
  const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
  if (digest !== asset.sha256)
    throw new Error(`uv archive checksum mismatch: expected ${asset.sha256}, got ${digest}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const extracted = spawnSync(systemTar(), ['-xf', archive, '-C', staging], { stdio: 'inherit' });
  if (extracted.status !== 0) throw new Error('Unable to unpack the uv archive');
  const found = find(staging, `uv${suffix}`);
  if (!found || statSync(found).size < 1024 * 1024)
    throw new Error('The uv archive did not contain the tool');
  rmSync(binary, { force: true });
  renameSync(found, binary);
  if (!suffix) chmodSync(binary, 0o755);
} finally {
  rmSync(archive, { force: true });
  rmSync(staging, { recursive: true, force: true });
}
writeFileSync(stamp, `${manifest.version}\n`);
ready();
