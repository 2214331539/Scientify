import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

// Real bundled Codex, isolated data, deterministic local Responses endpoint.
// No external model, real API key, shell command, or user workspace is used.
const scratch = resolve('target/agent-protocol-tests');
await mkdir(scratch, { recursive: true });
const root = await mkdtemp(join(scratch, 'run-'));
const home = join(root, 'home');
const work = join(root, 'workspace');
await Promise.all([mkdir(home), mkdir(work)]);
const engines = [];
const requests = [];
const server = createServer(async (request, response) => {
  if (!request.url?.endsWith('/responses')) {
    response.writeHead(404).end();
    return;
  }
  let body = '';
  for await (const chunk of request) body += chunk;
  const input = JSON.parse(body);
  requests.push(input.model);
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const id = `response-${requests.length}`;
  const item = {
    id: `message-${requests.length}`,
    type: 'message',
    role: 'assistant',
    status: 'in_progress',
    content: [],
  };
  const event = (type, fields) =>
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
  event('response.created', {
    response: { id, object: 'response', status: 'in_progress', output: [] },
  });
  event('response.output_item.added', { output_index: 0, item });
  event('response.content_part.added', {
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    part: { type: 'output_text', text: '', annotations: [] },
  });
  event('response.output_text.delta', {
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    delta: `${input.model}: `,
  });
  if (input.model === 'slow-test') return; // Interrupt this live stream after the other chat completes.
  await new Promise((done) => setTimeout(done, 80));
  const text = `${input.model}: completed`;
  event('response.output_text.delta', {
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    delta: 'completed',
  });
  const complete = {
    ...item,
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
  event('response.output_item.done', { output_index: 0, item: complete });
  event('response.completed', {
    response: {
      id,
      object: 'response',
      status: 'completed',
      output: [complete],
      usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
    },
  });
  response.end();
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
const binary = resolve('src-tauri/binaries/codex-x86_64-pc-windows-msvc.exe');
function start(model) {
  const overrides = [
    'features.memories=false',
    'features.external_agent_memory_import=false',
    `model=${JSON.stringify(model)}`,
    'model_provider="scientify"',
    'model_providers.scientify.name="Scientify"',
    `model_providers.scientify.base_url=${JSON.stringify(endpoint)}`,
    'model_providers.scientify.wire_api="responses"',
    'model_providers.scientify.requires_openai_auth=false',
    'model_providers.scientify.env_key="SCIENTIFY_AGENT_KEY"',
  ];
  const child = spawn(
    binary,
    ['app-server', '--listen', 'stdio://', ...overrides.flatMap((value) => ['-c', value])],
    {
      cwd: work,
      env: { ...process.env, CODEX_HOME: home, SCIENTIFY_AGENT_KEY: 'local-test-only' },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const exited = new Promise((done) => child.once('exit', done));
  const pending = new Map();
  const events = [];
  let sequence = 0;
  let diagnostics = '';
  child.stderr.on('data', (chunk) => {
    diagnostics = (diagnostics + chunk).slice(-2000);
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    if (value.id != null && !value.method) {
      const entry = pending.get(value.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(value.id);
      if (value.error) entry.reject(new Error(JSON.stringify(value.error)));
      else entry.resolve(value.result);
    } else events.push(value);
  });
  child.on('exit', () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`Engine exited: ${diagnostics}`));
    }
    pending.clear();
  });
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timeout: ${method}; ${diagnostics}`));
      }, 20000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  const wait = async (predicate) => {
    const until = Date.now() + 20000;
    while (Date.now() < until) {
      const event = events.find(predicate);
      if (event) return event;
      await new Promise((done) => setTimeout(done, 20));
    }
    throw new Error(
      `Event timeout: ${events.map((event) => event.method).join(', ')}; ${diagnostics}`,
    );
  };
  const engine = { child, rpc, wait, events, exited };
  engines.push(engine);
  return engine;
}
async function initialized(model) {
  const engine = start(model);
  await engine.rpc('initialize', {
    clientInfo: { name: 'scientify-test', title: 'Scientify test', version: '0.0.0' },
    capabilities: { experimentalApi: false },
  });
  engine.child.stdin.write('{"method":"initialized","params":{}}\n');
  return engine;
}
const params = {
  cwd: work,
  modelProvider: 'scientify',
  approvalPolicy: 'never',
  sandbox: 'read-only',
};
try {
  // Native host serializes home initialization / Windows sandbox setup only.
  const a = await initialized('slow-test');
  const b = await initialized('fast-test');
  const [ta, tb] = await Promise.all([
    a.rpc('thread/start', { ...params, model: 'slow-test' }),
    b.rpc('thread/start', { ...params, model: 'fast-test' }),
  ]);
  assert.notEqual(ta.thread.id, tb.thread.id);
  const [ra, rb] = await Promise.all([
    a.rpc('turn/start', {
      threadId: ta.thread.id,
      input: [{ type: 'text', text: 'slow test', text_elements: [] }],
    }),
    b.rpc('turn/start', {
      threadId: tb.thread.id,
      input: [{ type: 'text', text: 'fast test', text_elements: [] }],
    }),
  ]);
  await a.wait((event) => event.method === 'item/agentMessage/delta');
  const completed = await b.wait(
    (event) => event.method === 'turn/completed' && event.params.turn.id === rb.turn.id,
  );
  assert.equal(completed.params.turn.status, 'completed');
  assert.equal(
    a.events.some((event) => event.method === 'turn/completed'),
    false,
  );
  await a.rpc('turn/interrupt', { threadId: ta.thread.id, turnId: ra.turn.id });
  const stopped = await a.wait((event) => event.method === 'turn/completed');
  assert.equal(stopped.params.turn.status, 'interrupted');
  assert.deepEqual(new Set(requests), new Set(['slow-test', 'fast-test']));
  b.child.kill();
  await b.exited;
  const restored = await initialized('fast-test');
  const resumed = await restored.rpc('thread/resume', {
    ...params,
    model: 'fast-test',
    threadId: tb.thread.id,
  });
  assert.equal(resumed.thread.id, tb.thread.id);
  assert.ok(
    resumed.thread.turns.some((turn) =>
      turn.items.some(
        (item) => item.type === 'agentMessage' && item.text.includes('fast-test: completed'),
      ),
    ),
  );
  console.log(
    'PASS: two real sidecars share a home, stream independently, keep model overrides, interrupt only one turn, and resume native history after process restart.',
  );
} finally {
  for (const engine of engines) if (engine.child.exitCode === null) engine.child.kill();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  await Promise.all(engines.map((engine) => engine.exited));
  assert.ok(root.startsWith(scratch + '\\') || root.startsWith(scratch + '/'));
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
