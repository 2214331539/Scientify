// Builds this computer's installer for release: with the preview channel's
// update address (src-tauri/tauri.updater.conf.json) and signed with the
// update key, so installed copies can update themselves. Then stages it in
// .release/ for scripts/publish-installer.mjs.
//
//   node scripts/build-release.mjs
//
// The key is ~/.tauri/scientify-updater.key; its public half is in
// tauri.conf.json. Its password comes from TAURI_SIGNING_PRIVATE_KEY_PASSWORD,
// or on Windows from ~/.tauri/scientify-updater.password.dpapi. Without the key
// installed copies can no longer be updated: keep a copy somewhere safe.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const key = join(homedir(), '.tauri', 'scientify-updater.key');
const passwordFile = join(homedir(), '.tauri', 'scientify-updater.password.dpapi');
const mac = process.platform === 'darwin';

if (!existsSync(key)) throw new Error(`No update signing key at ${key}.`);

function password() {
  if (process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD !== undefined)
    return process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
  if (process.platform !== 'win32' || !existsSync(passwordFile))
    throw new Error('Set TAURI_SIGNING_PRIVATE_KEY_PASSWORD to the update key password.');
  const script =
    'Add-Type -AssemblyName System.Security; [Console]::Out.Write([Text.Encoding]::UTF8.GetString(' +
    '[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($env:SCIENTIFY_KEY_PASSWORD_FILE), $null, "CurrentUser")))';
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, SCIENTIFY_KEY_PASSWORD_FILE: passwordFile },
    encoding: 'utf8',
  });
}

const env = {
  ...process.env,
  TAURI_SIGNING_PRIVATE_KEY: key,
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password(),
};
const tauri = join('node_modules', '@tauri-apps', 'cli', 'tauri.js');
const build = spawnSync(
  process.execPath,
  [
    tauri,
    'build',
    '--bundles',
    mac ? 'app,dmg' : 'nsis',
    '--config',
    'src-tauri/tauri.updater.conf.json',
    '--',
    '--locked',
  ],
  { stdio: 'inherit', env },
);
if (build.status !== 0) process.exit(build.status ?? 1);
const stage = spawnSync(process.execPath, ['scripts/stage-release.mjs'], { stdio: 'inherit' });
process.exit(stage.status ?? 1);
