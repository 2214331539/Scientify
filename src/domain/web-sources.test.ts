import { expect, it } from 'vitest';
import { sourceUrl, validateWebSources } from './web-sources';

it('validates imports without dropping data and normalizes equivalent URLs', () => {
  expect(sourceUrl(' https://EXAMPLE.org ')).toBe('https://example.org/');
  expect(() => validateWebSources(undefined)).not.toThrow();
  const entry = {
    id: 'source-a',
    title: 'A',
    url: 'https://example.org',
    order: 0,
    createdAt: 'now',
    updatedAt: 'now',
  };
  expect(() => validateWebSources({ groups: [], items: [entry] })).not.toThrow();
  expect(() =>
    validateWebSources({
      groups: [],
      items: [entry, { ...entry, id: 'source-b', url: 'https://example.org/' }],
    }),
  ).toThrow();
  expect(() =>
    validateWebSources({ groups: [], items: [{ ...entry, groupId: 'missing' }] }),
  ).toThrow();
  for (const url of [
    'file:///C:/data',
    'javascript:alert(1)',
    'https://user:password@example.org',
  ]) {
    expect(() => sourceUrl(url)).toThrow();
  }
});
