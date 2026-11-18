import { expect, it } from 'vitest';
import { original, parsePatches, resolvePath, reverse } from './undo';

const diff = [
  'diff --git a/src/train.py b/src/train.py',
  'index 1..2 100644',
  '--- a/src/train.py',
  '+++ b/src/train.py',
  '@@ -1,4 +1,4 @@',
  ' import torch',
  '-lr = 0.1',
  '+lr = 0.01',
  ' epochs = 10',
  ' print(lr)',
  'diff --git a/notes.md b/notes.md',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/notes.md',
  '@@ -0,0 +1 @@',
  '+# Notes',
  'diff --git a/old.txt b/old.txt',
  'deleted file mode 100644',
  '--- a/old.txt',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-first',
  '-second',
].join('\n');

it('reads each file of a turn diff', () => {
  const patches = parsePatches(diff);
  expect(patches.map((p) => [p.path, p.added, p.deleted])).toEqual([
    ['src/train.py', false, false],
    ['notes.md', true, false],
    ['old.txt', false, true],
  ]);
  expect(original(patches[2])).toBe('first\nsecond\n');
});

it('gives back the file before the turn, and refuses one changed since', () => {
  const [train] = parsePatches(diff);
  const after = 'import torch\nlr = 0.01\nepochs = 10\nprint(lr)\n';
  expect(reverse(after, train)).toBe('import torch\nlr = 0.1\nepochs = 10\nprint(lr)\n');
  expect(reverse(after.replace(/\n/g, '\r\n'), train)).toBe(
    'import torch\r\nlr = 0.1\r\nepochs = 10\r\nprint(lr)\r\n',
  );
  expect(() => reverse('import torch\nlr = 0.5\nepochs = 10\nprint(lr)\n', train)).toThrow();
});

it('takes a new file back to nothing, but not one written to since', () => {
  const [, notes] = parsePatches(diff);
  expect(reverse('# Notes\n', notes)).toBe('');
  expect(reverse('# Notes\nmore\n', notes)).not.toBe('');
});

it('finds the absolute path among the files the turn reported', () => {
  const files = ['F:\\data\\projects\\p\\src\\train.py', '/home/me/ai/notes.md'];
  expect(resolvePath('src/train.py', files)).toBe(files[0]);
  expect(resolvePath('notes.md', files)).toBe(files[1]);
  expect(resolvePath('other.txt', files, '/home/me/ai')).toBe('/home/me/ai/other.txt');
  expect(resolvePath('other.txt', files)).toBeNull();
});
