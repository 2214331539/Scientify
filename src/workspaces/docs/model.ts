/**
 * Project documents: a tree of pages, each a list of blocks with stable ids (like Notion). The
 * stored format is ours, not the editor's: `convert.ts` maps it to the editor and back, so the
 * editor can change without touching saved pages.
 */
import { t } from '../../i18n';

export type Marks = {
  bold?: true;
  italic?: true;
  strike?: true;
  underline?: true;
  code?: true;
  link?: string;
  color?: string;
  background?: string;
};
export type Inline =
  | { text: string; marks?: Marks }
  | { type: 'mention'; kind: 'page' | 'user'; id: string; label: string }
  | { type: 'math'; latex: string }
  | { type: 'break' };
export type BlockType =
  | 'paragraph'
  | 'heading'
  | 'bullet'
  | 'numbered'
  | 'todo'
  | 'quote'
  | 'callout'
  | 'divider'
  | 'code'
  | 'math'
  | 'image'
  | 'table'
  | 'toggle'
  | 'paper'
  | 'paperNote'
  | 'file'
  /** A file of any kind attached to the page (stored with the note assets). */
  | 'attachment'
  | 'conflict';
export type Block = {
  id: string;
  type: BlockType;
  props?: Record<string, unknown>;
  content?: Inline[];
  children?: Block[];
};
export type Page = {
  schema: 1;
  id: string;
  title: string;
  icon?: string | null;
  parent: string | null;
  order: string;
  createdAt: string;
  createdBy?: string;
  updatedAt: string;
  updatedBy?: string;
  deletedAt?: string | null;
  width?: 'standard' | 'wide';
  blocks: Block[];
};
/** What the page tree needs; the blocks are read when a page opens. */
export type PageSummary = Omit<Page, 'blocks' | 'schema'>;

export const summaryOf = ({ blocks: _blocks, schema: _schema, ...summary }: Page): PageSummary =>
  summary;

const ID = 'abcdefghijklmnopqrstuvwxyz0123456789';
/** A short random id; block ids only need to be unique within their page. */
export function blockId() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (byte) => ID[byte % ID.length]).join('');
}
export const pageId = () => crypto.randomUUID();

// ---------- Ordering ----------
// Siblings are sorted by a string key; a key can always be made between two others, so moving
// a page only rewrites that page (fractional indexing).
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? '0') === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const low = a ? DIGITS.indexOf(a[0]) : 0;
  const high = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length;
  if (high - low > 1) return DIGITS[Math.round((low + high) / 2)];
  if (b && b.length > 1) return b.slice(0, 1);
  return DIGITS[low] + midpoint(a.slice(1), null);
}
/** A key that sorts after `before` and before `after` (either may be missing). */
export function orderBetween(before: string | null | undefined, after: string | null | undefined) {
  const a = before ?? '';
  const b = after ?? null;
  if (b !== null && a >= b) return midpoint(a, null);
  return midpoint(a, b);
}

// ---------- Tree ----------
const bySiblingOrder = (a: PageSummary, b: PageSummary) =>
  a.order < b.order ? -1 : a.order > b.order ? 1 : a.title.localeCompare(b.title);

/**
 * The live tree: pages in the recycle bin are left out, a page whose parent is gone sits at the
 * top, and two pages moved under each other at the same time (a loop) are broken up.
 */
export function liveParents(pages: PageSummary[]): Map<string, string | null> {
  const live = new Map(pages.filter((page) => !page.deletedAt).map((page) => [page.id, page]));
  const parents = new Map<string, string | null>();
  for (const page of live.values())
    parents.set(page.id, page.parent && live.has(page.parent) ? page.parent : null);
  for (const page of [...live.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const seen = new Set<string>([page.id]);
    for (let up = parents.get(page.id); up; up = parents.get(up) ?? null) {
      if (seen.has(up)) {
        parents.set(page.id, null);
        break;
      }
      seen.add(up);
    }
  }
  return parents;
}
export function childrenOf(pages: PageSummary[], parent: string | null) {
  const parents = liveParents(pages);
  return pages
    .filter((page) => !page.deletedAt && parents.get(page.id) === parent)
    .sort(bySiblingOrder);
}
/** The page and everything under it, live or not. */
export function descendants(pages: PageSummary[], id: string): string[] {
  const out = [id];
  for (let i = 0; i < out.length; i++)
    for (const page of pages)
      if (page.parent === out[i] && !out.includes(page.id)) out.push(page.id);
  return out;
}
export function pathTo(pages: PageSummary[], id: string): PageSummary[] {
  const byId = new Map(pages.map((page) => [page.id, page]));
  const parents = liveParents(pages);
  const out: PageSummary[] = [];
  for (let at: string | null | undefined = id; at && out.length < 64; at = parents.get(at)) {
    const page = byId.get(at);
    if (!page) break;
    out.unshift(page);
  }
  return out;
}

// ---------- Text ----------
export function inlineText(content: Inline[] = []) {
  return content
    .map((item) =>
      'text' in item
        ? item.text
        : item.type === 'mention'
          ? '@' + item.label
          : item.type === 'math'
            ? item.latex
            : '\n',
    )
    .join('');
}
export function blockText(block: Block): string {
  const own =
    block.type === 'code'
      ? String(block.props?.text ?? '')
      : block.type === 'math'
        ? String(block.props?.latex ?? '')
        : block.type === 'table'
          ? ((block.props?.rows as Inline[][][] | undefined) ?? [])
              .map((row) => row.map(inlineText).join(' '))
              .join('\n')
          : block.type === 'paper' || block.type === 'paperNote' || block.type === 'file'
            ? String(block.props?.title ?? block.props?.path ?? '')
            : block.type === 'attachment'
              ? String(block.props?.name ?? '')
              : inlineText(block.content);
  return [own, ...(block.children ?? []).map(blockText)].filter(Boolean).join('\n');
}
export const pageText = (page: Page) => [page.title, ...page.blocks.map(blockText)].join('\n');

// ---------- New pages and templates ----------
const text = (value: string): Inline[] => (value ? [{ text: value }] : []);
// Empty blocks carry no `content`, exactly as they come back from the editor.
const b = (type: BlockType, value = '', props?: Record<string, unknown>): Block => ({
  id: blockId(),
  type,
  ...(type === 'todo' ? { props: { checked: false, ...props } } : props ? { props } : {}),
  ...(value && type !== 'code' ? { content: text(value) } : {}),
});
const h2 = (value: string) => b('heading', value, { level: 2 });

export type TemplateId = 'blank' | 'meeting' | 'experiment' | 'survey' | 'weekly';
export const TEMPLATES: { id: TemplateId; icon: string; label: string; description: string }[] = [
  { id: 'blank', icon: '📄', label: '空白页', description: '从空白开始' },
  { id: 'meeting', icon: '🗓️', label: '组会纪要', description: '参会、议题、结论、待办' },
  { id: 'experiment', icon: '🧪', label: '实验记录', description: '目的、设置、运行、结果' },
  { id: 'survey', icon: '📚', label: '论文调研', description: '问题、方法对比、论文' },
  { id: 'weekly', icon: '🗂️', label: '周报', description: '进展、问题、下周计划' },
];
export function templateBlocks(id: TemplateId): Block[] {
  switch (id) {
    case 'meeting':
      return [
        h2(t('参会')),
        b('paragraph'),
        h2(t('议题')),
        b('numbered'),
        h2(t('结论')),
        b('paragraph'),
        h2(t('待办')),
        b('todo'),
      ];
    case 'experiment':
      return [
        b('callout', t('目的：'), { emoji: '🎯' }),
        h2(t('设置')),
        b('code', '', { language: 'yaml', text: '' }),
        h2(t('运行')),
        b('paragraph'),
        h2(t('结果与分析')),
        b('paragraph'),
      ];
    case 'survey':
      return [
        h2(t('问题')),
        b('paragraph'),
        h2(t('方法对比')),
        b('table', '', {
          header: true,
          rows: [
            [text(t('论文')), text(t('方法')), text(t('数据')), text(t('结果'))],
            [[], [], [], []],
          ],
        }),
        h2(t('论文')),
        b('paragraph'),
      ];
    case 'weekly':
      return [
        h2(t('本周进展')),
        b('bullet'),
        h2(t('遇到的问题')),
        b('paragraph'),
        h2(t('下周计划')),
        b('todo'),
      ];
    default:
      return [b('paragraph')];
  }
}
export function templateTitle(id: TemplateId, now = new Date()) {
  if (id === 'meeting')
    return t('{month} 月 {day} 日组会', { month: now.getMonth() + 1, day: now.getDate() });
  if (id === 'blank') return '';
  return t(TEMPLATES.find((item) => item.id === id)!.label);
}

export function newPage(input: {
  parent: string | null;
  order: string;
  title?: string;
  icon?: string | null;
  blocks?: Block[];
  user?: string;
  now?: string;
}): Page {
  const now = input.now ?? new Date().toISOString();
  return {
    schema: 1,
    id: pageId(),
    title: input.title ?? '',
    icon: input.icon ?? null,
    parent: input.parent,
    order: input.order,
    createdAt: now,
    updatedAt: now,
    ...(input.user ? { createdBy: input.user, updatedBy: input.user } : {}),
    deletedAt: null,
    blocks: input.blocks?.length ? input.blocks : [b('paragraph')],
  };
}

/** A copy of blocks with fresh ids, for duplicating a page or pasting a template. */
export function freshIds(blocks: Block[]): Block[] {
  return blocks.map((block) => ({
    ...structuredClone(block),
    id: blockId(),
    ...(block.children ? { children: freshIds(block.children) } : {}),
  }));
}

/** Pages deleted more than this many days ago are removed for good. */
export const TRASH_DAYS = 30;
