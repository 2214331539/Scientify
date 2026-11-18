import { describe, expect, it } from 'vitest';
import { blocksToEditor, pageFromEditor, pageToEditor } from './convert';
import { markdownToBlocks, markdownToPage, pageToMarkdown } from './markdown';
import {
  childrenOf,
  descendants,
  liveParents,
  orderBetween,
  pathTo,
  templateBlocks,
  TEMPLATES,
  type Block,
  type PageSummary,
} from './model';

const summary = (
  id: string,
  parent: string | null,
  order: string,
  extra: Partial<PageSummary> = {},
): PageSummary => ({
  id,
  title: id,
  parent,
  order,
  createdAt: '',
  updatedAt: '',
  ...extra,
});

describe('ordering', () => {
  it('always finds a key between two others, however often pages are inserted', () => {
    const keys = [orderBetween(null, null)];
    for (let i = 0; i < 300; i++) {
      const at = (i * 7919) % (keys.length + 1);
      const key = orderBetween(keys[at - 1] ?? null, keys[at] ?? null);
      if (at > 0) expect(key > keys[at - 1]).toBe(true);
      if (at < keys.length) expect(key < keys[at]).toBe(true);
      keys.splice(at, 0, key);
    }
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((key) => !key.endsWith('0'))).toBe(true);
  });
});

describe('the page tree', () => {
  it('sorts siblings, hides the recycle bin and lifts orphans to the top', () => {
    const pages = [
      summary('b', null, 'b'),
      summary('a', null, 'a'),
      summary('child', 'a', 'V'),
      summary('gone', null, 'c', { deletedAt: '2026-11-16' }),
      summary('orphan', 'missing', 'x'),
      summary('under-gone', 'gone', 'y'),
    ];
    expect(childrenOf(pages, null).map((p) => p.id)).toEqual(['a', 'b', 'orphan', 'under-gone']);
    expect(childrenOf(pages, 'a').map((p) => p.id)).toEqual(['child']);
    expect(pathTo(pages, 'child').map((p) => p.id)).toEqual(['a', 'child']);
    expect(descendants(pages, 'gone')).toEqual(['gone', 'under-gone']);
  });

  it('breaks a loop made by two people moving pages under each other', () => {
    const pages = [summary('x', 'y', 'a'), summary('y', 'x', 'b'), summary('z', 'y', 'c')];
    const parents = liveParents(pages);
    expect([...parents.values()].filter((parent) => parent === null)).toHaveLength(1);
    expect(childrenOf(pages, null).length).toBe(1);
    expect(pathTo(pages, 'z').length).toBeGreaterThan(1);
  });
});

const sample: Block[] = [
  { id: 'h', type: 'heading', props: { level: 2 }, content: [{ text: '结论' }] },
  {
    id: 'p',
    type: 'paragraph',
    content: [
      { text: '损失 ' },
      { text: '带掩码', marks: { bold: true } },
      { type: 'math', latex: 'L = -\\sum_t m_t' },
      { text: ' 见 ' },
      { type: 'mention', kind: 'page', id: 'page-1', label: '11 月 16 日组会' },
      { text: '链接', marks: { link: 'https://example.com', color: '#c0392b' } },
    ],
  },
  {
    id: 'b1',
    type: 'bullet',
    content: [{ text: '一' }],
    children: [{ id: 'b2', type: 'bullet', content: [{ text: '一点一' }] }],
  },
  { id: 'b3', type: 'bullet', content: [{ text: '二' }] },
  { id: 'n1', type: 'numbered', content: [{ text: '第一' }] },
  { id: 't1', type: 'todo', props: { checked: true }, content: [{ text: '整理脚本' }] },
  { id: 't2', type: 'todo', props: { checked: false } },
  { id: 'q', type: 'quote', content: [{ text: '引用' }] },
  { id: 'c', type: 'callout', props: { emoji: '🎯' }, content: [{ text: '目的' }] },
  { id: 'd', type: 'divider' },
  { id: 'code', type: 'code', props: { language: 'python', text: 'print(1)\n' } },
  { id: 'm', type: 'math', props: { latex: 'p_t = \\sigma(x)' } },
  { id: 'img', type: 'image', props: { asset: 'images/a.png', width: 0.8, caption: '图 1' } },
  {
    id: 'tbl',
    type: 'table',
    props: {
      header: true,
      rows: [
        [[{ text: '阈值' }], [{ text: 'F1' }]],
        [[{ text: '0.5' }], [{ text: '0.712', marks: { bold: true } }]],
      ],
    },
  },
  {
    id: 'tg',
    type: 'toggle',
    props: { open: false },
    content: [{ text: '原始记录' }],
    children: [{ id: 'inner', type: 'paragraph', content: [{ text: '细节' }] }],
  },
  {
    id: 'paper',
    type: 'paper',
    props: { path: 'Proactive/a.pdf', title: 'Proactive Physical AI' },
  },
  {
    id: 'note',
    type: 'paperNote',
    props: { path: 'Proactive/a.pdf', title: 'Proactive Physical AI' },
  },
  { id: 'file', type: 'file', props: { path: 'train.py', title: 'train.py' } },
  {
    id: 'x',
    type: 'conflict',
    props: { from: '这台电脑', at: '2026-11-16' },
    children: [{ id: 'mine', type: 'paragraph', content: [{ text: '我的版本' }] }],
  },
  { id: 'empty', type: 'paragraph' },
];

describe('blocks and the editor', () => {
  it('round-trips every block type unchanged', () => {
    expect(pageFromEditor(pageToEditor(sample))).toEqual(sample);
  });

  it('groups list items into lists and gives nested paragraphs stable ids', () => {
    const doc = blocksToEditor(sample);
    const list = doc.find((node) => node.type === 'bulletList')!;
    expect(list.content).toHaveLength(2);
    expect(list.content![0].content![0].attrs!.id).toBe('b1-0');
    expect(doc.filter((node) => node.type === 'taskList')).toHaveLength(1);
  });

  it('round-trips every template', () => {
    for (const template of TEMPLATES) {
      const blocks = templateBlocks(template.id);
      expect(pageFromEditor(pageToEditor(blocks))).toEqual(blocks);
    }
  });
});

describe('Markdown', () => {
  it('writes readable Markdown with block ids for the AI', () => {
    const text = pageToMarkdown('组会', sample, { ids: true });
    expect(text).toContain('# 组会');
    expect(text).toContain('<!-- block:p -->');
    expect(text).toContain('**带掩码**');
    expect(text).toContain('[[11 月 16 日组会]]');
    expect(text).toContain('- [x] 整理脚本');
    expect(text).toContain('| 0.5 | **0.712** |');
    expect(text).toContain('```python');
  });

  it('reads Markdown back into the same kinds of blocks', () => {
    const blocks = markdownToBlocks(pageToMarkdown('', sample), {
      page: (title) => (title === '11 月 16 日组会' ? { id: 'page-1', label: title } : undefined),
    });
    const types = blocks.map((block) => block.type);
    expect(types).toEqual(
      expect.arrayContaining([
        'heading',
        'paragraph',
        'bullet',
        'numbered',
        'todo',
        'quote',
        'divider',
        'code',
        'math',
        'image',
        'table',
      ]),
    );
    const paragraph = blocks.find((block) => block.type === 'paragraph')!;
    expect(paragraph.content).toEqual(
      expect.arrayContaining([
        { text: '带掩码', marks: { bold: true } },
        { type: 'math', latex: 'L = -\\sum_t m_t' },
        { type: 'mention', kind: 'page', id: 'page-1', label: '11 月 16 日组会' },
      ]),
    );
    expect(blocks.find((block) => block.type === 'bullet')!.children![0].content).toEqual([
      { text: '一点一' },
    ]);
    expect(blocks.find((block) => block.type === 'todo')!.props).toEqual({ checked: true });
  });

  it('takes the first heading of an imported file as its title', () => {
    const page = markdownToPage('# 阅读笔记\n\n第一段\n\n- 要点');
    expect(page.title).toBe('阅读笔记');
    expect(page.blocks.map((block) => block.type)).toEqual(['paragraph', 'bullet']);
  });
});

describe('tables', () => {
  it('keep merged cells, colours, alignment and a header column through the editor', async () => {
    const { blocksFromEditor } = await import('./convert');
    const table = {
      id: 't1',
      type: 'table' as const,
      props: {
        header: true,
        headerCol: true,
        rows: [
          [[{ text: '方法' }], [{ text: '结果' }]],
          [[{ text: 'A' }], [{ text: '91%' }]],
        ],
        cells: [
          [{ colspan: 2 }, null],
          [null, { bg: 'rgba(64, 192, 87, 0.18)', align: 'right' as const }],
        ],
      },
    };
    const editor = blocksToEditor([table]);
    const rows = editor[0].content!;
    expect(rows[0].content![0].attrs?.colspan).toBe(2);
    expect(rows[1].content![0].type).toBe('tableHeader');
    expect(rows[1].content![1].attrs?.align).toBe('right');
    const [back] = blocksFromEditor(editor);
    expect(back.props?.headerCol).toBe(true);
    expect(back.props?.header).toBe(true);
    expect(back.props?.cells).toEqual(table.props.cells);
  });
});

describe('attachments', () => {
  it('round-trip through the editor and export as a link to the stored file', async () => {
    const { blocksFromEditor } = await import('./convert');
    const { blocksToMarkdown } = await import('./markdown');
    const block = {
      id: 'a1',
      type: 'attachment' as const,
      props: { asset: 'attachments/abc/结果.xlsx', name: '结果.xlsx', size: 2048 },
    };
    const [node] = blocksToEditor([block]);
    expect(node.type).toBe('attachmentBlock');
    expect(blocksFromEditor([node])).toEqual([block]);
    expect(blocksToMarkdown([block])).toContain('[📎 结果.xlsx](attachments/abc/结果.xlsx)');
  });
});

describe('link cards', () => {
  it('keep their page details and export as a Markdown link', async () => {
    const { blocksFromEditor } = await import('./convert');
    const { blocksToMarkdown } = await import('./markdown');
    const block = {
      id: 'l1',
      type: 'link' as const,
      props: {
        url: 'https://arxiv.org/abs/1706.03762',
        title: 'Attention Is All You Need',
        description: 'The Transformer paper.',
        site: 'arXiv',
      },
    };
    const [node] = blocksToEditor([block]);
    expect(node.type).toBe('linkCard');
    expect(blocksFromEditor([node])).toEqual([block]);
    expect(blocksToMarkdown([block])).toBe(
      '[Attention Is All You Need](https://arxiv.org/abs/1706.03762)',
    );
  });
});
