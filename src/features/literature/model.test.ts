import { expect, it } from 'vitest';
import { parseArxiv, createPaper } from './model';
it('normalizes arXiv entries and rejects injected non-arxiv links', () => {
  const entries = parseArxiv(
    '<feed><entry><id>http://arxiv.org/abs/2401.12345v1</id><title>A\n paper</title><author><name>Ada</name></author><summary>Summary</summary></entry><entry><id>javascript:alert(1)</id><title>Bad</title></entry></feed>',
  );
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    title: 'A paper',
    authors: 'Ada',
    externalId: 'https://arxiv.org/abs/2401.12345v1',
  });
});
it('creates complete schema3 paper fields for native persistence', () => {
  expect(createPaper('p', { title: 'Paper' })).toMatchObject({
    projects: ['p'],
    title: 'Paper',
    authors: '',
    status: '未读',
    quotes: [],
    tags: [],
    note: '',
  });
});
