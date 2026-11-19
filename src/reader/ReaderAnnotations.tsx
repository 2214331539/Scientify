import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { Copy, MessageSquarePlus, NotebookPen, StickyNote, Trash2, Underline } from 'lucide-react';
import { Button, Textarea } from '../components/primitives';
import { Mascot } from '../components/ai/Mascot';
import { t } from '../i18n';
import type { PaperAnnotation } from '../platform/library';
import { HIGHLIGHT_COLORS, readingOrder } from './annotations';

/** Above the point if there is room under the title bar, otherwise below it. */
function placement(box: { top: number; bottom: number; left: number; width: number }) {
  const above = box.top - 48;
  return {
    top: above > 72 ? above : box.bottom + 8,
    left: Math.min(Math.max(box.left + box.width / 2, 160), window.innerWidth - 160),
  };
}

function useDismiss(ref: RefObject<HTMLElement | null>, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const down = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) close.current();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close.current();
    };
    // The pointer that made the selection must not close what it opened.
    const timer = setTimeout(() => window.addEventListener('pointerdown', down, true));
    window.addEventListener('keydown', key);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key);
    };
  }, [ref]);
}

function Swatches({ value, onPick }: { value?: string; onPick(color: string): void }) {
  return (
    <span className="pdf-swatches" role="group" aria-label={t('高亮颜色')}>
      {HIGHLIGHT_COLORS.map(({ color, name }) => (
        <button
          key={color}
          type="button"
          className="pdf-swatch"
          style={{ '--swatch': color } as CSSProperties}
          aria-label={t('{color}高亮', { color: t(name) })}
          aria-pressed={value === color}
          data-tooltip={t('{color}高亮', { color: t(name) })}
          onClick={() => onPick(color)}
        />
      ))}
    </span>
  );
}

/** What a selection on the page can become, right where it was made. */
export function SelectionToolbar({
  box,
  canAnnotate,
  onHighlight,
  onUnderline,
  onComment,
  onCopy,
  onAsk,
  onQuote,
  onClose,
}: {
  box: DOMRect;
  canAnnotate: boolean;
  onHighlight(color: string): void;
  onUnderline(): void;
  onComment(): void;
  onCopy(): void;
  onAsk(): void;
  onQuote?: () => void;
  onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose);
  const { top, left } = placement(box);
  return (
    <div
      ref={ref}
      className="pdf-selection-toolbar"
      role="toolbar"
      aria-label={t('选中文字')}
      style={{ top, left }}
      onMouseDown={(event) => event.preventDefault()}
    >
      {canAnnotate ? (
        <>
          <Swatches onPick={onHighlight} />
          <span className="pdf-toolbar-sep" />
          <Button variant="ghost" iconOnly size="sm" aria-label={t('下划线')} onClick={onUnderline}>
            <Underline />
          </Button>
          <Button variant="ghost" iconOnly size="sm" aria-label={t('批注')} onClick={onComment}>
            <MessageSquarePlus />
          </Button>
          <span className="pdf-toolbar-sep" />
        </>
      ) : null}
      <Button variant="ghost" iconOnly size="sm" aria-label={t('复制')} onClick={onCopy}>
        <Copy />
      </Button>
      {onQuote ? (
        <Button variant="ghost" iconOnly size="sm" aria-label={t('摘录到笔记')} onClick={onQuote}>
          <NotebookPen />
        </Button>
      ) : null}
      <Button variant="ghost" iconOnly size="sm" aria-label={t('问 AI')} onClick={onAsk}>
        <Mascot size={16} />
      </Button>
    </div>
  );
}

/** One highlight opened: its color, its comment, and removing it. */
export function AnnotationPopover({
  annotation,
  at,
  readOnly,
  focusComment,
  onChange,
  onDelete,
  onClose,
}: {
  annotation: PaperAnnotation;
  at: { top: number; bottom: number; left: number; width: number };
  readOnly: boolean;
  focusComment: boolean;
  onChange(next: PaperAnnotation): void;
  onDelete(): void;
  onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [comment, setComment] = useState(annotation.comment);
  const latest = useRef({ comment, annotation, onChange });
  latest.current = { comment, annotation, onChange };
  const finish = () => {
    const { comment, annotation, onChange } = latest.current;
    if (comment !== annotation.comment) onChange({ ...annotation, comment });
  };
  useDismiss(ref, () => {
    finish();
    onClose();
  });
  // Closing by any means keeps what was typed.
  useEffect(() => () => finish(), []);
  const { top, left } = placement(at);
  return (
    <div
      ref={ref}
      className="pdf-annotation-popover"
      role="dialog"
      aria-label={t('批注')}
      style={{ top, left }}
    >
      {annotation.text ? <blockquote>{annotation.text}</blockquote> : null}
      {readOnly ? (
        annotation.comment ? (
          <p className="pdf-annotation-comment">{annotation.comment}</p>
        ) : null
      ) : (
        <>
          <Textarea
            autoFocus={focusComment}
            value={comment}
            rows={3}
            aria-label={t('批注内容')}
            placeholder={t('写批注…')}
            onChange={(event) => setComment(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                finish();
                onClose();
              }
            }}
          />
          <div className="pdf-annotation-actions">
            {annotation.kind !== 'note' ? (
              <Swatches
                value={annotation.color}
                onPick={(color) => onChange({ ...annotation, comment, color })}
              />
            ) : null}
            <span className="spacer" />
            <Button
              variant="ghost"
              iconOnly
              size="sm"
              aria-label={t('删除批注')}
              onClick={() => {
                latest.current.comment = annotation.comment;
                onDelete();
              }}
            >
              <Trash2 />
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/** Every highlight and note in the paper, in reading order. */
export function AnnotationList({
  annotations,
  active,
  onOpen,
}: {
  annotations: PaperAnnotation[];
  active: string | null;
  onOpen(annotation: PaperAnnotation): void;
}) {
  return (
    <aside className="pdf-annotations" aria-label={t('批注列表')}>
      <header>
        {t('批注')}
        <span>{annotations.length}</span>
      </header>
      {annotations.length ? (
        <ol>
          {readingOrder(annotations).map((annotation) => (
            <li key={annotation.id}>
              <button
                type="button"
                className={`pdf-annotation-item${annotation.id === active ? ' is-active' : ''}`}
                style={{ '--highlight': annotation.color } as CSSProperties}
                onClick={() => onOpen(annotation)}
              >
                <span className="pdf-annotation-text">
                  {annotation.kind === 'note' ? <StickyNote /> : null}
                  {annotation.text || t('便签')}
                </span>
                {annotation.comment ? (
                  <span className="pdf-annotation-comment">{annotation.comment}</span>
                ) : null}
                <span className="pdf-annotation-page">
                  {t('第 {page} 页', { page: annotation.page + 1 })}
                </span>
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="pdf-annotations-empty">{t('选中文字即可高亮或批注')}</p>
      )}
    </aside>
  );
}
