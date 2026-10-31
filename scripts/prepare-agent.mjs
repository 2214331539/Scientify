import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

// Codex is redistributed as an unmodified upstream release artifact. This version
// is the single source of truth; bump it together with THIRD_PARTY_NOTICES.
const CODEX_VERSION = process.env.SCIENTIFY_CODEX_VERSION || '0.158.0';
export function engineTarget(platform, architecture, override) {
  const triple =
    override ||
    {
      'win32-x64': 'x86_64-pc-windows-msvc',
      'darwin-arm64': 'aarch64-apple-darwin',
      'darwin-x64': 'x86_64-apple-darwin',
    }[`${platform}-${architecture}`];
  if (!['x86_64-pc-windows-msvc', 'aarch64-apple-darwin', 'x86_64-apple-darwin'].includes(triple))
    throw new Error(`Unsupported Agent target: ${triple || `${platform}-${architecture}`}`);
  return { triple, suffix: triple.endsWith('windows-msvc') ? '.exe' : '' };
}
const { triple: TRIPLE, suffix } = engineTarget(
  process.platform,
  process.arch,
  process.env.SCIENTIFY_CODEX_TRIPLE,
);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'src-tauri', 'binaries');
const binary = join(target, `codex-${TRIPLE}${suffix}`);
const stamp = join(target, `codex-${TRIPLE}.version`);
const legacyStamp = join(target, 'codex.version');
const protocolDir = join(root, 'src', 'generated', 'agent-protocol');
const protocolStamp = join(protocolDir, 'VERSION');
const tag = `rust-v${CODEX_VERSION}`;
const asset = `codex-${TRIPLE}${suffix}`;
const release = `https://github.com/openai/codex/releases/download/${tag}`;

function stampedVersion(file = stamp) {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * Node's fetch ignores the WinINET proxy that many Windows networks require, and
 * curl only reads proxy environment variables. PowerShell's Invoke-WebRequest is
 * the one downloader that honours the system proxy, so prefer it on Windows.
 * The URL travels through the environment to keep it out of the command string.
 */
function download(url, destination) {
  const env = { ...process.env, SCIENTIFY_DL_URL: url, SCIENTIFY_DL_OUT: destination };
  const command =
    process.platform === 'win32'
      ? [
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri $env:SCIENTIFY_DL_URL -OutFile $env:SCIENTIFY_DL_OUT -MaximumRedirection 5",
          ],
        ]
      : ['curl', ['-fsSL', '--retry', '3', '-o', destination, url]];
  const result = spawnSync(command[0], command[1], { stdio: 'inherit', env });
  if (result.error) throw new Error(`${command[0]} unavailable: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command[0]} exited with status ${result.status}`);
  if (!existsSync(destination)) throw new Error(`${command[0]} produced no file`);
}

/** Node has zstd from 22.15; bsdtar ships with zstd support on Windows 10+. */
function extractZstd(archive) {
  const bytes = readFileSync(archive);
  try {
    return zstdDecompressSync(bytes);
  } catch {
    const result = spawnSync('tar', ['-xf', archive, '-C', target], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error('no zstd extractor available (node or bsdtar)');
    const extracted = join(target, asset);
    if (!existsSync(extracted)) throw new Error(`archive did not contain ${asset}`);
    const output = readFileSync(extracted);
    rmSync(extracted, { force: true });
    return output;
  }
}

function verify(path) {
  const result = spawnSync(path, ['--version'], { encoding: 'utf8', timeout: 30000 });
  if (result.status !== 0)
    throw new Error(`agent engine did not report a version: ${result.stderr}`);
  return String(result.stdout).trim().split('\n')[0];
}

/**
 * Generate the protocol bindings from the pinned engine so `platform/agent.ts`
 * cannot drift from the transport. The output is derived code and stays out of
 * version control, mirroring how the PDF.js assets are prepared.
 */
function generateProtocol(engine) {
  const result = spawnSync(engine, ['app-server', 'generate-ts', '--out', protocolDir], {
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error('failed to generate agent protocol bindings');
  writeFileSync(protocolStamp, `${CODEX_VERSION}\n`);
  console.log('Agent protocol bindings ready.');
}

async function main() {
  if (
    existsSync(binary) &&
    (stampedVersion() === CODEX_VERSION || stampedVersion(legacyStamp) === CODEX_VERSION)
  ) {
    console.log(
      `Agent engine ready: codex ${CODEX_VERSION} (${(statSync(binary).size / 1024 / 1024).toFixed(1)} MB)`,
    );
    if (stampedVersion(protocolStamp) === CODEX_VERSION) return;
    mkdirSync(protocolDir, { recursive: true });
    generateProtocol(binary);
    return;
  }
  mkdirSync(target, { recursive: true });
  const archive = join(target, 'codex.download.zst');
  let bytes;
  try {
    console.log(`Downloading codex ${CODEX_VERSION} (compressed)...`);
    download(`${release}/${asset}.zst`, archive);
    bytes = extractZstd(archive);
  } catch (error) {
    // The raw executable is larger but needs no extractor, so a missing zstd
    // implementation must never block a build.
    console.warn(`Zstandard asset unusable (${error.message}); using the fallback archive.`);
    if (suffix) {
      download(`${release}/${asset}`, binary);
      bytes = readFileSync(binary);
    } else {
      const tarball = join(target, `codex-${TRIPLE}.download.tar.gz`);
      try {
        download(`${release}/${asset}.tar.gz`, tarball);
        const extracted = spawnSync('tar', ['-xzf', tarball, '-C', target, asset], {
          stdio: 'inherit',
        });
        if (extracted.status !== 0) throw new Error('Unable to extract the macOS Agent');
        bytes = readFileSync(binary);
      } finally {
        rmSync(tarball, { force: true });
      }
    }
  } finally {
    rmSync(archive, { force: true });
  }
  if (bytes.length < 1024 * 1024) throw new Error('downloaded artifact is implausibly small');
  writeFileSync(binary, bytes);
  if (!suffix) chmodSync(binary, 0o755);
  const version = verify(binary);
  writeFileSync(stamp, `${CODEX_VERSION}\n`);
  console.log(`Agent engine ready: ${version} (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`);
  mkdirSync(protocolDir, { recursive: true });
  generateProtocol(binary);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
