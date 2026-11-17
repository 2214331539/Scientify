import { expect, it } from 'vitest';
import { describeTool } from './agent-session';
import { diffFiles } from './TurnDetails';

it('splits a turn diff into files with their counts', () => {
  const diff = [
    'diff --git a/src/a.py b/src/a.py',
    'index 1..2 100644',
    '--- a/src/a.py',
    '+++ b/src/a.py',
    '@@ -1,2 +1,2 @@',
    '-x = 1',
    '+x = 2',
    '+y = 3',
    'diff --git a/README.md b/README.md',
    'new file mode 100644',
    '+# Notes',
  ].join('\n');
  const files = diffFiles(diff);
  expect(files.map((file) => [file.path, file.added, file.removed])).toEqual([
    ['src/a.py', 2, 1],
    ['README.md', 1, 0],
  ]);
  expect(files[0].lines[0]).toBe('@@ -1,2 +1,2 @@');
});

it('says what a web tool is doing', () => {
  expect(
    describeTool({
      type: 'dynamicToolCall',
      tool: 'scientify_web_search',
      arguments: { query: 'LoRA' },
    }),
  ).toBe('搜索网页：LoRA');
  expect(
    describeTool({
      type: 'dynamicToolCall',
      tool: 'scientify_web_fetch',
      arguments: '{"url":"https://example.com"}',
    }),
  ).toBe('阅读网页：https://example.com');
  expect(describeTool({ type: 'dynamicToolCall', tool: 'scientify_run' })).toBeNull();
  expect(describeTool({ type: 'commandExecution', command: 'ls' })).toBeNull();
});

it('formats how long a turn took and when a stretch of the chat began', async () => {
  const { duration } = await import('./TurnDetails');
  const { timeStamp } = await import('./AssistantTranscript');
  expect(duration(45_000)).toBe('45 秒');
  expect(duration(268_000)).toBe('4 分 28 秒');
  const now = new Date('2026-11-17T20:00:00');
  const at = (time: string) => new Date(`2026-11-17T${time}`).toISOString();
  expect(timeStamp(at('13:54:00'), undefined, now)).toMatch(/^今天 13:54$/);
  expect(timeStamp(at('13:55:00'), at('13:54:00'), now)).toBe('');
  expect(timeStamp(at('15:00:00'), at('13:54:00'), now)).toMatch(/^今天 15:00$/);
  expect(timeStamp(new Date('2026-11-16T09:05:00').toISOString(), undefined, now)).toMatch(
    /^昨天 09:05$/,
  );
});
