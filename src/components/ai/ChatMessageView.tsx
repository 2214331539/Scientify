import { memo, useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { t } from '../../i18n';
import { usePreferences } from '../../i18n/preferences';
import { Markdown } from '../../features/notes/Markdown';
import { Button } from '../primitives';

/** Presentation only: copying never includes hidden research context or changes the conversation. */
export const ChatMessageView = memo(function ChatMessageView({
  role,
  text,
  streaming = false,
}: {
  role: 'user' | 'assistant';
  text: string;
  /** Keep the hot path cheap while the engine is still sending deltas. */
  streaming?: boolean;
}) {
  usePreferences();
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const copying = useRef(false);
  const mounted = useRef(true);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(resetTimer.current);
    };
  }, []);

  async function copy() {
    if (copying.current) return;
    copying.current = true;
    clearTimeout(resetTimer.current);
    try {
      await navigator.clipboard.writeText(text);
      if (!mounted.current) return;
      setCopyState('copied');
      resetTimer.current = setTimeout(() => setCopyState('idle'), 1800);
    } catch {
      if (mounted.current) setCopyState('error');
    } finally {
      copying.current = false;
    }
  }

  const feedback =
    copyState === 'copied' ? t('已复制') : copyState === 'error' ? t('复制失败，请重试') : '';
  return (
    <article
      className={`sf-chat-message sf-chat-${role}`}
      aria-label={role === 'user' ? t('用户消息') : t('助手消息')}
      data-copy-state={copyState}
    >
      {streaming ? (
        <div className="sf-chat-streaming-text">{text}</div>
      ) : (
        <Markdown>{text}</Markdown>
      )}
      <div className="sf-message-actions">
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          type="button"
          aria-label={t('复制消息')}
          tooltip={feedback || t('复制消息')}
          onClick={() => void copy()}
        >
          {copyState === 'copied' ? <Check size={13} /> : <Copy size={13} />}
        </Button>
      </div>
      <span className="sr-only" role="status">
        {feedback}
      </span>
    </article>
  );
});
