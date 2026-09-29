import { t } from '../../i18n';
import { ArrowUp, Bot, ChevronUp, MessageCircle, Paperclip } from 'lucide-react';
import type { Ref, MouseEvent } from 'react';
import { Button, Textarea } from '../primitives';

interface Props {
  prompt: string;
  disabled: boolean;
  model: string;
  endpoint: string;
  includeContext: boolean;
  contextLabel: string;
  inputRef?: Ref<HTMLTextAreaElement>;
  onPromptChange: (value: string) => void;
  onSend: () => void;
  onModelMenu: (event: MouseEvent<HTMLButtonElement>) => void;
  onContext: () => void;
  modelMenuOpen: boolean;
  agentMode: boolean;
  onAgentModeToggle: () => void;
}

export function AssistantComposer({
  prompt,
  disabled,
  model,
  endpoint,
  includeContext,
  contextLabel,
  inputRef,
  onPromptChange,
  onSend,
  onModelMenu,
  onContext,
  modelMenuOpen,
  agentMode,
  onAgentModeToggle,
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
        rows={2}
        value={prompt}
        disabled={disabled}
        placeholder={t('Ask about this project...')}
        onChange={(event) => onPromptChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            onSend();
          }
        }}
      />
      <div className="sf-ai-composer-actions">
        <Button
          variant="ghost"
          size="sm"
          type="button"
          className="sf-ai-mode-control"
          aria-label={agentMode ? t('切换到对话模式') : t('切换到 Agent 模式')}
          aria-pressed={agentMode}
          title={
            agentMode
              ? t('Agent 模式：可读取和修改当前工作区文件')
              : t('对话模式：只回答问题，不修改文件')
          }
          disabled={disabled}
          onClick={onAgentModeToggle}
        >
          {agentMode ? <Bot size={13} /> : <MessageCircle size={13} />}
          <span>{agentMode ? 'Agent' : t('对话')}</span>
        </Button>
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
          disabled={disabled}
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
          type="submit"
          aria-label={t('发送')}
          title={t('发送 · Enter；Shift + Enter 换行')}
          disabled={disabled || !prompt.trim()}
        >
          <ArrowUp size={15} />
        </Button>
      </div>
    </form>
  );
}
