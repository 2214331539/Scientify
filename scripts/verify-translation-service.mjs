// Exercises the packaged native app through its real pipes, using isolated data and fixture answers.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '..');
mkdirSync(join(root, '.test-artifacts'), { recursive: true });
const data = mkdtempSync(join(root, '.test-artifacts/yita-process-'));
const binary = join(
  root,
  'src-tauri/release-resources/yita',
  process.platform === 'win32' ? 'Yita.Desktop.exe' : 'Yita.Desktop',
);
const child = spawn(binary, [], {
  env: { ...process.env, SCIENTIFY_TRANSLATION_DATA: data },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});
let diagnostic = '';
child.stderr.setEncoding('utf8').on('data', (text) => {
  diagnostic += text;
});
const events = [];
const replies = new Map();
const closed = new Promise((resolve, reject) => {
  child.on('error', reject);
  child.on('exit', (code) => {
    for (const pending of replies.values())
      pending.reject(new Error(`Native app exited: ${code}; ${diagnostic}`));
    resolve(code);
  });
});
function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}
createInterface({ input: child.stdout }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type === 'reply') {
    const pending = replies.get(message.id);
    replies.delete(message.id);
    if (message.error) pending?.reject(new Error(message.error));
    else pending?.resolve(message.result);
  } else events.push(message);
});
let serial = 0;
async function command(action) {
  const id = String(++serial);
  const result = new Promise((resolve, reject) => replies.set(id, { resolve, reject }));
  send({ type: 'command', id, action });
  return Promise.race([
    result,
    delay(15000).then(() => {
      throw new Error(`Timeout: ${action.type}; ${diagnostic}`);
    }),
  ]);
}
async function event(predicate) {
  for (let n = 0; n < 100; n++) {
    const found = events.find(predicate);
    if (found) return found;
    await delay(50);
  }
  throw new Error(`Missing event; ${diagnostic}`);
}
try {
  const status = await command({
    type: 'configure',
    model: 'fixture-model',
    legacy: { enabled: false },
    language: 'zh-CN',
  });
  assert.equal(status.enabled, false);
  assert.equal(resolve(status.dataDirectory), data);
  await command({ type: 'translate', text: 'First isolated scientific fixture.' });
  const first = await event((m) => m.type === 'completion');
  assert.equal(first.body.model, 'fixture-model');
  assert.ok(first.body.messages.some((m) => m.content.includes('First isolated')));
  await command({ type: 'translate', text: 'Second isolated scientific fixture.' });
  await event((m) => m.type === 'cancel' && m.id === first.id);
  const second = await event((m) => m.type === 'completion' && m.id !== first.id);
  send({ type: 'delta', id: second.id, text: '第二段科学测试译文。' });
  send({ type: 'complete', id: second.id });
  await delay(200);
  const after = await command({ type: 'status' });
  assert.equal(after.popupCount, 1, 'unpinned popup is reused');
  const settings = readFileSync(join(data, 'desktop-settings.json'), 'utf8');
  assert.ok(
    !settings.includes('apiKey'),
    'host model secrets must not be persisted by the component',
  );
  child.stdin.end();
  assert.equal(
    await Promise.race([closed, delay(10000).then(() => 'timeout')]),
    0,
    'parent EOF must exit the component',
  );
  console.log(
    'Native packaged smoke passed: isolated data, real streaming pipes, superseded request cancellation, popup reuse, and EOF shutdown.',
  );
} finally {
  // Only this script-owned fixture process can be stopped; never the user's Scientify app.
  if (child.exitCode === null) child.kill();
}
