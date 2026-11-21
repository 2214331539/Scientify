import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';
import { download } from './download.mjs';

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

// The engine ships as upstream's whole package, not the bare executable: codex finds the
// code-mode host next to itself in bin/, the Windows sandbox helpers in codex-resources/
// and ripgrep in codex-path/ through codex-package.json. Models that only use tools through
// code mode cannot run a single command without the host. The voice components are left out.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = join(root, 'src-tauri', 'release-resources', 'codex');
const manifestFile = join(packageDir, 'codex-package.json');
const engine = join(packageDir, 'bin', `codex${suffix}`);
const protocolDir = join(root, 'src', 'generated', 'agent-protocol');
const protocolStamp = join(protocolDir, 'VERSION');
const release = `https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}`;
const asset = `codex-package-${TRIPLE}`;
// Windows' own bsdtar reads drive-letter paths and zstd; Git's GNU tar does neither.
const tar =
  process.platform === 'win32'
    ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';

function stampedVersion(file) {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

function manifest(dir = packageDir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'codex-package.json'), 'utf8'));
  } catch {
    return null;
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
function generateProtocol(path) {
  const result = spawnSync(path, ['app-server', 'generate-ts', '--out', protocolDir], {
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error('failed to generate agent protocol bindings');
  writeFileSync(protocolStamp, `${CODEX_VERSION}\n`);
  console.log('Agent protocol bindings ready.');
}

function untar(archive, into, gzip) {
  const result = spawnSync(
    tar,
    [gzip ? '-xzf' : '-xf', archive, '-C', into, '--exclude', 'codex-resources/voice'],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) throw new Error(`could not unpack ${archive}`);
}

/** Download and unpack the package into a staging folder; the live one is replaced at the end. */
function fetchPackage(staging) {
  const archive = join(dirname(packageDir), `${asset}.download`);
  try {
    try {
      console.log(`Downloading codex ${CODEX_VERSION} package (compressed)...`);
      download(`${release}/${asset}.tar.zst`, `${archive}.zst`);
      // Node has zstd from 22.15; decompress first so any tar can read the result.
      writeFileSync(`${archive}.tar`, zstdDecompressSync(readFileSync(`${archive}.zst`)));
      untar(`${archive}.tar`, staging, false);
    } catch (error) {
      console.warn(`Zstandard package unusable (${error.message}); using the gzip archive.`);
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true });
      download(`${release}/${asset}.tar.gz`, `${archive}.tar.gz`);
      untar(`${archive}.tar.gz`, staging, true);
    }
  } finally {
    for (const ext of ['.zst', '.tar', '.tar.gz']) rmSync(`${archive}${ext}`, { force: true });
  }
}

async function main() {
  const current = manifest();
  if (current?.version === CODEX_VERSION && current?.target === TRIPLE && existsSync(engine)) {
    console.log(
      `Agent engine ready: codex ${CODEX_VERSION} (${(statSync(engine).size / 1024 / 1024).toFixed(1)} MB, with its helpers)`,
    );
    if (stampedVersion(protocolStamp) === CODEX_VERSION) return;
    mkdirSync(protocolDir, { recursive: true });
    generateProtocol(engine);
    return;
  }
  const staging = `${packageDir}.staging`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  fetchPackage(staging);
  const unpacked = manifest(staging);
  if (unpacked?.version !== CODEX_VERSION || unpacked?.target !== TRIPLE)
    throw new Error(`the downloaded package is not codex ${CODEX_VERSION} for ${TRIPLE}`);
  const stagedEngine = join(staging, unpacked.entrypoint);
  if (!existsSync(stagedEngine) || statSync(stagedEngine).size < 1024 * 1024)
    throw new Error('the downloaded package has no usable engine');
  const version = verify(stagedEngine);
  rmSync(packageDir, { recursive: true, force: true });
  renameSync(staging, packageDir);
  console.log(`Agent engine ready: ${version} (package with code-mode host and helpers)`);
  mkdirSync(protocolDir, { recursive: true });
  generateProtocol(engine);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
