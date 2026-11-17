import { useEffect, useState, type RefObject } from 'react';
import { t } from '../../i18n';

export type RailMark = { id: string; text: string };

/** The DOM id of a message, for the rail to scroll to. */
export const messageAnchor = (id: string) => `sf-message-${id}`;

/**
 * Short marks along the right edge, one per question: hover one to read the
 * question, click to jump to it. The mark of the question in view is darker.
 */
export function ConversationRail({
  marks,
  pane,
}: {
  marks: RailMark[];
  pane: RefObject<HTMLDivElement | null>;
}) {
  const [current, setCurrent] = useState('');
  useEffect(() => {
    const root = pane.current;
    if (!root || typeof IntersectionObserver === 'undefined' || marks.length < 3) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting);
        if (visible.length) setCurrent(visible[0].target.id);
      },
      { root, rootMargin: '0px 0px -60% 0px' },
    );
    for (const mark of marks) {
      const element = document.getElementById(messageAnchor(mark.id));
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [marks, pane]);
  if (marks.length < 3) return null;
  return (
    <nav className="sf-chat-rail" aria-label={t('对话导航')}>
      {marks.map((mark) => {
        const label = mark.text.replace(/\s+/g, ' ').trim().slice(0, 80) || t('（附件）');
        return (
          <button
            key={mark.id}
            type="button"
            className="sf-chat-rail-mark"
            aria-current={current === messageAnchor(mark.id) || undefined}
            aria-label={label}
            data-label={label}
            onClick={() =>
              document
                .getElementById(messageAnchor(mark.id))
                ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }
          />
        );
      })}
    </nav>
  );
}
