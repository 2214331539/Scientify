/** The block editor of one page: blocks, the drag handle with its menu, and the text toolbar. */
import { useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { TableToolbar } from './TableToolbar';
import DragHandle from '@tiptap/extension-drag-handle-react';
import type { Node as PmNode } from '@tiptap/pm/model';
import {
  Bold,
  Code,
  Copy,
  GripVertical,
  Heading2,
  Italic,
  Lightbulb,
  Link2,
  List,
  ListChecks,
  Palette,
  Plus,
  Quote,
  Strikethrough,
  Trash2,
  Type,
  Underline,
} from 'lucide-react';
import { Menu, type MenuAnchor } from '../../../components/primitives/Menu';
import { requestText } from '../../../components/prompts';
import { t } from '../../../i18n';
import { pageFromEditor, pageToEditor } from '../convert';
import type { Block } from '../model';
import { DocEnvContext, type DocEnv } from './env';
import { Mascot } from '../../../components/ai/Mascot';
import { docExtensions } from './extensions';
import { LinkPasteMenu, isLink, type PastedLink } from './LinkPaste';
import type { EditorView } from '@tiptap/pm/view';

export const TEXT_COLORS: [string, string | null][] = [
  ['默认', null],
  ['灰色', '#8b8b93'],
  ['红色', '#e03131'],
  ['橙色', '#e8590c'],
  ['黄色', '#c98a00'],
  ['绿色', '#2f9e44'],
  ['蓝色', '#1c7ed6'],
  ['紫色', '#7048e8'],
];
export const BACKGROUNDS: [string, string | null][] = [
  ['无背景', null],
  ['灰色背景', 'rgba(140, 140, 150, 0.18)'],
  ['红色背景', 'rgba(250, 82, 82, 0.18)'],
  ['黄色背景', 'rgba(250, 200, 30, 0.24)'],
  ['绿色背景', 'rgba(64, 192, 87, 0.18)'],
  ['蓝色背景', 'rgba(51, 154, 240, 0.18)'],
];

type Handle = { node: PmNode; pos: number };

export function DocEditor({
  blocks,
  revision,
  readOnly,
  env,
  onChange,
  onSelection,
  onAsk,
}: {
  blocks: Block[];
  /** Changes when the page was replaced from outside the editor. */
  revision: number;
  readOnly: boolean;
  env: DocEnv;
  onChange(blocks: Block[]): void;
  onSelection(text: string): void;
  onAsk(text: string): void;
}) {
  const envRef = useRef(env);
  envRef.current = env;
  const latest = useRef({ onChange, onSelection });
  latest.current = { onChange, onSelection };
  // A URL pasted on its own is linked at once; a small bar then offers title, card or import.
  const [pasted, setPasted] = useState<PastedLink | null>(null);
  const pasteLink = useRef<(view: EditorView, event: ClipboardEvent) => boolean>(() => false);
  pasteLink.current = (view, event) => {
    const text = event.clipboardData?.getData('text/plain')?.trim() ?? '';
    if (readOnly || !isLink(text) || event.clipboardData?.files.length) return false;
    const { from, to } = view.state.selection;
    const mark = view.state.schema.marks.link?.create({ href: text });
    if (!mark) return false;
    view.dispatch(view.state.tr.insertText(text, from, to).addMark(from, from + text.length, mark));
    setPasted({ from, to: from + text.length, url: text });
    return true;
  };
  const editorRef = useRef<Editor | null>(null);
  // The editor is made once per page; later renders must not hand it new options.
  const [options] = useState(() => ({
    extensions: docExtensions(
      () => envRef.current,
      () => editorRef.current,
    ),
    content: pageToEditor(blocks),
    editable: !readOnly,
    editorProps: {
      attributes: { class: 'doc-prose', spellcheck: 'false' },
      handlePaste: (view: EditorView, event: ClipboardEvent) => pasteLink.current(view, event),
    },
    onUpdate: ({
      editor,
      transaction,
    }: {
      editor: Editor;
      transaction: { docChanged: boolean };
    }) => {
      if (transaction.docChanged) latest.current.onChange(pageFromEditor(editor.getJSON()));
    },
    onSelectionUpdate: ({ editor }: { editor: Editor }) => {
      const { from, to } = editor.state.selection;
      latest.current.onSelection(from === to ? '' : editor.state.doc.textBetween(from, to, '\n'));
    },
  }));
  const editor = useEditor(options, []);
  editorRef.current = editor;
  useEffect(() => editor?.setEditable(!readOnly), [editor, readOnly]);
  // A page replaced from outside (merged, written by the AI) is loaded again.
  const loaded = useRef(revision);
  useEffect(() => {
    if (!editor || loaded.current === revision) return;
    loaded.current = revision;
    editor.commands.setContent(pageToEditor(blocks), { emitUpdate: false });
  }, [editor, revision, blocks]);

  const handle = useRef<Handle | null>(null);
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; at: Handle } | null>(null);
  const [colors, setColors] = useState<MenuAnchor | null>(null);

  function addBelow() {
    const at = handle.current;
    if (!editor || !at) return;
    const end = at.pos + at.node.nodeSize;
    editor
      .chain()
      .insertContentAt(end, { type: 'paragraph' })
      .setTextSelection(end + 1)
      .insertContent('/')
      .focus()
      .run();
  }
  function turnInto(kind: string, at: Handle) {
    if (!editor) return;
    const chain = editor
      .chain()
      .focus()
      .setTextSelection(at.pos + 1);
    if (kind === 'text') chain.setParagraph();
    else if (kind === 'heading') chain.setHeading({ level: 2 });
    else if (kind === 'bullet') chain.toggleBulletList();
    else if (kind === 'todo') chain.toggleTaskList();
    else if (kind === 'quote') chain.toggleBlockquote();
    else if (kind === 'callout') chain.setNode('callout');
    else if (kind === 'code') chain.toggleCodeBlock();
    chain.run();
  }
  function duplicate(at: Handle) {
    // Duplicate ids are replaced by the id extension.
    editor
      ?.chain()
      .focus()
      .insertContentAt(at.pos + at.node.nodeSize, at.node.toJSON())
      .run();
  }
  function remove(at: Handle) {
    editor
      ?.chain()
      .focus()
      .deleteRange({ from: at.pos, to: at.pos + at.node.nodeSize })
      .run();
  }
  function color(at: Handle, value: string | null, background: boolean) {
    if (!editor) return;
    const chain = editor
      .chain()
      .focus()
      .setTextSelection({ from: at.pos + 1, to: at.pos + at.node.nodeSize - 1 });
    if (background) (value ? chain.setBackgroundColor(value) : chain.unsetBackgroundColor()).run();
    else (value ? chain.setColor(value) : chain.unsetColor()).run();
  }
  async function link() {
    if (!editor) return;
    const current = String(editor.getAttributes('link').href ?? '');
    const href = await requestText(t('输入链接地址'), current || 'https://');
    if (href === null) return;
    if (!href.trim() || href === 'https://') editor.chain().focus().unsetLink().run();
    else editor.chain().focus().extendMarkRange('link').setLink({ href: href.trim() }).run();
  }
  const selectedText = () => {
    if (!editor) return '';
    const { from, to } = editor.state.selection;
    return editor.state.doc.textBetween(from, to, '\n');
  };

  if (!editor) return null;
  const textblock = menu?.at.node.isTextblock;
  return (
    <DocEnvContext.Provider value={env}>
      <EditorContent editor={editor} className="doc-editor" />
      {readOnly ? null : (
        <DragHandle
          editor={editor}
          className="doc-handle"
          onNodeChange={({ node, pos }) => {
            handle.current = node ? { node, pos } : null;
          }}
        >
          <button type="button" aria-label={t('在下方插入')} onClick={addBelow}>
            <Plus size={15} />
          </button>
          <button
            type="button"
            className="doc-grip"
            aria-label={t('拖动移动，点击打开菜单')}
            onClick={(event) => {
              if (!handle.current) return;
              const rect = event.currentTarget.getBoundingClientRect();
              setMenu({
                anchor: { x: rect.left, y: rect.bottom + 4, trigger: event.currentTarget },
                at: handle.current,
              });
            }}
          >
            <GripVertical size={15} />
          </button>
        </DragHandle>
      )}
      <Menu anchor={menu?.anchor ?? null} label={t('块菜单')} onClose={() => setMenu(null)}>
        {menu ? (
          <>
            {textblock ||
            ['bulletList', 'taskList', 'blockquote', 'orderedList'].includes(
              menu.at.node.type.name,
            ) ? (
              <>
                <div className="sf-menu-label">{t('转换成')}</div>
                {(
                  [
                    ['text', Type, '正文'],
                    ['heading', Heading2, '标题'],
                    ['bullet', List, '列表'],
                    ['todo', ListChecks, '待办'],
                    ['quote', Quote, '引用'],
                    ['callout', Lightbulb, '高亮块'],
                    ['code', Code, '代码'],
                  ] as const
                ).map(([kind, Icon, label]) => (
                  <button
                    type="button"
                    role="menuitem"
                    key={kind}
                    onClick={() => {
                      turnInto(kind, menu.at);
                      setMenu(null);
                    }}
                  >
                    <Icon size={14} />
                    {t(label)}
                  </button>
                ))}
                <div role="separator" className="sf-menu-separator" />
              </>
            ) : null}
            {textblock ? (
              <button
                type="button"
                role="menuitem"
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  setColors({ x: rect.right + 4, y: rect.top, trigger: event.currentTarget });
                }}
              >
                <Palette size={14} />
                {t('颜色')}
              </button>
            ) : null}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                duplicate(menu.at);
                setMenu(null);
              }}
            >
              <Copy size={14} />
              {t('创建副本')}
            </button>
            {textblock ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onAsk(menu.at.node.textContent);
                  setMenu(null);
                }}
              >
                <Mascot size={14} />
                {t('问 AI')}
              </button>
            ) : null}
            <div role="separator" className="sf-menu-separator" />
            <button
              type="button"
              role="menuitem"
              className="sf-menu-danger"
              onClick={() => {
                remove(menu.at);
                setMenu(null);
              }}
            >
              <Trash2 size={14} />
              {t('删除')}
            </button>
          </>
        ) : null}
      </Menu>
      <Menu anchor={colors} label={t('颜色')} onClose={() => setColors(null)}>
        {menu || colors ? (
          <>
            <div className="sf-menu-label">{t('文字颜色')}</div>
            {TEXT_COLORS.map(([label, value]) => (
              <button
                type="button"
                role="menuitem"
                key={label}
                onClick={() => {
                  if (menu) color(menu.at, value, false);
                  else
                    editor
                      .chain()
                      .focus()
                      [value ? 'setColor' : 'unsetColor'](value as string)
                      .run();
                  setColors(null);
                  setMenu(null);
                }}
              >
                <span className="doc-swatch" style={{ color: value ?? undefined }}>
                  A
                </span>
                {t(label)}
              </button>
            ))}
            <div className="sf-menu-label">{t('背景色')}</div>
            {BACKGROUNDS.map(([label, value]) => (
              <button
                type="button"
                role="menuitem"
                key={label}
                onClick={() => {
                  if (menu) color(menu.at, value, true);
                  else
                    editor
                      .chain()
                      .focus()
                      [value ? 'setBackgroundColor' : 'unsetBackgroundColor'](value as string)
                      .run();
                  setColors(null);
                  setMenu(null);
                }}
              >
                <span className="doc-swatch" style={{ background: value ?? undefined }}>
                  A
                </span>
                {t(label)}
              </button>
            ))}
          </>
        ) : null}
      </Menu>
      {readOnly ? null : <TableToolbar editor={editor} backgrounds={BACKGROUNDS} />}
      {pasted && !readOnly ? (
        <LinkPasteMenu
          editor={editor}
          pasted={pasted}
          env={envRef.current}
          onDone={() => setPasted(null)}
        />
      ) : null}
      {readOnly ? null : (
        <BubbleMenu
          editor={editor}
          className="doc-toolbar"
          shouldShow={({ editor: current, from, to }) =>
            from !== to &&
            !current.isActive('codeBlock') &&
            !current.state.selection.toJSON().type?.includes('node')
          }
        >
          {(
            [
              ['bold', Bold, '加粗'],
              ['italic', Italic, '斜体'],
              ['underline', Underline, '下划线'],
              ['strike', Strikethrough, '删除线'],
              ['code', Code, '行内代码'],
            ] as const
          ).map(([mark, Icon, label]) => (
            <button
              type="button"
              key={mark}
              aria-label={t(label)}
              aria-pressed={editor.isActive(mark)}
              onClick={() => editor.chain().focus().toggleMark(mark).run()}
            >
              <Icon size={14} />
            </button>
          ))}
          <button
            type="button"
            aria-label={t('链接')}
            aria-pressed={editor.isActive('link')}
            onClick={() => void link()}
          >
            <Link2 size={14} />
          </button>
          <button
            type="button"
            aria-label={t('颜色')}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setMenu(null);
              setColors({ x: rect.left, y: rect.bottom + 4, trigger: event.currentTarget });
            }}
          >
            <Palette size={14} />
          </button>
          <span className="doc-toolbar-sep" />
          <button type="button" className="doc-toolbar-ai" onClick={() => onAsk(selectedText())}>
            <Mascot size={14} />
            {t('问 AI')}
          </button>
        </BubbleMenu>
      )}
    </DocEnvContext.Provider>
  );
}
