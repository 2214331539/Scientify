/**
 * Stored blocks <-> the editor's document (Tiptap JSON). Lists are one block per item, as in
 * Notion; the editor groups neighbouring items of a kind into one list. Paragraphs nested in
 * list items, quotes and table cells get ids derived from their block, so opening a page never
 * looks like an edit.
 */
import type { JSONContent } from '@tiptap/core';
import { blockId, type Block, type BlockType, type Inline, type Marks } from './model';

const LISTS: Partial<Record<BlockType, { list: string; item: string }>> = {
  bullet: { list: 'bulletList', item: 'listItem' },
  numbered: { list: 'orderedList', item: 'listItem' },
  todo: { list: 'taskList', item: 'taskItem' },
};

// ---------- Inline ----------
function marksToEditor(marks: Marks = {}) {
  const out: NonNullable<JSONContent['marks']> = [];
  for (const name of ['bold', 'italic', 'strike', 'underline', 'code'] as const)
    if (marks[name]) out.push({ type: name });
  if (marks.link) out.push({ type: 'link', attrs: { href: marks.link } });
  if (marks.color || marks.background)
    out.push({
      type: 'textStyle',
      attrs: { color: marks.color ?? null, backgroundColor: marks.background ?? null },
    });
  return out;
}
export function inlineToEditor(content: Inline[] = []): JSONContent[] {
  return content.flatMap((item): JSONContent[] => {
    if ('text' in item) {
      if (!item.text) return [];
      const marks = marksToEditor(item.marks);
      return [{ type: 'text', text: item.text, ...(marks.length ? { marks } : {}) }];
    }
    if (item.type === 'mention')
      return [{ type: 'mention', attrs: { id: `${item.kind}:${item.id}`, label: item.label } }];
    if (item.type === 'math') return [{ type: 'inlineMath', attrs: { latex: item.latex } }];
    return [{ type: 'hardBreak' }];
  });
}
function marksFromEditor(marks: JSONContent['marks'] = []): Marks | undefined {
  const out: Marks = {};
  for (const mark of marks) {
    if (['bold', 'italic', 'strike', 'underline', 'code'].includes(mark.type))
      out[mark.type as 'bold'] = true;
    else if (mark.type === 'link' && typeof mark.attrs?.href === 'string')
      out.link = mark.attrs.href;
    else if (mark.type === 'textStyle') {
      if (typeof mark.attrs?.color === 'string' && mark.attrs.color) out.color = mark.attrs.color;
      if (typeof mark.attrs?.backgroundColor === 'string' && mark.attrs.backgroundColor)
        out.background = mark.attrs.backgroundColor;
    }
  }
  return Object.keys(out).length ? out : undefined;
}
export function inlineFromEditor(content: JSONContent[] = []): Inline[] {
  const out: Inline[] = [];
  for (const node of content) {
    if (node.type === 'text' && node.text) {
      const marks = marksFromEditor(node.marks);
      const last = out.at(-1);
      // Neighbouring text with the same formatting is one run.
      if (last && 'text' in last && JSON.stringify(last.marks) === JSON.stringify(marks))
        last.text += node.text;
      else out.push({ text: node.text, ...(marks ? { marks } : {}) });
    } else if (node.type === 'mention') {
      const [kind, ...rest] = String(node.attrs?.id ?? '').split(':');
      out.push({
        type: 'mention',
        kind: kind === 'user' ? 'user' : 'page',
        id: rest.join(':'),
        label: String(node.attrs?.label ?? ''),
      });
    } else if (node.type === 'inlineMath')
      out.push({ type: 'math', latex: String(node.attrs?.latex ?? '') });
    else if (node.type === 'hardBreak') out.push({ type: 'break' });
  }
  return out;
}

// ---------- Blocks to the editor ----------
const paragraph = (id: string, content?: Inline[]): JSONContent => {
  const inline = inlineToEditor(content);
  return { type: 'paragraph', attrs: { id }, ...(inline.length ? { content: inline } : {}) };
};

function blockToEditor(block: Block): JSONContent {
  const p = block.props ?? {};
  const id = block.id;
  switch (block.type) {
    case 'heading': {
      const inline = inlineToEditor(block.content);
      return {
        type: 'heading',
        attrs: { id, level: [1, 2, 3].includes(Number(p.level)) ? Number(p.level) : 2 },
        ...(inline.length ? { content: inline } : {}),
      };
    }
    case 'quote':
      return {
        type: 'blockquote',
        attrs: { id },
        content: [paragraph(`${id}-0`, block.content), ...blocksToEditor(block.children ?? [])],
      };
    case 'callout': {
      const inline = inlineToEditor(block.content);
      return {
        type: 'callout',
        attrs: { id, emoji: typeof p.emoji === 'string' ? p.emoji : '💡' },
        ...(inline.length ? { content: inline } : {}),
      };
    }
    case 'divider':
      return { type: 'horizontalRule', attrs: { id } };
    case 'code': {
      const value = String(p.text ?? '');
      return {
        type: 'codeBlock',
        attrs: { id, language: typeof p.language === 'string' ? p.language : null },
        ...(value ? { content: [{ type: 'text', text: value }] } : {}),
      };
    }
    case 'math':
      return { type: 'blockMath', attrs: { id, latex: String(p.latex ?? '') } };
    case 'image':
      return {
        type: 'docImage',
        attrs: {
          id,
          asset: String(p.asset ?? ''),
          width: typeof p.width === 'number' ? p.width : 1,
          caption: typeof p.caption === 'string' ? p.caption : '',
        },
      };
    case 'table': {
      const rows = (p.rows as Inline[][][] | undefined) ?? [[[]]];
      const widths = (p.widths as (number | null)[] | undefined) ?? [];
      return {
        type: 'table',
        attrs: { id },
        content: rows.map((row, r) => ({
          type: 'tableRow',
          content: row.map((cell, c) => ({
            type: r === 0 && p.header !== false ? 'tableHeader' : 'tableCell',
            attrs: { colspan: 1, rowspan: 1, colwidth: widths[c] ? [widths[c]] : null },
            content: [paragraph(`${id}-${r}-${c}`, cell)],
          })),
        })),
      };
    }
    case 'toggle': {
      const summary = inlineToEditor(block.content);
      const children = blocksToEditor(block.children ?? []);
      return {
        type: 'details',
        attrs: { id, open: p.open === true },
        content: [
          { type: 'detailsSummary', ...(summary.length ? { content: summary } : {}) },
          {
            type: 'detailsContent',
            content: children.length ? children : [paragraph(`${id}-0`)],
          },
        ],
      };
    }
    case 'paper':
    case 'paperNote':
    case 'file':
      return {
        type: { paper: 'paperBlock', paperNote: 'paperNote', file: 'fileBlock' }[block.type],
        attrs: { id, path: String(p.path ?? ''), title: String(p.title ?? '') },
      };
    case 'conflict': {
      const children = blocksToEditor(block.children ?? []);
      return {
        type: 'conflict',
        attrs: { id, from: String(p.from ?? ''), at: String(p.at ?? '') },
        content: children.length ? children : [paragraph(`${id}-0`)],
      };
    }
    default:
      return paragraph(id, block.content);
  }
}

function listItem(block: Block): JSONContent {
  const kind = LISTS[block.type]!;
  return {
    type: kind.item,
    attrs: {
      id: block.id,
      ...(block.type === 'todo' ? { checked: block.props?.checked === true } : {}),
    },
    content: [paragraph(`${block.id}-0`, block.content), ...blocksToEditor(block.children ?? [])],
  };
}

export function blocksToEditor(blocks: Block[]): JSONContent[] {
  const out: JSONContent[] = [];
  for (const block of blocks) {
    const kind = LISTS[block.type];
    if (!kind) {
      out.push(blockToEditor(block));
      continue;
    }
    const last = out.at(-1);
    if (last?.type === kind.list) last.content!.push(listItem(block));
    else out.push({ type: kind.list, content: [listItem(block)] });
  }
  return out;
}
export const pageToEditor = (blocks: Block[]): JSONContent => {
  const content = blocksToEditor(blocks);
  return { type: 'doc', content: content.length ? content : [paragraph(blockId())] };
};

// ---------- The editor to blocks ----------
const idOf = (node: JSONContent) =>
  typeof node.attrs?.id === 'string' && node.attrs.id ? node.attrs.id : blockId();
const withContent = (block: Block, content: Inline[]): Block =>
  content.length ? { ...block, content } : block;
const withChildren = (block: Block, children: Block[]): Block =>
  children.length ? { ...block, children } : block;

/** A container's first paragraph is its own text; the rest are its children. */
function split(node: JSONContent): { content: Inline[]; children: Block[] } {
  const [first, ...rest] = node.content ?? [];
  if (first?.type === 'paragraph')
    return { content: inlineFromEditor(first.content), children: blocksFromEditor(rest) };
  return { content: [], children: blocksFromEditor(node.content ?? []) };
}

function blockFromEditor(node: JSONContent): Block[] {
  const id = idOf(node);
  switch (node.type) {
    case 'paragraph':
      return [withContent({ id, type: 'paragraph' }, inlineFromEditor(node.content))];
    case 'heading':
      return [
        withContent(
          { id, type: 'heading', props: { level: Number(node.attrs?.level ?? 2) } },
          inlineFromEditor(node.content),
        ),
      ];
    case 'bulletList':
    case 'orderedList':
    case 'taskList': {
      const type: BlockType =
        node.type === 'bulletList' ? 'bullet' : node.type === 'orderedList' ? 'numbered' : 'todo';
      return (node.content ?? []).map((item) => {
        const { content, children } = split(item);
        const block: Block = {
          id: idOf(item),
          type,
          ...(type === 'todo' ? { props: { checked: item.attrs?.checked === true } } : {}),
        };
        return withChildren(withContent(block, content), children);
      });
    }
    case 'blockquote': {
      const { content, children } = split(node);
      return [withChildren(withContent({ id, type: 'quote' }, content), children)];
    }
    case 'callout':
      return [
        withContent(
          { id, type: 'callout', props: { emoji: String(node.attrs?.emoji ?? '💡') } },
          inlineFromEditor(node.content),
        ),
      ];
    case 'horizontalRule':
      return [{ id, type: 'divider' }];
    case 'codeBlock':
      return [
        {
          id,
          type: 'code',
          props: {
            language: typeof node.attrs?.language === 'string' ? node.attrs.language : null,
            text: (node.content ?? []).map((child) => child.text ?? '').join(''),
          },
        },
      ];
    case 'blockMath':
      return [{ id, type: 'math', props: { latex: String(node.attrs?.latex ?? '') } }];
    case 'docImage':
      return [
        {
          id,
          type: 'image',
          props: {
            asset: String(node.attrs?.asset ?? ''),
            width: Number(node.attrs?.width ?? 1),
            ...(node.attrs?.caption ? { caption: String(node.attrs.caption) } : {}),
          },
        },
      ];
    case 'table': {
      const rows = (node.content ?? []).map((row) =>
        (row.content ?? []).map((cell) =>
          (cell.content ?? []).flatMap((child, i) => [
            ...(i > 0 ? [{ type: 'break' } as Inline] : []),
            ...inlineFromEditor(child.content),
          ]),
        ),
      );
      const first = node.content?.[0]?.content ?? [];
      const widths = first.map((cell) =>
        Array.isArray(cell.attrs?.colwidth) ? (cell.attrs!.colwidth[0] ?? null) : null,
      );
      return [
        {
          id,
          type: 'table',
          props: {
            header: first[0]?.type === 'tableHeader',
            rows,
            ...(widths.some(Boolean) ? { widths } : {}),
          },
        },
      ];
    }
    case 'details': {
      const summary = node.content?.find((child) => child.type === 'detailsSummary');
      const body = node.content?.find((child) => child.type === 'detailsContent');
      const children = blocksFromEditor(body?.content ?? []).filter(
        (child, i, all) =>
          !(all.length === 1 && child.type === 'paragraph' && !child.content?.length && i === 0),
      );
      return [
        withChildren(
          withContent(
            { id, type: 'toggle', props: { open: node.attrs?.open === true } },
            inlineFromEditor(summary?.content),
          ),
          children,
        ),
      ];
    }
    case 'paperBlock':
    case 'paperNote':
    case 'fileBlock':
      return [
        {
          id,
          type:
            node.type === 'paperBlock' ? 'paper' : node.type === 'paperNote' ? 'paperNote' : 'file',
          props: { path: String(node.attrs?.path ?? ''), title: String(node.attrs?.title ?? '') },
        },
      ];
    case 'conflict':
      return [
        withChildren(
          {
            id,
            type: 'conflict',
            props: { from: String(node.attrs?.from ?? ''), at: String(node.attrs?.at ?? '') },
          },
          blocksFromEditor(node.content ?? []),
        ),
      ];
    default:
      // Unknown nodes keep their text rather than vanish.
      return node.content ? blocksFromEditor(node.content) : [];
  }
}
export function blocksFromEditor(content: JSONContent[]): Block[] {
  return content.flatMap(blockFromEditor);
}
export const pageFromEditor = (doc: JSONContent): Block[] => blocksFromEditor(doc.content ?? []);
