/** Blocks the stock editor does not have: callouts, conflicts, images and research cards. */
import { useEffect, useState, type ComponentType } from 'react';
import { mergeAttributes, Node } from '@tiptap/core';
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type ReactNodeViewProps,
} from '@tiptap/react';
import Mention from '@tiptap/extension-mention';
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { BookOpen, Copy, FileText, ImageIcon, NotebookPen, TriangleAlert } from 'lucide-react';
import { t } from '../../../i18n';
import { useDocEnv } from './env';
import { fileIcon } from '../../../components/ai/FileChip';

const atomBlock = (name: string, attrs: string[], view: ComponentType<ReactNodeViewProps>) =>
  Node.create({
    name,
    group: 'block',
    atom: true,
    draggable: true,
    selectable: true,
    addAttributes: () =>
      Object.fromEntries(attrs.map((attr) => [attr, { default: attr === 'width' ? 1 : '' }])),
    parseHTML: () => [{ tag: `div[data-type="${name}"]` }],
    renderHTML: ({ HTMLAttributes }) => [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-type': name }),
    ],
    addNodeView: () => ReactNodeViewRenderer(view),
  });

// ---------- Callout ----------
const EMOJIS = ['💡', '📌', '🎯', '⚠️', '✅', '❓', '🔥', '📎'];
function CalloutView({ node, updateAttributes, editor }: ReactNodeViewProps) {
  const [open, setOpen] = useState(false);
  return (
    <NodeViewWrapper className="doc-callout">
      <span className="doc-callout-emoji" contentEditable={false}>
        <button
          type="button"
          disabled={!editor.isEditable}
          aria-label={t('更换图标')}
          onClick={() => setOpen((value) => !value)}
        >
          {String(node.attrs.emoji || '💡')}
        </button>
        {open ? (
          <span className="doc-emoji-pick">
            {EMOJIS.map((emoji) => (
              <button
                type="button"
                key={emoji}
                onClick={() => {
                  updateAttributes({ emoji });
                  setOpen(false);
                }}
              >
                {emoji}
              </button>
            ))}
          </span>
        ) : null}
      </span>
      <NodeViewContent className="doc-callout-text" />
    </NodeViewWrapper>
  );
}
export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'inline*',
  defining: true,
  addAttributes: () => ({ emoji: { default: '💡' } }),
  parseHTML: () => [{ tag: 'div[data-type="callout"]' }],
  renderHTML: ({ HTMLAttributes }) => [
    'div',
    mergeAttributes(HTMLAttributes, { 'data-type': 'callout' }),
    0,
  ],
  addNodeView: () => ReactNodeViewRenderer(CalloutView),
});

// ---------- Conflict ----------
function ConflictView({ node, editor, getPos, deleteNode }: ReactNodeViewProps) {
  /** Puts this version's blocks where the conflict was; `replace` also drops the block above. */
  const keep = (replace: boolean) => {
    const pos = getPos();
    if (typeof pos !== 'number') return;
    const above = replace ? editor.state.doc.resolve(pos).nodeBefore : null;
    editor
      .chain()
      .focus()
      .insertContentAt(
        { from: above ? pos - above.nodeSize : pos, to: pos + node.nodeSize },
        node.content.toJSON() ?? [],
      )
      .run();
  };
  return (
    <NodeViewWrapper className="doc-conflict">
      <div className="doc-conflict-head" contentEditable={false}>
        <TriangleAlert size={14} />
        <span>
          {t('同步时两边都改了上面这一块，这里是{from}', {
            from: String(node.attrs.from || t('另一份')),
          })}
        </span>
        <span className="spacer" />
        {editor.isEditable ? (
          <>
            <button type="button" onClick={() => keep(true)}>
              {t('用这一版')}
            </button>
            <button type="button" onClick={() => deleteNode()}>
              {t('用上面那版')}
            </button>
            <button type="button" onClick={() => keep(false)}>
              {t('两版都留')}
            </button>
          </>
        ) : null}
      </div>
      <NodeViewContent className="doc-conflict-body" />
    </NodeViewWrapper>
  );
}
export const Conflict = Node.create({
  name: 'conflict',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes: () => ({ from: { default: '' }, at: { default: '' } }),
  parseHTML: () => [{ tag: 'div[data-type="conflict"]' }],
  renderHTML: ({ HTMLAttributes }) => [
    'div',
    mergeAttributes(HTMLAttributes, { 'data-type': 'conflict' }),
    0,
  ],
  addNodeView: () => ReactNodeViewRenderer(ConflictView),
});

// ---------- Image ----------
const WIDTHS = [0.25, 0.5, 0.75, 1];
function ImageView({ node, updateAttributes, editor, selected }: ReactNodeViewProps) {
  const env = useDocEnv();
  const asset = String(node.attrs.asset ?? '');
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setFailed(false);
    if (/^(https?:|data:)/.test(asset)) setSrc(asset);
    else if (asset)
      env
        .loadImage(asset)
        .then((value) => alive && setSrc(value))
        .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [asset, env]);
  const width = Number(node.attrs.width) || 1;
  return (
    <NodeViewWrapper className={`doc-image${selected ? ' is-selected' : ''}`} data-drag-handle="">
      <figure style={{ width: `${width * 100}%` }}>
        {src ? (
          <img src={src} alt={String(node.attrs.caption ?? '')} draggable={false} />
        ) : (
          <div className="doc-image-missing">
            <ImageIcon size={18} />
            {failed ? t('图片不在这台电脑上') : t('正在读取图片…')}
          </div>
        )}
        {editor.isEditable ? (
          <div className="doc-image-tools" contentEditable={false}>
            {WIDTHS.map((value) => (
              <button
                type="button"
                key={value}
                aria-pressed={width === value}
                onClick={() => updateAttributes({ width: value })}
              >
                {value * 100}%
              </button>
            ))}
          </div>
        ) : null}
        <figcaption contentEditable={false}>
          <input
            value={String(node.attrs.caption ?? '')}
            placeholder={editor.isEditable ? t('添加说明') : ''}
            readOnly={!editor.isEditable}
            onChange={(event) => updateAttributes({ caption: event.target.value })}
          />
        </figcaption>
      </figure>
    </NodeViewWrapper>
  );
}
export const DocImage = atomBlock('docImage', ['asset', 'width', 'caption'], ImageView);

// ---------- Research cards ----------
function PaperView({ node }: ReactNodeViewProps) {
  const env = useDocEnv();
  const path = String(node.attrs.path ?? '');
  return (
    <NodeViewWrapper className="doc-card doc-paper" data-drag-handle="">
      <button type="button" contentEditable={false} onClick={() => env.openPaper(path)}>
        <BookOpen size={16} />
        <span>
          <b>{String(node.attrs.title || path)}</b>
          <small>{path}</small>
        </span>
      </button>
    </NodeViewWrapper>
  );
}
export const PaperBlock = atomBlock('paperBlock', ['path', 'title'], PaperView);

function PaperNoteView({ node }: ReactNodeViewProps) {
  const env = useDocEnv();
  const path = String(node.attrs.path ?? '');
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    env
      .paperNote(path)
      .then((text) => alive && setNote(text))
      .catch(() => alive && setNote(''));
    return () => {
      alive = false;
    };
  }, [env, path]);
  return (
    <NodeViewWrapper className="doc-card doc-paper-note" data-drag-handle="">
      <button type="button" contentEditable={false} onClick={() => env.openPaper(path)}>
        <NotebookPen size={16} />
        <span>
          <b>{t('论文笔记：{title}', { title: String(node.attrs.title || path) })}</b>
          <small className="doc-note-text">
            {note === null
              ? t('正在读取…')
              : note.trim()
                ? note.slice(0, 600)
                : t('这篇论文还没有笔记')}
          </small>
        </span>
      </button>
    </NodeViewWrapper>
  );
}
export const PaperNoteBlock = atomBlock('paperNote', ['path', 'title'], PaperNoteView);

function FileView({ node }: ReactNodeViewProps) {
  const env = useDocEnv();
  const path = String(node.attrs.path ?? '');
  return (
    <NodeViewWrapper className="doc-card doc-file" data-drag-handle="">
      <button type="button" contentEditable={false} onClick={() => env.openFile(path)}>
        <FileText size={16} />
        <span>
          <b>{String(node.attrs.title || path.split('/').pop())}</b>
          <small>{path}</small>
        </span>
      </button>
    </NodeViewWrapper>
  );
}
export const FileBlock = atomBlock('fileBlock', ['path', 'title'], FileView);

const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** A file attached to the page: its icon, name and size; click to see it in the center. */
function AttachmentView({ node }: ReactNodeViewProps) {
  const env = useDocEnv();
  const asset = String(node.attrs.asset ?? '');
  const name = String(node.attrs.name || asset.split('/').pop());
  const Icon = fileIcon(name);
  const bytes = Number(node.attrs.size) || 0;
  return (
    <NodeViewWrapper className="doc-card doc-attachment" data-drag-handle="">
      <button
        type="button"
        contentEditable={false}
        title={t('在中间预览')}
        onClick={() => env.openAttachment(asset)}
      >
        <Icon size={18} />
        <span>
          <b>{name}</b>
          <small>{bytes ? size(bytes) : t('附件')}</small>
        </span>
      </button>
    </NodeViewWrapper>
  );
}
/** A link shown as a card, as in Feishu: title, summary, site and cover; click to open it in the center. */
function LinkCardView({ node }: ReactNodeViewProps) {
  const env = useDocEnv();
  const a = node.attrs as Record<string, string>;
  const host = (() => {
    try {
      return new URL(a.url).host.replace(/^www\./, '');
    } catch {
      return a.url;
    }
  })();
  return (
    <NodeViewWrapper className="doc-link-card" data-drag-handle="">
      <button
        type="button"
        contentEditable={false}
        title={a.url}
        onClick={() => env.openUrl(a.url)}
      >
        <span className="doc-link-card-text">
          <b>{a.title || a.url}</b>
          {a.description ? <span className="doc-link-card-summary">{a.description}</span> : null}
          <small>
            {a.icon ? <img src={a.icon} alt="" /> : null}
            {a.site || host}
          </small>
        </span>
        {a.image ? <img className="doc-link-card-cover" src={a.image} alt="" /> : null}
      </button>
    </NodeViewWrapper>
  );
}
export const LinkCard = atomBlock(
  'linkCard',
  ['url', 'title', 'description', 'site', 'icon', 'image'],
  LinkCardView,
);

export const AttachmentBlock = atomBlock(
  'attachmentBlock',
  ['asset', 'name', 'size'],
  AttachmentView,
);

// ---------- Mentions ----------
function MentionView({ node }: ReactNodeViewProps) {
  const env = useDocEnv();
  const [kind, ...rest] = String(node.attrs.id ?? '').split(':');
  const id = rest.join(':');
  if (kind === 'user')
    return (
      <NodeViewWrapper as="span" className="doc-mention is-user">
        @{env.userLabel(id) || String(node.attrs.label ?? '')}
      </NodeViewWrapper>
    );
  const page = env.pages.find((item) => item.id === id);
  return (
    <NodeViewWrapper
      as="span"
      className={`doc-mention is-page${page && !page.deletedAt ? '' : ' is-missing'}`}
    >
      <button type="button" contentEditable={false} onClick={() => env.openPage(id)}>
        <span className="doc-mention-icon">{page?.icon || '📄'}</span>
        {page ? page.title || t('无标题') : String(node.attrs.label ?? '')}
      </button>
    </NodeViewWrapper>
  );
}
export const DocMention = Mention.extend({
  addNodeView: () => ReactNodeViewRenderer(MentionView),
});

// ---------- Code ----------
const LANGUAGES = [
  '',
  'python',
  'bash',
  'json',
  'yaml',
  'javascript',
  'typescript',
  'rust',
  'cpp',
  'latex',
  'markdown',
  'sql',
];
function CodeView({ node, updateAttributes, editor }: ReactNodeViewProps) {
  return (
    <NodeViewWrapper className="doc-code">
      <div className="doc-code-tools" contentEditable={false}>
        <select
          aria-label={t('代码语言')}
          value={String(node.attrs.language ?? '')}
          disabled={!editor.isEditable}
          onChange={(event) => updateAttributes({ language: event.target.value || null })}
        >
          {LANGUAGES.map((language) => (
            <option key={language} value={language}>
              {language || t('纯文本')}
            </option>
          ))}
        </select>
        <button
          type="button"
          aria-label={t('复制代码')}
          onClick={() => void navigator.clipboard?.writeText(node.textContent)}
        >
          <Copy size={13} />
        </button>
      </div>
      <pre>
        <NodeViewContent<'code'> as="code" />
      </pre>
    </NodeViewWrapper>
  );
}
export const DocCodeBlock = CodeBlockLowlight.extend({
  addNodeView: () => ReactNodeViewRenderer(CodeView),
});
