import test from 'node:test';
import assert from 'node:assert/strict';
import { charge, createMeter, promptChars, typical, usageOf } from '../src/billing/meter.mjs';
import { addMonths, chinaDay, monthStart } from '../src/billing/plans.mjs';

const sse = (...events) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';

test('usage reads both APIs, cached and reasoning tokens included', () => {
  assert.deepEqual(
    usageOf({ input_tokens: 10, input_tokens_details: { cached_tokens: 4 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 2 } }),
    { input: 10, cached: 4, output: 5, reasoning: 2 },
  );
  assert.deepEqual(usageOf({ prompt_tokens: 8, completion_tokens: 3, prompt_cache_hit_tokens: 6 }), {
    input: 8,
    cached: 6,
    output: 3,
    reasoning: 0,
  });
  assert.equal(usageOf({ text: 'no usage' }), null);
});

test('a Responses stream is counted from response.completed, split at any byte', () => {
  const stream = sse(
    { type: 'response.output_text.delta', delta: '你好' },
    { type: 'response.completed', response: { usage: { input_tokens: 100, output_tokens: 20 } } },
  );
  const meter = createMeter();
  for (let index = 0; index < stream.length; index += 7) meter.push(stream.slice(index, index + 7));
  assert.deepEqual(meter.finish(0), { input: 100, cached: 0, output: 20, reasoning: 0, estimated: false });
});

test('a chat stream without usage is estimated from the text and marked', () => {
  const meter = createMeter();
  meter.push(sse({ choices: [{ delta: { content: 'abcdef' } }] }, { choices: [{ delta: { reasoning_content: 'gh' } }] }));
  const prompt = promptChars({ messages: [{ role: 'user', content: 'x'.repeat(40) }, { content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }] });
  // Field values such as the role and part type count too; it is an estimate.
  assert.equal(prompt, 'user'.length + 40 + 'image_url'.length);
  assert.deepEqual(meter.finish(prompt), { input: 27, cached: 0, output: 4, reasoning: 0, estimated: true });
});

test('a whole JSON answer is read at the end', () => {
  const meter = createMeter();
  meter.push('{"id":"r","usage":{"prompt_tokens":7,');
  meter.push('"completion_tokens":2}}');
  assert.equal(meter.finish(0).input, 7);
});

test('points round up; cost is exact in millionths of a yuan', () => {
  const model = { priceInput: 400, priceCached: 40, priceOutput: 600, costInput: 2, costCached: 0.2, costOutput: 3 };
  assert.deepEqual(charge(model, { input: 100_000, cached: 40_000, output: 20_000 }), { points: 38, costMicros: 188_000 });
  assert.deepEqual(charge(model, { input: 1, cached: 0, output: 0 }), { points: 1, costMicros: 2 });
  assert.equal(typical(model).margin, 50);
  assert.equal(typical({ ...model, priceInput: 0, priceCached: 0, priceOutput: 0 }).margin, null);
});

test('periods follow China time and clamp to the end of short months', () => {
  assert.equal(chinaDay(new Date('2026-11-30T17:00:00Z')), '2026-12-01');
  assert.equal(monthStart(new Date('2026-11-30T17:00:00Z')).toISOString(), '2026-11-30T16:00:00.000Z');
  assert.equal(chinaDay(addMonths(new Date('2027-01-31T04:00:00Z'), 1)), '2027-02-28');
  assert.equal(chinaDay(addMonths(new Date('2027-01-31T04:00:00Z'), 2)), '2027-03-31');
});

test('model lists from any common shape; IDs come from upstream names and stay unique', async () => {
  const { readModelList, uniqueModelId } = await import('../src/admin/routes.mjs');
  assert.deepEqual(readModelList({ output: { models: [{ model: 'qwen-max', name: '通义千问 Max' }] } }), [
    { id: 'qwen-max', name: '通义千问 Max', ownedBy: '', chat: true },
  ]);
  assert.equal(readModelList({ error: 'nope' }), null);
  assert.equal(uniqueModelId('DeepSeek Chat V3', new Set()), 'deepseek-chat-v3');
  assert.equal(uniqueModelId('a', new Set(['a', 'a-2'])), 'a-3');
});
