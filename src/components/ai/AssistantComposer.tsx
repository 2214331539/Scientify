import { t } from '../../i18n';
import { ArrowUp } from 'lucide-react';
import type { Ref } from 'react';
import { Button, Textarea } from '../primitives';

interface Props {
  prompt: string;
  disabled: boolean;
  model: string;
  endpoint: string;
  includeContext: boolean;
  inputRef?: Ref<HTMLTextAreaElement>;
  onPromptChange: (value: string) => void;
  onSend: () => void;
  onConfigure: () => void;
}

export function AssistantComposer({
  prompt,
  disabled,
  model,
  endpoint,
  includeContext,
  inputRef,
  onPromptChange,
  onSend,
  onConfigure,
}: Props) {
  return (
    <form
      className="sf-ai-composer"
      onSubmit={(event) => {
        event.preventDefault();
        onSend();
      }}
    >
      <Textarea
        ref={inputRef}
        aria-label={t('向 AI 提问')}
        maxLength={12000}
        value={prompt}
        disabled={disabled}
        placeholder={t('Ask about this project...')}
        onChange={(event) => onPromptChange(event.target.value)}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            onSend();
          }
        }}
      />
      <div className="sf-ai-composer-actions">
        <Button
          variant="ghost"
          size="sm"
          className="sf-ai-model-control"
          type="button"
          title={model ? endpoint : t('模型设置')}
          onClick={onConfigure}
        >
          {model || t('Select model')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          iconOnly
          type="submit"
          aria-label={t('发送')}
          title={t('发送 · Ctrl + Enter')}
          disabled={disabled || !prompt.trim()}
        >
          <ArrowUp size={15} />
        </Button>
      </div>
      <small>{includeContext ? t('Context attached') : t('Context off')} · Ctrl + Enter</small>
    </form>
  );
}
