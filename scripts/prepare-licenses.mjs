import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'src-tauri', 'release-resources', 'licenses');
mkdirSync(output, { recursive: true });

function runJson(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32' && command === 'pnpm',
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed: ${result.error?.message || result.stderr}`);
  }
  return JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
}

function noticeFiles(directory, depth = 0) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (
      entry.isFile() &&
      /^(licen[cs]e|copying|copyright|notice|authors)([._-]|$)/i.test(entry.name)
    ) {
      files.push(join(directory, entry.name));
    } else if (depth < 2 && entry.isDirectory() && /^(licenses?|legal)$/i.test(entry.name)) {
      files.push(...noticeFiles(join(directory, entry.name), depth + 1));
    }
  }
  return files.sort();
}

const records = [];
const missing = [];
const overrides = JSON.parse(
  readFileSync(join(root, 'docs/licenses/upstream/sources.json'), 'utf8'),
);
const npm = runJson('pnpm', ['licenses', 'list', '--json']);
const npmPackages = Object.values(npm)
  .flat()
  .flatMap((dependency) =>
    dependency.paths.map((path) => ({
      ...JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')),
      path,
    })),
  );
function collect(ecosystem, name, version, license, directory, source, declared) {
  const files = noticeFiles(directory);
  if (declared) {
    const path = resolve(directory, declared);
    if (relative(directory, path).startsWith('..'))
      throw new Error(`External license path: ${name}`);
    if (existsSync(path) && !files.includes(path)) files.push(path);
  }
  const override = overrides[`${ecosystem}:${name}@${version}`];
  const notices = files.map((file) => ({
    file: relative(directory, file).replaceAll('\\', '/'),
    text: readFileSync(file, 'utf8'),
  }));
  if (!notices.length && ecosystem === 'npm') {
    const parentName = name.startsWith('@esbuild/')
      ? 'esbuild'
      : name.startsWith('@rollup/rollup-')
        ? 'rollup'
        : name.startsWith('@napi-rs/canvas-')
          ? '@napi-rs/canvas'
          : name.startsWith('@tauri-apps/cli-')
            ? '@tauri-apps/cli'
            : null;
    const parent = npmPackages.find((item) => item.name === parentName && item.version === version);
    if (parent)
      notices.push(
        ...noticeFiles(parent.path).map((file) => ({
          file: `${parent.name}/${relative(parent.path, file).replaceAll('\\', '/')}`,
          text: readFileSync(file, 'utf8'),
        })),
      );
  }
  if (!notices.length && override) {
    notices.push({
      file: override.file,
      text: readFileSync(join(root, 'docs/licenses/upstream', override.file), 'utf8'),
    });
    source = override.source;
  }
  if (!notices.length) missing.push(`${ecosystem}:${name}@${version}`);
  records.push({
    ecosystem,
    name,
    version,
    license,
    source,
    notices,
  });
}

for (const dependency of Object.values(npm).flat()) {
  for (const path of dependency.paths) {
    const manifest = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
    collect(
      'npm',
      manifest.name,
      manifest.version,
      dependency.license,
      path,
      `https://www.npmjs.com/package/${manifest.name}/v/${manifest.version}`,
    );
  }
}
const cargo = runJson('cargo', [
  'metadata',
  '--locked',
  '--format-version',
  '1',
  '--filter-platform',
  'x86_64-pc-windows-msvc',
]);
for (const dependency of cargo.packages) {
  if (cargo.workspace_members.includes(dependency.id)) continue;
  collect(
    'cargo',
    dependency.name,
    dependency.version,
    dependency.license,
    dirname(dependency.manifest_path),
    dependency.repository || `https://crates.io/crates/${dependency.name}/${dependency.version}`,
    dependency.license_file,
  );
}
if (missing.length) throw new Error(`Dependencies without notice files: ${missing.join(', ')}`);

records.sort((a, b) =>
  `${a.ecosystem}:${a.name}:${a.version}`.localeCompare(`${b.ecosystem}:${b.name}:${b.version}`),
);
const unique = [
  ...new Map(
    records.map((record) => [`${record.ecosystem}:${record.name}:${record.version}`, record]),
  ).values(),
];
const text = [
  'Scientify third-party license texts',
  'Generated from the installed pnpm lockfile dependencies and Cargo metadata for Windows x64.',
  'Build and development dependencies may be included. Each upstream notice retains its own terms.',
  '',
  ...unique.map((record) =>
    [
      `=== ${record.ecosystem}: ${record.name} ${record.version} ===`,
      `License expression: ${record.license || 'See upstream license files'}`,
      `Source: ${record.source}`,
      ...record.notices.map((notice) => `--- ${notice.file} ---\n${notice.text}`),
    ].join('\n\n'),
  ),
].join('\n\n');
writeFileSync(join(output, 'THIRD_PARTY_LICENSES.txt'), text);
writeFileSync(
  join(output, 'dependencies.json'),
  JSON.stringify(
    unique.map(({ notices, ...record }) => ({
      ...record,
      noticeFiles: notices.map((notice) => notice.file),
    })),
    null,
    2,
  ) + '\n',
);
for (const [source, name] of [
  ['LICENSE', 'Scientify-LICENSE'],
  ['NOTICE', 'Scientify-NOTICE'],
  ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
  ['docs/licenses/codex-LICENSE', 'codex-LICENSE'],
  ['docs/licenses/codex-NOTICE', 'codex-NOTICE'],
])
  cpSync(join(root, source), join(output, name));
const pdf = join(root, 'node_modules', 'pdfjs-dist');
for (const folder of ['standard_fonts', 'cmaps', 'wasm', 'iccs']) {
  for (const file of noticeFiles(join(pdf, folder))) {
    cpSync(
      file,
      join(
        output,
        `pdfjs-${folder}-${relative(join(pdf, folder), file).replaceAll(/[\\/]/g, '-')}`,
      ),
    );
  }
}
console.log(`Release notices ready: ${unique.length} dependencies, PDF assets and bundled Agent.`);
