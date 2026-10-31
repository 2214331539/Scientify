import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SHORTCUT_COMMANDS } from '../platform/shortcuts';
import catalog from './messages.json';

// `t()` looks a message up by its key or by either translation.
const known = new Set(Object.entries(catalog).flatMap(([key, pair]) => [key, ...pair]));

const sources = readdirSync('src', { recursive: true, encoding: 'utf8' })
  .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
  .map((file) => [file.replaceAll('\\', '/'), readFileSync(join('src', file), 'utf8')] as const);

it('has an entry for every literal t() key', () => {
  const call = /(?<![\w.$])t\(\s*(['"])((?:(?!\1)[^\\]|\\.)*)\1/g;
  const missing = sources.flatMap(([file, source]) =>
    [...source.matchAll(call)]
      .map((match) => match[2].replace(/\\(.)/g, '$1'))
      .filter((key) => !known.has(key))
      .map((key) => `${file}: ${key}`),
  );
  expect(missing).toEqual([]);
});

it('has an entry for labels translated at render time', () => {
  const labels = SHORTCUT_COMMANDS.flatMap((item) => [item.label, item.description]);
  expect(labels.filter((label) => !known.has(label))).toEqual([]);
});

it('has an English translation for every entry', () => {
  const untranslated = Object.entries(catalog)
    .filter(([, pair]) => /\p{Script=Han}/u.test(pair[1]))
    .map(([key]) => key);
  expect(untranslated).toEqual([]);
});
