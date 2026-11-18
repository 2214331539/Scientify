/**
 * Blocks <-> Markdown, for moving old notes over, importing and exporting, and for the AI,
 * which reads and writes pages as Markdown.
 */
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type { Nodes, PhrasingContent, Root, RootContent } from 'mdast';
import { blockId, type Block, type Inline, type Marks } from './model';

// ---------- To Markdown ----------
const escape = (value: string) => value.replace(/([\\`*_[\]<>|~$])/g, '\\$1');

function wrap(text: string, marks: Marks = {}) {
  if (marks.code) return '`' + text.replaceAll('`', 'ˋ') + '`';
  let out = escape(text);
  if (marks.bold) out = `**${out}**`;
  if (marks.italic) out = `*${out}*`;
  if (marks.strike) out = `~~${out}~~`;
  if (marks.link) out = `[${out}](${marks.link})`;
  return out;
}
export function inlineToMarkdown(content: Inline[] = []) {
  return content
    .map((item) => {
      if ('text' in item) {
        // Keep spaces outside the markers: `** bold**` is not bold in Markdown.
        const [, lead, core, tail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(item.text)!;
        return core ? lead + wrap(core, item.marks) + tail : item.text;
      }
      if (item.type === 'mention')
        return item.kind === 'page' ? `[[${item.label}]]` : `@${item.label}`;
      if (item.type === 'math') return `$${item.latex}$`;
      return '  \n';
    })
    .join('');
}

const indent = (text: string, prefix: string) =>
  text
    .split('\n')
    .map((line) => (line ? prefix + line : line))
    .join('\n');

function blockToMarkdown(block: Block, index: number, options: MarkdownOptions): string {
  const p = block.props ?? {};
  const text = inlineToMarkdown(block.content);
  const children = block.children?.length ? blocksToMarkdown(block.children, options) : '';
  const nested = (marker: string) =>
    marker + text + (children ? '\n' + indent(children, ' '.repeat(marker.length)) : '');
  switch (block.type) {
    case 'heading':
      return '#'.repeat(Math.min(3, Math.max(1, Number(p.level ?? 2)))) + ' ' + text;
    case 'bullet':
      return nested('- ');
    case 'numbered':
      return nested(`${index}. `);
    case 'todo':
      return nested(p.checked ? '- [x] ' : '- [ ] ');
    case 'quote':
      return indent(text + (children ? '\n\n' + children : ''), '> ');
    case 'callout':
      return indent(`${p.emoji ?? '💡'} ${text}`, '> ');
    case 'divider':
      return '---';
    case 'code': {
      const value = String(p.text ?? '');
      const fence = value.includes('```') ? '~~~~' : '```';
      return `${fence}${p.language ?? ''}\n${value}\n${fence}`;
    }
    case 'math':
      return `$$\n${p.latex ?? ''}\n$$`;
    case 'image':
      return `![${escape(String(p.caption ?? ''))}](${options.asset?.(String(p.asset ?? '')) ?? p.asset ?? ''})`;
    case 'table': {
      const rows = (p.rows as Inline[][][] | undefined) ?? [];
      if (!rows.length) return '';
      const width = Math.max(...rows.map((row) => row.length));
      const line = (row: Inline[][]) =>
        '| ' +
        Array.from({ length: width }, (_, i) =>
          inlineToMarkdown(row[i]).replaceAll('\n', ' '),
        ).join(' | ') +
        ' |';
      const head =
        p.header === false ? Array.from({ length: width }, () => [] as Inline[]) : rows[0];
      const body = p.header === false ? rows : rows.slice(1);
      return [
        line(head),
        '| ' + Array(width).fill('---').join(' | ') + ' |',
        ...body.map(line),
      ].join('\n');
    }
    case 'toggle':
      return `<details>\n<summary>${text}</summary>\n\n${children}\n\n</details>`;
    case 'paper':
      return `[📄 ${escape(String(p.title || p.path || ''))}](${p.path ?? ''})`;
    case 'paperNote':
      return `[📝 ${escape(String(p.title || p.path || ''))}](${p.path ?? ''})`;
    case 'file':
      return `[📎 ${escape(String(p.title || p.path || ''))}](${p.path ?? ''})`;
    case 'link':
      return `[${escape(String(p.title || p.url || ''))}](${p.url ?? ''})`;
    case 'attachment':
      return `[📎 ${escape(String(p.name ?? ''))}](${p.asset ?? ''})`;
    case 'conflict':
      return indent(`⚠️ ${String(p.from ?? '')}\n\n${children}`, '> ');
    default:
      return text;
  }
}

export type MarkdownOptions = {
  /** Writes `<!-- block:id -->` before each top-level block, so the AI can name blocks. */
  ids?: boolean;
  /** Turns a stored image path into the link written to the Markdown file. */
  asset?: (path: string) => string;
};
const LIST_TYPES = new Set(['bullet', 'numbered', 'todo']);

export function blocksToMarkdown(
  blocks: Block[],
  options: MarkdownOptions = {},
  top = false,
): string {
  const out: string[] = [];
  let number = 0;
  blocks.forEach((block, i) => {
    number = block.type === 'numbered' ? (blocks[i - 1]?.type === 'numbered' ? number + 1 : 1) : 0;
    const text = blockToMarkdown(block, number, options);
    const tight = LIST_TYPES.has(block.type) && blocks[i - 1]?.type === block.type;
    const marked = top && options.ids ? `<!-- block:${block.id} -->\n${text}` : text;
    out.push((i === 0 ? '' : tight && !(top && options.ids) ? '\n' : '\n\n') + marked);
  });
  return out.join('');
}
export const pageToMarkdown = (title: string, blocks: Block[], options: MarkdownOptions = {}) =>
  (title ? `# ${title}\n\n` : '') + blocksToMarkdown(blocks, options, true) + '\n';

// ---------- From Markdown ----------
export type ParseOptions = {
  /** Page id for `[[title]]`; unknown titles stay as text. */
  page?: (title: string) => { id: string; label: string } | undefined;
};

function phrasing(nodes: PhrasingContent[], marks: Marks, options: ParseOptions): Inline[] {
  return nodes
    .flatMap((node): Inline[] => {
      switch (node.type) {
        case 'text':
          return pageLinks(node.value, marks, options);
        case 'strong':
          return phrasing(node.children, { ...marks, bold: true }, options);
        case 'emphasis':
          return phrasing(node.children, { ...marks, italic: true }, options);
        case 'delete':
          return phrasing(node.children, { ...marks, strike: true }, options);
        case 'inlineCode':
          return [{ text: node.value, marks: { ...marks, code: true } }];
        case 'link':
          return phrasing(node.children, { ...marks, link: node.url }, options);
        case 'inlineMath':
          return [{ type: 'math', latex: node.value }];
        case 'break':
          return [{ type: 'break' }];
        case 'image':
          return [{ text: node.alt || node.url, marks: { ...marks, link: node.url } }];
        case 'html':
          return [{ text: node.value.replace(/<br\s*\/?>/gi, '\n') }];
        default:
          return 'value' in node ? [{ text: String(node.value) }] : [];
      }
    })
    .map((item) =>
      'text' in item && item.marks && !Object.keys(item.marks).length ? { text: item.text } : item,
    );
}
function pageLinks(value: string, marks: Marks, options: ParseOptions): Inline[] {
  const plain = (text: string): Inline[] =>
    text ? [Object.keys(marks).length ? { text, marks: { ...marks } } : { text }] : [];
  if (!options.page || !value.includes('[[')) return plain(value);
  const out: Inline[] = [];
  let rest = value;
  for (
    let match = /\[\[([^\]\n]+)\]\]/.exec(rest);
    match;
    match = /\[\[([^\]\n]+)\]\]/.exec(rest)
  ) {
    const found = options.page(match[1].trim());
    out.push(...plain(rest.slice(0, match.index)));
    out.push(
      ...(found
        ? [{ type: 'mention' as const, kind: 'page' as const, id: found.id, label: found.label }]
        : plain(match[0])),
    );
    rest = rest.slice(match.index + match[0].length);
  }
  out.push(...plain(rest));
  return out;
}
const inline = (nodes: PhrasingContent[], options: ParseOptions) => {
  const out = phrasing(nodes, {}, options);
  return out.length ? { content: out } : {};
};

function listBlocks(node: Extract<RootContent, { type: 'list' }>, options: ParseOptions): Block[] {
  return node.children.map((item) => {
    const [first, ...rest] = item.children;
    const type = typeof item.checked === 'boolean' ? 'todo' : node.ordered ? 'numbered' : 'bullet';
    const children = toBlocks(first?.type === 'paragraph' ? rest : item.children, options);
    return {
      id: blockId(),
      type,
      ...(type === 'todo' ? { props: { checked: item.checked === true } } : {}),
      ...(first?.type === 'paragraph' ? inline(first.children, options) : {}),
      ...(children.length ? { children } : {}),
    };
  });
}

function toBlocks(nodes: RootContent[] | Nodes[], options: ParseOptions): Block[] {
  const out: Block[] = [];
  for (const node of nodes as RootContent[]) {
    switch (node.type) {
      case 'paragraph': {
        // A paragraph that is only an image becomes an image block.
        if (node.children.length === 1 && node.children[0].type === 'image') {
          const image = node.children[0];
          out.push({
            id: blockId(),
            type: 'image',
            props: { asset: image.url, width: 1, ...(image.alt ? { caption: image.alt } : {}) },
          });
        } else out.push({ id: blockId(), type: 'paragraph', ...inline(node.children, options) });
        break;
      }
      case 'heading':
        out.push({
          id: blockId(),
          type: 'heading',
          props: { level: Math.min(3, node.depth) },
          ...inline(node.children, options),
        });
        break;
      case 'list':
        out.push(...listBlocks(node, options));
        break;
      case 'blockquote': {
        const [first, ...rest] = node.children;
        const children = toBlocks(first?.type === 'paragraph' ? rest : node.children, options);
        out.push({
          id: blockId(),
          type: 'quote',
          ...(first?.type === 'paragraph' ? inline(first.children, options) : {}),
          ...(children.length ? { children } : {}),
        });
        break;
      }
      case 'code':
        out.push({
          id: blockId(),
          type: 'code',
          props: { language: node.lang ?? null, text: node.value },
        });
        break;
      case 'math':
        out.push({ id: blockId(), type: 'math', props: { latex: node.value } });
        break;
      case 'thematicBreak':
        out.push({ id: blockId(), type: 'divider' });
        break;
      case 'table':
        out.push({
          id: blockId(),
          type: 'table',
          props: {
            header: true,
            rows: node.children.map((row) =>
              row.children.map((cell) => phrasing(cell.children, {}, options)),
            ),
          },
        });
        break;
      case 'html':
        if (node.value.trim())
          out.push({ id: blockId(), type: 'paragraph', content: [{ text: node.value }] });
        break;
      default:
        break;
    }
  }
  return out;
}

export function markdownToBlocks(markdown: string, options: ParseOptions = {}): Block[] {
  const tree = unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(markdown) as Root;
  return toBlocks(tree.children, options);
}

/** A Markdown file split into its first `# title` and the blocks after it. */
export function markdownToPage(markdown: string, options: ParseOptions = {}) {
  const match = /^\s*#\s+(.+)\n/.exec(markdown);
  return {
    title: match ? match[1].trim() : '',
    blocks: markdownToBlocks(match ? markdown.slice(match[0].length) : markdown, options),
  };
}
