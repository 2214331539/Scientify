import { useEditorState, type Editor } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { Copy, ExternalLink, FileText, Pencil, Unlink } from 'lucide-react';
import { t } from '../../../i18n';
import { parseBlockLink } from '../blockLink';
import type { DocEnv } from './env';

/**
 * With the cursor on a link, as in Feishu: where it goes, and open, copy,
 * change or remove it. A link to a page shows the page's title.
 */
export function LinkBubble({
  editor,
  env,
  readOnly,
  onEdit,
}: {
  editor: Editor;
  env: DocEnv;
  readOnly: boolean;
  onEdit(): void;
}) {
  const href = useEditorState({
    editor,
    selector: ({ editor: current }) =>
      current.isActive('link') ? String(current.getAttributes('link').href ?? '') : '',
  });
  const target = href ? parseBlockLink(href) : null;
  const page = target ? env.pages.find((item) => item.id === target.pageId) : undefined;
  const label = target ? page?.title || t('无标题') : href.replace(/^https?:\/\//, '');
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="linkBubble"
      className="doc-toolbar doc-link-bubble"
      options={{ placement: 'bottom-start', offset: 6 }}
      shouldShow={({ editor: current, view, from, to }) =>
        from === to && current.isActive('link') && view.hasFocus()
      }
    >
      <button
        type="button"
        className="doc-link-bubble-target"
        title={target ? label : href}
        onClick={() => env.openUrl(href)}
      >
        {target ? <FileText size={13} /> : <ExternalLink size={13} />}
        <span>{label}</span>
      </button>
      <span className="doc-toolbar-sep" />
      <button
        type="button"
        aria-label={t('复制链接')}
        onClick={() =>
          void navigator.clipboard.writeText(href).then(() => env.notify(t('已复制链接')))
        }
      >
        <Copy size={14} />
      </button>
      {readOnly ? null : (
        <>
          <button type="button" aria-label={t('编辑链接')} onClick={onEdit}>
            <Pencil size={14} />
          </button>
          <button
            type="button"
            aria-label={t('移除链接')}
            onClick={() => editor.chain().focus().extendMarkRange('link').unsetLink().run()}
          >
            <Unlink size={14} />
          </button>
        </>
      )}
    </BubbleMenu>
  );
}
