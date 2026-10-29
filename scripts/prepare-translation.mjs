import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'vendor/yita');
const output = join(root, 'src-tauri/release-resources/yita');
const rid =
  process.platform === 'win32'
    ? 'win-x64'
    : process.platform === 'darwin'
      ? `osx-${process.arch}`
      : null;
if (!rid) throw new Error('Yita selection translation currently supports Windows and macOS.');
const dotnet = process.env.SCIENTIFY_DOTNET ?? 'dotnet';
const fingerprint = createHash('sha256')
  .update(rid)
  .update(readFileSync(fileURLToPath(import.meta.url)));
function hashDirectory(path) {
  for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (['bin', 'obj', 'TestResults'].includes(entry.name)) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) hashDirectory(child);
    else fingerprint.update(child.slice(source.length)).update(readFileSync(child));
  }
}
hashDirectory(source);
for (const asset of [
  'public/brand/scientify-light.png',
  'public/brand/scientify-dark.png',
  'src-tauri/icons/icon.ico',
])
  fingerprint.update(asset).update(readFileSync(join(root, asset)));
const hash = fingerprint.digest('hex');
const stamp = join(output, 'scientify-source.sha256');
const exe = join(output, process.platform === 'win32' ? 'Yita.Desktop.exe' : 'Yita.Desktop');
function run(command, args) {
  const result = spawnSync(command, args, { cwd: source, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0)
    throw new Error(`${command} failed: ${result.error?.message ?? result.status}`);
}
function collectLicenses(project, dependencyFile, destination) {
  const assets = JSON.parse(
    readFileSync(join(source, 'src', project, 'obj/project.assets.json'), 'utf8'),
  );
  const dependencies = JSON.parse(readFileSync(join(output, dependencyFile), 'utf8'));
  const packages = new Map(
    Object.entries(assets.libraries)
      .filter(([, value]) => value.type === 'package')
      .map(([name, value]) => [name, value.path]),
  );
  for (const name of Object.keys(dependencies.libraries)) {
    if (name.startsWith('runtimepack.'))
      packages.set(name, name.slice('runtimepack.'.length).toLowerCase());
  }
  const inventory = [];
  function notices(path, relative = '') {
    return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
      const file = join(relative, entry.name);
      return entry.isDirectory()
        ? notices(join(path, entry.name), file)
        : /^(license|licence|copying|notice|third.party.notices)([.-]|$)/i.test(entry.name) ||
            entry.name.endsWith('.nuspec')
          ? [file]
          : [];
    });
  }
  for (const [name, path] of packages) {
    const directory = Object.keys(assets.packageFolders)
      .map((folder) => join(folder, path))
      .find(existsSync);
    if (!directory) throw new Error(`Missing restored package: ${name}`);
    const files = notices(directory);
    const target = join(destination, 'Packages', name);
    mkdirSync(target, { recursive: true });
    for (const file of files) {
      mkdirSync(dirname(join(target, file)), { recursive: true });
      cpSync(join(directory, file), join(target, file));
    }
    if (files.every((file) => file.endsWith('.nuspec'))) {
      const fallback = name.startsWith('Avalonia')
        ? 'Avalonia-MIT.txt'
        : name.startsWith('MicroCom.Runtime/')
          ? 'MicroCom-MIT.txt'
          : name.startsWith('Tmds.DBus.Protocol/')
            ? 'Tmds-DBus-MIT.txt'
            : null;
      if (!fallback) throw new Error(`Missing license text: ${name}`);
      cpSync(join(source, 'LICENSES', fallback), join(target, fallback));
      files.push(fallback);
    }
    inventory.push({ package: name, notices: files });
  }
  writeFileSync(join(destination, 'dependency-inventory.json'), JSON.stringify(inventory, null, 2));
}
if (!existsSync(exe) || !existsSync(stamp) || readFileSync(stamp, 'utf8') !== hash) {
  mkdirSync(output, { recursive: true });
  const publish = (project) =>
    run(dotnet, [
      'publish',
      `src/${project}/${project}.csproj`,
      '-c',
      'Release',
      '-r',
      rid,
      '--self-contained',
      'true',
      '-p:PublishSingleFile=false',
      '-o',
      output,
      '--nologo',
    ]);
  publish('Yita.Desktop');
  if (process.platform === 'win32') publish('Yita.Native.Windows.UIA.Worker');
  else run('bash', ['scripts/Build-Mac-Helper.sh', output]);
  cpSync(join(source, 'LICENSE'), join(output, 'Yita-LICENSE.txt'));
  cpSync(join(source, 'UPSTREAM.json'), join(output, 'Yita-UPSTREAM.json'));
  cpSync(join(source, 'NOTICE.md'), join(output, 'Yita-NOTICE.md'));
  cpSync(join(source, 'LICENSES'), join(output, 'Licenses'), { recursive: true });
  cpSync(
    join(source, 'src/Yita.App/Assets/Fonts/LICENSE-SourceSans.md'),
    join(output, 'Licenses/LICENSE-SourceSans.md'),
  );
  collectLicenses('Yita.Desktop', 'Yita.Desktop.deps.json', join(output, 'Licenses'));
  if (process.platform === 'win32')
    collectLicenses(
      'Yita.Native.Windows.UIA.Worker',
      'Yita.UIA.Worker.deps.json',
      join(output, 'Licenses/WindowsUIA'),
    );
  writeFileSync(stamp, hash);
}
// `tauri build --no-bundle` is also a supported local acceptance distribution.
const cargoTarget = resolve(root, process.env.CARGO_TARGET_DIR ?? 'target');
for (const mode of ['debug', 'release']) {
  const destination = join(cargoTarget, mode, 'yita');
  const destinationStamp = join(destination, 'scientify-source.sha256');
  if (!existsSync(destinationStamp) || readFileSync(destinationStamp, 'utf8') !== hash)
    cpSync(output, destination, { recursive: true });
}
console.log(`Yita translation component ready (${rid}); .NET is bundled for end users.`);
