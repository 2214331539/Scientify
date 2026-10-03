// Deterministic Responses provider for native integration tests. No API key.
import { createServer } from 'node:http';
const command = JSON.parse(process.env.SCIENTIFY_FIXTURE_COMMAND);
const toolName = process.env.SCIENTIFY_FIXTURE_TOOL || 'scientify_start_run';
let sequence = 0;
const values = (value) => {
  if (typeof value === 'string') {
    try {
      return values(JSON.parse(value));
    } catch {
      return [];
    }
  }
  if (!value || typeof value !== 'object') return [];
  return [value, ...Object.values(value).flatMap(values)];
};
const server = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  const input = JSON.parse(body);
  const data = values(input.input);
  const snapshot = data.filter((v) => v.run?.id).at(-1);
  if (snapshot?.run.status === 'failed')
    throw new Error(`Fixture run failed: ${snapshot.run.error}; ${snapshot.log}`);
  const id = `fixture-${++sequence}`;
  let item;
  if (toolName !== 'scientify_start_run') {
    const reply = data.find((value) => typeof value.output === 'string' || typeof value.error === 'string');
    if (!reply) {
      if (!values(input.tools).some((value) => value.name === toolName)) throw new Error('Missing Git tool');
      item = { type: 'function_call', id: `fc-${sequence}`, call_id: `call-${sequence}`, name: toolName, arguments: JSON.stringify(command), status: 'completed' };
    } else {
      item = { type: 'message', id: `message-${sequence}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `Git result received: ${JSON.stringify(reply)}`, annotations: [] }] };
    }
  } else if (!snapshot) {
    if (!values(input.tools).some((v) => v.name === 'scientify_start_run'))
      throw new Error('Missing managed tool');
    item = {
      type: 'function_call',
      id: `fc-${sequence}`,
      call_id: `call-${sequence}`,
      name: 'scientify_start_run',
      arguments: JSON.stringify(command),
      status: 'completed',
    };
  } else if (snapshot.run.status === 'running' || !snapshot.metrics) {
    item = {
      type: 'function_call',
      id: `fc-${sequence}`,
      call_id: `call-${sequence}`,
      name: 'scientify_run_status',
      arguments: JSON.stringify({ runId: snapshot.run.id, waitSeconds: 1 }),
      status: 'completed',
    };
  } else {
    const metrics = JSON.parse(snapshot.metrics.content);
    item = {
      type: 'message',
      id: `message-${sequence}`,
      role: 'assistant',
      status: 'completed',
      content: [
        {
          type: 'output_text',
          text: `Observed accuracy=${metrics.accuracy}; status=${snapshot.run.status}; log=${snapshot.log.trim()}`,
          annotations: [],
        },
      ],
    };
  }
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const event = (type, fields) =>
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
  event('response.created', {
    response: { id, object: 'response', status: 'in_progress', output: [] },
  });
  event('response.output_item.added', {
    output_index: 0,
    item: { ...item, status: 'in_progress' },
  });
  event('response.output_item.done', { output_index: 0, item });
  event('response.completed', {
    response: {
      id,
      object: 'response',
      status: 'completed',
      output: [item],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    },
  });
  response.end();
});
server.listen(0, '127.0.0.1', () => console.log(`http://127.0.0.1:${server.address().port}/v1`));
