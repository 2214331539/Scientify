import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/core';
import { t } from '../../../i18n';
import { errorMessage } from '../../../domain/errors';
import type { DocEnv } from './env';

/** A URL just pasted on its own, as plain linked text from `from` to `to`. */
export type PastedLink = { from: number; to: number; url: string };

/** Whether pasted text is one web address and nothing else. */
export const isLink = (text: string) => /^https?:\/\/[^\s]+$/i.test(text.trim());

/**
 * Under a pasted link, as in Feishu: keep it as a link, show the page's title,
 * turn it into a card, or import the page as a new document.
 */
export function LinkPasteMenu({
  editor,
  pasted,
  env,
  onDone,
}: {
  editor: Editor;
  pasted: PastedLink;
  env: DocEnv;
  onDone(): void;
}) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => !busy && onDone(), 12_000);
    const close = (event: KeyboardEvent) => event.key === 'Escape' && onDone();
    window.addEventListener('keydown', close);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', close);
    };
  }, [busy, onDone]);
  const size = editor.state.doc.content.size;
  if (pasted.to > size) return null;
  const at = editor.view.coordsAtPos(pasted.to);
  // The link may have been edited meanwhile; then there is nothing to replace.
  const intact = () =>
    pasted.to <= editor.state.doc.content.size &&
    editor.state.doc.textBetween(pasted.from, pasted.to) === pasted.url;
  async function show(kind: 'title' | 'card') {
    setBusy(kind);
    setError('');
    try {
      const preview = await env.previewLink(pasted.url);
      if (!intact()) return onDone();
      const range = { from: pasted.from, to: pasted.to };
      if (kind === 'title')
        editor
          .chain()
          .focus()
          .insertContentAt(range, {
            type: 'text',
            text: preview.title || pasted.url,
            marks: [{ type: 'link', attrs: { href: pasted.url } }],
          })
          .run();
      else
        editor
          .chain()
          .focus()
          .insertContentAt(range, {
            type: 'linkCard',
            attrs: {
              ...preview,
              url: pasted.url,
              icon: preview.icon ?? '',
              image: preview.image ?? '',
            },
          })
          .run();
      onDone();
    } catch (reason) {
      setError(errorMessage(reason));
      setBusy('');
    }
  }
  async function importPage() {
    setBusy('import');
    setError('');
    try {
      await env.importLink(pasted.url);
      onDone();
    } catch (reason) {
      setError(errorMessage(reason));
      setBusy('');
    }
  }
  return createPortal(
    <div
      className="doc-link-paste"
      role="toolbar"
      aria-label={t('链接显示方式')}
      style={{ left: at.left, top: at.bottom + 6 }}
      onMouseDown={(event) => event.preventDefault()}
    >
      {busy ? (
        <span className="doc-link-paste-busy">{t('正在读取网页…')}</span>
      ) : (
        <>
          <button type="button" onClick={onDone}>
            {t('链接')}
          </button>
          <button type="button" onClick={() => void show('title')}>
            {t('标题')}
          </button>
          <button type="button" onClick={() => void show('card')}>
            {t('卡片')}
          </button>
          <span className="doc-toolbar-sep" />
          <button type="button" onClick={() => void importPage()}>
            {t('导入为文档')}
          </button>
        </>
      )}
      {error ? <span className="doc-link-paste-error">{error}</span> : null}
    </div>,
    document.body,
  );
}
