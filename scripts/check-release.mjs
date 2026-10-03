import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

const tag = process.argv[2];
if (!/^v\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/.test(tag || '')) {
  throw new Error('Expected an existing version tag such as v0.3.0-alpha.1.');
}
const version = tag.slice(1);
const jsonVersion = (file) => JSON.parse(readFileSync(file, 'utf8')).version;
const cargoVersion = (file) => readFileSync(file, 'utf8').match(/^version\s*=\s*"([^"]+)"/m)?.[1];
for (const [file, value] of [
  ['package.json', jsonVersion('package.json')],
  ['src-tauri/tauri.conf.json', jsonVersion('src-tauri/tauri.conf.json')],
  ['src-tauri/Cargo.toml', cargoVersion('src-tauri/Cargo.toml')],
  ['crates/scientify-core/Cargo.toml', cargoVersion('crates/scientify-core/Cargo.toml')],
]) {
  if (value !== version) throw new Error(`${file}: ${value} does not match ${version}`);
}
execFileSync('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main'], { stdio: 'inherit' });
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const tagged = execFileSync('git', ['rev-parse', `${tag}^{commit}`], { encoding: 'utf8' }).trim();
if (head !== tagged) throw new Error('The checkout is not the tagged commit.');
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `version=${version}\nprerelease=${version.includes('-')}\n`,
  );
}
console.log(`Release ${tag}: versions agree; ${head} belongs to main.`);
