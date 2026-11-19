import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Full-text translation (BabelDOC through pdf2zh-next) ships in the installer: a
// standalone Python with the pinned packages, and BabelDOC's fonts, layout model and
// tokenizer data, in src-tauri/release-resources/babeldoc. The app runs it from
// there and never installs anything at run time. uv (prepare-uv.mjs) builds it.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'scripts', 'babeldoc.json'), 'utf8'));
const output = join(root, 'src-tauri', 'release-resources', 'babeldoc');
const cache = join(root, 'node_modules', '.cache', 'scientify-babeldoc');
const stampFile = join(output, 'scientify-babeldoc.json');
const windows = process.platform === 'win32';
const triple = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
}[`${process.platform}-${process.arch}`];

function size(directory) {
  let bytes = 0;
  let files = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const inner = size(path);
      bytes += inner.bytes;
      files += inner.files;
    } else if (entry.isFile()) {
      bytes += statSync(path).size;
      files += 1;
    }
  }
  return { bytes, files };
}
function ready(note = '') {
  const { bytes, files } = size(output);
  console.log(
    `Full-text translation engine ready${note}: ${(bytes / 1024 / 1024).toFixed(0)} MB, ${files} files`,
  );
}

// Test-only builds (CI checks) may skip the engine; the app then simply never translates.
if (process.env.SCIENTIFY_SKIP_BABELDOC === '1' || !triple) {
  if (!existsSync(stampFile)) {
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, 'README.txt'), 'Full-text translation is not part of this build.\n');
  }
  console.log('Full-text translation engine skipped for this build.');
  process.exit(0);
}

const stamp = createHash('sha256')
  .update(JSON.stringify(manifest))
  .update(readFileSync(fileURLToPath(import.meta.url)))
  .update(triple)
  .digest('hex');
const executable = windows ? 'python/python.exe' : 'python/bin/python3.11';
if (existsSync(stampFile) && existsSync(join(output, executable))) {
  const current = JSON.parse(readFileSync(stampFile, 'utf8'));
  if (current.stamp === stamp) {
    ready();
    process.exit(0);
  }
}

const uv = join(root, 'src-tauri', 'binaries', `uv-${triple}${windows ? '.exe' : ''}`);
if (!existsSync(uv)) {
  const fetched = spawnSync(process.execPath, [join(root, 'scripts', 'prepare-uv.mjs')], {
    stdio: 'inherit',
  });
  if (fetched.status !== 0 || !existsSync(uv))
    throw new Error('uv is required to build the engine');
}
// Mirrors reachable from mainland China go first on a developer's machine; CI runners abroad
// use the upstream defaults first.
const mirrorFirst = !process.env.CI;
function run(command, args, { env = {}, mirror } = {}) {
  const attempts = mirror ? (mirrorFirst ? [true, false] : [false, true]) : [false];
  for (const useMirror of attempts) {
    const result = spawnSync(command, args, {
      stdio: 'inherit',
      windowsHide: true,
      env: {
        ...process.env,
        UV_CACHE_DIR: join(cache, 'uv'),
        UV_NO_CONFIG: '1',
        UV_LINK_MODE: 'copy',
        UV_PYTHON_INSTALL_DIR: join(cache, 'pythons'),
        VIRTUAL_ENV: '',
        ...env,
        ...(useMirror ? { [mirror[0]]: mirror[1] } : {}),
      },
    });
    if (result.status === 0) return;
  }
  throw new Error(`${relative(root, command)} ${args.slice(0, 2).join(' ')} failed`);
}

const staging = `${output}.staging`;
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

console.log(`Building the full-text translation engine (Python ${manifest.python})...`);
run(uv, ['python', 'install', manifest.python, '--no-bin'], {
  mirror: ['UV_PYTHON_INSTALL_MIRROR', manifest.mirrors.python],
});
const installed = readdirSync(join(cache, 'pythons')).find(
  (name) =>
    name.startsWith(`cpython-${manifest.python}-`) &&
    !lstatSync(join(cache, 'pythons', name)).isSymbolicLink(),
);
if (!installed) throw new Error(`Python ${manifest.python} was not installed`);
// A standalone Python is relocatable, so the packages go straight into a copy of it.
cpSync(join(cache, 'pythons', installed), join(staging, 'python'), {
  recursive: true,
  verbatimSymlinks: true,
});
const python = join(staging, executable);
run(uv, ['pip', 'install', '--python', python, '--break-system-packages', ...manifest.packages], {
  mirror: ['UV_DEFAULT_INDEX', manifest.mirrors.packages],
});
// pdf2zh-next's web interface and the other translation services are never loaded.
run(uv, ['pip', 'uninstall', '--python', python, '--break-system-packages', ...manifest.remove]);
run(python, ['-I', '-c', manifest.imports.map((name) => `import ${name}`).join('; ')]);

console.log("Downloading BabelDOC's fonts, layout model and tokenizer data...");
// The download cache outlives a build, and BabelDOC skips files it already verified, so
// a timeout on a slow connection only costs another round.
const home = join(cache, 'home');
mkdirSync(home, { recursive: true });
for (let round = 1; ; round++) {
  try {
    run(python, ['-I', '-c', 'from babeldoc.assets.assets import warmup; warmup()'], {
      env: { HOME: home, USERPROFILE: home, PYTHONUTF8: '1' },
    });
    break;
  } catch (error) {
    if (round === 5) throw error;
    console.log(`Asset download interrupted; trying again (${round}/4)...`);
  }
}
const downloaded = join(home, '.cache', 'babeldoc');
mkdirSync(join(staging, 'assets'), { recursive: true });
for (const name of ['fonts', 'models', 'cmap', 'tiktoken']) {
  if (existsSync(join(downloaded, name)))
    cpSync(join(downloaded, name), join(staging, 'assets', name), { recursive: true });
}
// Only the fonts BabelDOC sets the target language in; another one would be fetched on demand.
const fonts = spawnSync(
  python,
  [
    '-I',
    '-c',
    `from babeldoc.assets.embedding_assets_metadata import get_font_family as f; g = f(${JSON.stringify(manifest.language)}); print(*sorted({n for k in g for n in g[k]}), sep=chr(10))`,
  ],
  { encoding: 'utf8', windowsHide: true },
);
if (fonts.status !== 0) throw new Error(`Unable to list the fonts for ${manifest.language}`);
const needed = new Set(fonts.stdout.split(/\r?\n/).filter(Boolean));
for (const name of readdirSync(join(staging, 'assets', 'fonts')))
  if (!needed.has(name)) rmSync(join(staging, 'assets', 'fonts', name), { force: true });
if (readdirSync(join(staging, 'assets', 'fonts')).length !== needed.size)
  throw new Error('A font BabelDOC needs was not downloaded');

// Parts of Python that translation never uses: the GUI toolkit, the test suite, headers.
for (const path of manifest.prune[windows ? 'win32' : 'darwin'])
  rmSync(join(staging, 'python', path), { recursive: true, force: true });
if (!windows) {
  // Only the interpreter itself; the other entries are links or scripts with build paths.
  for (const name of readdirSync(join(staging, 'python', 'bin')))
    if (name !== 'python3.11') rmSync(join(staging, 'python', 'bin', name), { force: true });
}
function clean(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__pycache__') rmSync(path, { recursive: true, force: true });
      else clean(path);
    } else if (entry.name.endsWith('.whl') || /^opencv_videoio_ffmpeg/.test(entry.name))
      // Leftover wheels, and OpenCV's video codecs (papers are images, never video).
      rmSync(path, { force: true });
  }
}
// The app keeps compiled modules in its data folder, never inside the installation.
clean(join(staging, 'python'));
run(python, ['-I', '-B', '-c', manifest.imports.map((name) => `import ${name}`).join('; ')]);

writeFileSync(
  join(staging, 'scientify-babeldoc.json'),
  `${JSON.stringify({ stamp, executable, python: manifest.python, packages: manifest.packages }, null, 2)}\n`,
);
rmSync(output, { recursive: true, force: true });
renameSync(staging, output);
ready(' (built)');
