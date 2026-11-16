import { Extension, InputRule, type Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
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

async function insertImages(editor: Editor, env: DocEnv, files: File[], pos?: number) {
  for (const file of files) {
    if (!IMAGE_TYPES.includes(file.type)) continue;
    const asset = await env.saveImage(file);
    const node = { type: 'docImage', attrs: { asset, width: 1 } };
    if (typeof pos === 'number') editor.chain().focus().insertContentAt(pos, node).run();
    else editor.chain().focus().insertContent(node).run();
  }
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
    TableKit.configure({ table: { resizable: true } }),
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
      allowedMimeTypes: IMAGE_TYPES,
      onPaste: (current, files) => void insertImages(current, env(), files),
      onDrop: (current, files, pos) => void insertImages(current, env(), files, pos),
    }),
  ];
}
