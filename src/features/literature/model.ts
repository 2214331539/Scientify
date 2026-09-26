import { t } from '../../i18n';
import { XMLParser } from 'fast-xml-parser';
import type { Paper } from '../../domain/workspace';

export type FeedPaper = {
  externalId: string;
  title: string;
  authors: string;
  abstract: string;
  url: string;
  published: string;
};
const text = (value: unknown) =>
  typeof value === 'string'
    ? value
    : typeof value === 'object' && value !== null && '#text' in value
      ? String(value['#text'])
      : '';
export function parseArxiv(xml: string): FeedPaper[] {
  const parsed = new XMLParser({ ignoreAttributes: false, processEntities: false }).parse(xml);
  const entries = parsed?.feed?.entry;
  if (!entries) return [];
  return (Array.isArray(entries) ? entries : [entries])
    .slice(0, 20)
    .flatMap((entry: Record<string, unknown>) => {
      const id = text(entry.id);
      if (!/^https?:\/\/arxiv\.org\/abs\/[\w./-]+$/.test(id)) return [];
      const author = entry.author;
      const authors = (Array.isArray(author) ? author : author ? [author] : [])
        .map((a) => text(a?.name))
        .filter(Boolean)
        .join(', ');
      return [
        {
          externalId: id.replace(/^http:/, 'https:'),
          title: text(entry.title).replace(/\s+/g, ' ').trim(),
          authors,
          abstract: text(entry.summary).trim(),
          url: id.replace(/^http:/, 'https:'),
          published: text(entry.published),
        },
      ];
    });
}
export function createPaper(projectId: string, fields: Partial<Paper>): Paper {
  return {
    id: crypto.randomUUID(),
    title: t('未命名文献'),
    projects: [projectId],
    authors: '',
    note: '',
    status: '未读',
    tags: [],
    quotes: [],
    createdAt: new Date().toISOString(),
    ...fields,
  };
}
