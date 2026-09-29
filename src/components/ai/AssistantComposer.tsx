import { t } from '../../i18n';
import { ArrowUp, ChevronUp, LoaderCircle, Paperclip, Square } from 'lucide-react';
import type { Ref, MouseEvent } from 'react';
import { Button, Textarea } from '../primitives';

interface Props {
  prompt: string;
  disabled: boolean;
  isBusy: boolean;
  canInterrupt: boolean;
  model: string;
  endpoint: string;
  includeContext: boolean;
  contextLabel: string;
  inputRef?: Ref<HTMLTextAreaElement>;
  onPromptChange: (value: string) => void;
  onSend: () => void;
  onInterrupt: () => void;
  onModelMenu: (event: MouseEvent<HTMLButtonElement>) => void;
  onContext: () => void;
  modelMenuOpen: boolean;
}

export function AssistantComposer({
  prompt,
  disabled,
  isBusy,
  canInterrupt,
  model,
  endpoint,
  includeContext,
  contextLabel,
  inputRef,
  onPromptChange,
  onSend,
  onInterrupt,
  onModelMenu,
  onContext,
  modelMenuOpen,
}: Props) {
  return (
    <form
      className="sf-ai-composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (isBusy) {
          if (canInterrupt) onInterrupt();
        } else onSend();
      }}
    >
      <Textarea
        ref={inputRef}
        aria-label={t('向 AI 提问')}
        maxLength={12000}
        rows={2}
        value={prompt}
        disabled={disabled || isBusy}
        placeholder={t('Ask about this project...')}
        onChange={(event) => onPromptChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            if (isBusy) {
              if (canInterrupt) onInterrupt();
            } else onSend();
          }
        }}
      />
      <div className="sf-ai-composer-actions">
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          type="button"
          aria-label={t('查看当前材料')}
          aria-pressed={includeContext}
          tooltip={includeContext ? contextLabel : t('Context off')}
          onClick={onContext}
        >
          <Paperclip size={14} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="sf-ai-model-control"
          type="button"
          title={model ? endpoint : t('模型设置')}
          aria-label={t('选择模型')}
          aria-haspopup="menu"
          aria-expanded={modelMenuOpen}
          disabled={disabled || isBusy}
          onClick={onModelMenu}
        >
          <span>{model || t('Select model')}</span>
          <ChevronUp size={12} />
        </Button>
        <span className="sf-spacer" />
        <Button
          variant="primary"
          size="sm"
          iconOnly
          type={isBusy ? 'button' : 'submit'}
          aria-label={isBusy ? (canInterrupt ? t('中止任务') : t('正在处理')) : t('发送')}
          title={
            isBusy
              ? canInterrupt
                ? t('中止本次会话')
                : t('正在处理')
              : t('发送 · Enter；Shift + Enter 换行')
          }
          disabled={isBusy ? !canInterrupt : disabled || !prompt.trim()}
          onClick={isBusy && canInterrupt ? onInterrupt : undefined}
        >
          {isBusy ? (
            canInterrupt ? (
              <Square size={13} fill="currentColor" />
            ) : (
              <LoaderCircle className="sf-ai-spinner" size={15} />
            )
          ) : (
            <ArrowUp size={15} />
          )}
        </Button>
      </div>
    </form>
  );
}
