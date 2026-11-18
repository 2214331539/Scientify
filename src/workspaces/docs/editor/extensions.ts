import { Extension, InputRule, type Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableCell, TableHeader, TableKit } from '@tiptap/extension-table';
import { Details, DetailsContent, DetailsSummary } from '@tiptap/extension-details';
import { Mathematics } from '@tiptap/extension-mathematics';
import { BackgroundColor, Color, TextStyle } from '@tiptap/extension-text-style';
import { Placeholder } from '@tiptap/extensions';
import UniqueID from '@tiptap/extension-unique-id';
import FileHandler from '@tiptap/extension-file-handler';
import { common, createLowlight } from 'lowlight';
import { t } from '../../../i18n';
import { requestText } from '../../../components/prompts';
import { blockId } from '../model';
import type { DocEnv } from './env';
import { slashCommand, mentionSuggestions } from './menus';
import {
  Callout,
  Conflict,
  DocCodeBlock,
  DocImage,
  DocMention,
  FileBlock,
  AttachmentBlock,
  LinkCard,
  PaperBlock,
  PaperNoteBlock,
} from './nodes';

const lowlight = createLowlight(common);
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
/** Nodes that are blocks in the stored page, and so carry a stable id. */
const BLOCKS = [
  'paragraph',
  'heading',
  'listItem',
  'taskItem',
  'blockquote',
  'callout',
  'horizontalRule',
  'codeBlock',
  'blockMath',
  'docImage',
  'table',
  'details',
  'paperBlock',
  'paperNote',
  'fileBlock',
  'attachmentBlock',
  'linkCard',
  'conflict',
];

/** `$x$` makes inline math and `$$` on an empty line a formula block, as in Markdown. */
const MathShortcuts = Extension.create({
  name: 'mathShortcuts',
  addInputRules() {
    return [
      new InputRule({
        find: /(?:^|\s)\$([^$\s](?:[^$]*[^$\s])?)\$$/,
        handler: ({ state, range, match }) => {
          const start = range.from + match[0].indexOf('$');
          state.tr.replaceWith(
            start,
            range.to,
            state.schema.nodes.inlineMath.create({ latex: match[1] }),
          );
        },
      }),
      new InputRule({
        find: /^\$\$\s$/,
        handler: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          state.tr.replaceWith(
            $from.before(),
            $from.after(),
            state.schema.nodes.blockMath.create({ latex: '' }),
          );
        },
      }),
    ];
  },
});

async function editLatex(
  editor: Editor | null,
  kind: 'block' | 'inline',
  latex: string,
  pos: number,
) {
  const next = await requestText(t('编辑公式（LaTeX）'), latex);
  if (next === null || !editor || !editor.isEditable) return;
  if (kind === 'block') editor.chain().focus().updateBlockMath({ latex: next, pos }).run();
  else editor.chain().focus().updateInlineMath({ latex: next, pos }).run();
}

/** Dropped or pasted files: pictures become images, anything else an attachment card. */
async function insertFiles(editor: Editor, env: DocEnv, files: File[], pos?: number) {
  const insert = (node: Record<string, unknown>) =>
    typeof pos === 'number'
      ? editor.chain().focus().insertContentAt(pos, node).run()
      : editor.chain().focus().insertContent(node).run();
  const others = files.filter((file) => !IMAGE_TYPES.includes(file.type));
  for (const file of files) {
    if (!IMAGE_TYPES.includes(file.type)) continue;
    insert({ type: 'docImage', attrs: { asset: await env.saveImage(file), width: 1 } });
  }
  if (others.length) insertAttachments(editor, await env.attachFiles(others), pos);
}

/** Attachment cards for stored files, at `pos` or the cursor. */
export function insertAttachments(
  editor: Editor,
  attached: { asset: string; name: string; size: number }[],
  pos?: number,
) {
  const nodes = attached.map((item) => ({
    type: 'attachmentBlock',
    attrs: { asset: item.asset, name: item.name, size: String(item.size) },
  }));
  if (!nodes.length) return;
  if (typeof pos === 'number') editor.chain().focus().insertContentAt(pos, nodes).run();
  else editor.chain().focus().insertContent(nodes).run();
}

/** Cells keep a background and an alignment besides their span and width, as in Feishu. */
function cellAttributes(this: { parent?: () => Record<string, unknown> }) {
  return {
    ...this.parent?.(),
    background: {
      default: null,
      parseHTML: (element: HTMLElement) => element.getAttribute('data-background'),
      renderHTML: (attrs: { background?: string | null }) =>
        attrs.background
          ? { 'data-background': attrs.background, style: `background-color: ${attrs.background}` }
          : {},
    },
    align: {
      default: null,
      parseHTML: (element: HTMLElement) => element.getAttribute('data-align'),
      renderHTML: (attrs: { align?: string | null }) =>
        attrs.align ? { 'data-align': attrs.align, style: `text-align: ${attrs.align}` } : {},
    },
  };
}

export function docExtensions(env: () => DocEnv, editor: () => Editor | null) {
  return [
    StarterKit.configure({
      codeBlock: false,
      heading: { levels: [1, 2, 3] },
      link: { openOnClick: false, autolink: true, defaultProtocol: 'https' },
      dropcursor: { color: 'var(--sf-accent)', width: 2 },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: true }, tableCell: false, tableHeader: false }),
    TableCell.extend({ addAttributes: cellAttributes }),
    TableHeader.extend({ addAttributes: cellAttributes }),
    Details.configure({ persist: true, HTMLAttributes: { class: 'doc-toggle' } }),
    DetailsSummary,
    DetailsContent,
    Mathematics.configure({
      katexOptions: { throwOnError: false },
      blockOptions: {
        onClick: (node, pos) =>
          void editLatex(editor(), 'block', String(node.attrs.latex ?? ''), pos),
      },
      inlineOptions: {
        onClick: (node, pos) =>
          void editLatex(editor(), 'inline', String(node.attrs.latex ?? ''), pos),
      },
    }),
    MathShortcuts,
    TextStyle,
    Color,
    BackgroundColor,
    DocCodeBlock.configure({ lowlight, defaultLanguage: null }),
    Callout,
    Conflict,
    DocImage,
    PaperBlock,
    PaperNoteBlock,
    FileBlock,
    AttachmentBlock,
    LinkCard,
    DocMention.configure({
      suggestions: mentionSuggestions(env),
      deleteTriggerWithBackspace: true,
      renderText: ({ node }) => `@${String(node.attrs.label ?? '')}`,
    }),
    slashCommand(env),
    Placeholder.configure({
      showOnlyCurrent: true,
      placeholder: ({ node }) =>
        node.type.name === 'heading'
          ? t('标题')
          : node.type.name === 'detailsSummary'
            ? t('折叠块标题')
            : t('输入 / 插入块，@ 提及成员或页面'),
    }),
    UniqueID.configure({ types: BLOCKS, attributeName: 'id', generateID: () => blockId() }),
    FileHandler.configure({
      onPaste: (current, files) => void insertFiles(current, env(), files).catch(() => {}),
      onDrop: (current, files, pos) => void insertFiles(current, env(), files, pos).catch(() => {}),
    }),
  ];
}
