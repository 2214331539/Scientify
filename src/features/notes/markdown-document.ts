import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Root, RootContent } from 'mdast';
import { mathRemarkPlugins } from './math';

const parser = unified().use(remarkParse).use(remarkGfm).use(mathRemarkPlugins);
export type Heading = { from: number; level: number; title: string };
export type MarkdownBlock = { from: number; to: number; source: string; tasks: number[] };
function plainText(node: RootContent): string {
  if ('value' in node) return node.value;
  if ('children' in node)
    return node.children.map((child) => plainText(child as RootContent)).join('');
  if (node.type === 'image' || node.type === 'imageReference') return node.alt ?? '';
  return '';
}

/** Parse Markdown as a document, so fences, nested lists and math have real boundaries. */
export function parseMarkdown(source: string) {
  const tree = parser.parse(source) as Root;
  const headings: Heading[] = [];
  const definitions = tree.children.filter(
    (node) => node.type === 'definition' || node.type === 'footnoteDefinition',
  ) as Array<Extract<RootContent, { type: 'definition' | 'footnoteDefinition' }>>;
  const references = definitions
    .map((node) => source.slice(node.position!.start.offset!, node.position!.end.offset!))
    .join('\n\n');
  const blocks: MarkdownBlock[] = [];
  function visit(node: RootContent, tasks: number[]) {
    if (node.type === 'heading')
      headings.push({
        from: node.position!.start.offset!,
        level: node.depth,
        title: plainText(node),
      });
    if (node.type === 'listItem' && node.checked != null) {
      const from = node.position!.start.offset!;
      const marker = /^\s*(?:[-+*]|\d+[.)])\s+\[([ xX])\]/.exec(source.slice(from));
      if (marker) tasks.push(from + marker[0].lastIndexOf('[') + 1);
    }
    if ('children' in node) node.children.forEach((child) => visit(child as RootContent, tasks));
  }
  for (const node of tree.children) {
    const from = node.position!.start.offset!,
      to = node.position!.end.offset!;
    const tasks: number[] = [];
    visit(node, tasks);
    // Keep definitions editable rather than rendering an empty replacement.
    if (!definitions.some((definition) => definition === node))
      blocks.push({
        from,
        to,
        source: source.slice(from, to) + (references ? `\n\n${references}` : ''),
        tasks,
      });
  }
  return { blocks, headings };
}
