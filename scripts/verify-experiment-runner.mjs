import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

assert.equal(process.platform, 'win32', 'This verifies the Windows release runner.');
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executable = resolve(repository, process.argv[2] ?? 'target/release/scientify.exe');
const engine = join(repository, 'src-tauri/binaries/codex-x86_64-pc-windows-msvc.exe');
assert.ok(existsSync(executable), 'Build the release application first.');
assert.ok(existsSync(engine), 'Prepare the bundled Codex engine first.');
const directory = await mkdtemp(join(tmpdir(), 'scientify-release-runner-'));
const externalDirectory = await mkdtemp(join(repository, '.scientify-runner-boundary-'));
const root = join(directory, 'code');
const artifacts = join(directory, 'artifacts');
const control = join(artifacts, '.scientify');
const home = join(directory, 'codex');
await Promise.all([mkdir(root), mkdir(control, { recursive: true }), mkdir(home)]);
const outside = join(externalDirectory, 'outside.txt');
const script = join(root, 'experiment.mjs');
const request = join(control, 'request.json');
await writeFile(outside, 'unchanged');
await writeFile(
  script,
  `import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
console.log('begin');
await new Promise(resolve => setTimeout(resolve, 600));
let blocked = false;
try { writeFileSync(process.argv[2], 'changed'); } catch { blocked = true; }
if (!blocked) throw new Error('External write was allowed.');
console.log('outside-write-blocked');
await new Promise(resolve => setTimeout(resolve, 600));
writeFileSync(join(process.env.SCIENTIFY_RUN_DIR, 'metrics.json'), JSON.stringify({accuracy: 0.9}));
console.log('finished');
`,
);
await writeFile(
  request,
  JSON.stringify({ command: [process.execPath, script, outside], cwd: root }),
);
const child = spawn(
  engine,
  [
    'app-server',
    '--listen',
    'stdio://',
    '-c',
    'sandbox_mode="workspace-write"',
    '-c',
    'approval_policy="on-request"',
    '-c',
    'windows.sandbox="unelevated"',
    '-c',
    'features.memories=false',
  ],
  { cwd: root, env: { ...process.env, CODEX_HOME: home }, windowsHide: true },
);
let stderr = '';
child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-4000)));
const pending = new Map();
const notifications = [];
const lines = createInterface({ input: child.stdout });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id !== undefined && pending.has(message.id)) {
    const task = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(task.timer);
    if (message.error) task.reject(new Error(JSON.stringify(message.error)));
    else task.resolve(message.result);
  } else notifications.push(message);
});
const rejectPending = (error) => {
  for (const task of pending.values()) {
    clearTimeout(task.timer);
    task.reject(error);
  }
  pending.clear();
};
child.on('error', rejectPending);
child.on('exit', (code) => rejectPending(new Error(`Codex exited ${code}: ${stderr}`)));
let nextId = 0;
const call = (method, params, budget = 30000) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out: ${method}; ${stderr}`));
    }, budget);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let heartbeat;
const observed = new Set();
try {
  await call('initialize', {
    clientInfo: { name: 'scientify_release_verification', version: '0.3.0' },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  if ((await call('windowsSandbox/readiness', null)).status !== 'ready') {
    const setup = await call('windowsSandbox/setupStart', { mode: 'unelevated', cwd: root });
    if (setup.started) {
      const deadline = Date.now() + 180000;
      while (!notifications.some((item) => item.method === 'windowsSandbox/setupCompleted')) {
        assert.ok(Date.now() < deadline, `Sandbox setup timed out: ${stderr}`);
        await pause(100);
      }
      const completed = notifications.find(
        (item) => item.method === 'windowsSandbox/setupCompleted',
      );
      assert.equal(completed.params.success, true, JSON.stringify(completed.params));
    } else assert.equal((await call('windowsSandbox/readiness', null)).status, 'ready');
  }
  writeFileSync(join(control, 'heartbeat'), 'alive');
  heartbeat = setInterval(() => {
    writeFileSync(join(control, 'heartbeat'), 'alive');
    const log = join(control, 'output.log');
    if (existsSync(log)) observed.add(readFileSync(log, 'utf8'));
  }, 100);
  const result = await call('command/exec', {
    command: [executable, '--scientify-runner', request],
    processId: 'release-runner-fixture',
    cwd: root,
    disableTimeout: true,
    env: { SCIENTIFY_RUN_DIR: artifacts },
    sandboxPolicy: {
      type: 'workspaceWrite',
      writableRoots: [root, artifacts],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
  });
  const log = await readFile(join(control, 'output.log'), 'utf8');
  assert.equal(result.exitCode, 0, JSON.stringify({ result, log, stderr }));
  assert.match(log, /begin[\s\S]*outside-write-blocked[\s\S]*finished/);
  assert.ok(observed.size >= 2, 'Expected live output before command completion.');
  assert.equal((await readFile(outside, 'utf8')).trim(), 'unchanged');
  assert.deepEqual(JSON.parse(await readFile(join(artifacts, 'metrics.json'), 'utf8')), {
    accuracy: 0.9,
  });
  console.log(
    JSON.stringify({
      executable,
      sandbox: 'workspace-write',
      exitCode: result.exitCode,
      liveLogSnapshots: observed.size,
      metrics: { accuracy: 0.9 },
      externalWriteBlocked: true,
    }),
  );
} finally {
  clearInterval(heartbeat);
  writeFileSync(join(control, 'stop'), 'stop');
  child.stdin.end();
  if (child.exitCode === null) {
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      pause(3000).then(() => child.kill()),
    ]);
  }
  lines.close();
  await rm(directory, { recursive: true, force: true });
  await rm(externalDirectory, { recursive: true, force: true });
}
