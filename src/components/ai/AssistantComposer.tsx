import { t } from '../../i18n';
import { ArrowUp, ChevronUp, CornerDownLeft, LoaderCircle, Shield, Square } from 'lucide-react';
import { useEffect, useId, useRef, useState, type Ref, type MouseEvent } from 'react';
import { Button, Textarea } from '../primitives';
import type { ChatAttachment } from '../../features/assistant/model';
import type { AgentSkill, AgentSkillRef, PermissionMode } from '../../platform/agent';
import {
  bindingFor,
  eventToShortcut,
  normalizeShortcut,
  type ShortcutSettings,
} from '../../platform/shortcuts';

export type ComposerCommand = 'new' | 'context' | 'stop';
const commands = [
  { id: 'permission', aliases: ['permissions'], description: '设置当前会话的执行权限' },
  { id: 'skills', aliases: ['skill'], description: '选择当前工作区可用的技能' },
  { id: 'model', aliases: [], description: '选择模型或配置连接' },
  { id: 'new', aliases: [], description: '新建独立会话' },
  { id: 'context', aliases: [], description: '查看当前材料' },
  { id: 'stop', aliases: [], description: '中止当前任务' },
] as const;

interface Props {
  prompt: string;
  disabled: boolean;
  isBusy: boolean;
  canInterrupt: boolean;
  canSteer?: boolean;
  onSteer?: () => void;
  model: string;
  endpoint: string;
  inputRef?: Ref<HTMLTextAreaElement>;
  onPromptChange: (value: string) => void;
  onSend: () => void;
  onInterrupt: () => void;
  onModelMenu: (event: MouseEvent<HTMLButtonElement>) => void;
  modelMenuOpen: boolean;
  attachments?: ChatAttachment[];
  onAttach?: (files: File[]) => void;
  onRemoveAttachment?: (index: number) => void;
  permission?: PermissionMode;
  permissionDisabled?: boolean;
  permissionMenuOpen?: boolean;
  onPermissionMenu?: (trigger: HTMLButtonElement) => void;
  onCommand?: (command: ComposerCommand) => void;
  canNewConversation?: boolean;
  skills?: AgentSkill[];
  skillsLoading?: boolean;
  skillsErrors?: string[];
  skillsAvailable?: boolean;
  onSkillsOpen?: () => void;
  onSkillsRefresh?: () => void;
  selectedSkills?: AgentSkillRef[];
  onSelectSkill?: (skill: AgentSkillRef) => void;
  onRemoveSkill?: (index: number) => void;
  shortcuts?: ShortcutSettings;
}

export function AssistantComposer({
  prompt,
  disabled,
  isBusy,
  canInterrupt,
  canSteer: supportsSteer = false,
  onSteer,
  model,
  endpoint,
  inputRef,
  onPromptChange,
  onSend,
  onInterrupt,
  onModelMenu,
  modelMenuOpen,
  attachments = [],
  onAttach,
  onRemoveAttachment,
  permission = 'ask',
  permissionDisabled = false,
  permissionMenuOpen = false,
  onPermissionMenu,
  onCommand,
  canNewConversation = true,
  skills = [],
  skillsLoading = false,
  skillsErrors = [],
  skillsAvailable = false,
  onSkillsOpen,
  onSkillsRefresh,
  selectedSkills = [],
  onSelectSkill,
  onRemoveSkill,
  shortcuts,
}: Props) {
  const [dragging, setDragging] = useState(false);
  const modelButton = useRef<HTMLButtonElement>(null);
  const permissionButton = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [cursor, setCursor] = useState({ query: '', index: 0 });
  const slash = /^\/([a-z]*)(?: ([^\n]*))?$/i.exec(prompt);
  const skillMode =
    !!slash && ['skill', 'skills'].includes(slash[1].toLowerCase()) && slash[2] !== undefined;
  const query = skillMode ? slash![2].toLowerCase() : (slash?.[1].toLowerCase() ?? '');
  const options = skillMode
    ? skills
        .filter(
          (skill) =>
            skill.enabled &&
            `${skill.name} ${skill.description}`.toLowerCase().includes(query) &&
            !selectedSkills.some((item) => item.path === skill.path),
        )
        .map((skill) => ({
          id: skill.path,
          label: skill.name,
          description: skill.description,
          skill,
        }))
    : commands
        .filter((command) =>
          [command.id, ...command.aliases].some((name) => name.startsWith(query)),
        )
        .map((command) => ({
          id: command.id,
          label: `/${command.id}`,
          description: t(command.description),
          skill: undefined,
        }));
  const commandsOpen =
    !!slash && dismissed !== prompt && (skillMode || (!slash[2]?.trim() && options.length > 0));
  const activeIndex = Math.min(
    cursor.query === prompt ? cursor.index : 0,
    Math.max(0, options.length - 1),
  );
  useEffect(() => {
    if (commandsOpen && skillMode) onSkillsOpen?.();
  }, [commandsOpen, skillMode, onSkillsOpen]);
  useEffect(() => {
    if (commandsOpen)
      document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [commandsOpen, activeIndex, listId]);
  function optionDisabled(option: (typeof options)[number]) {
    if (option.skill) return !skillsAvailable || selectedSkills.length >= 4;
    if (option.id === 'permission') return permissionDisabled;
    if (option.id === 'model') return disabled || isBusy;
    if (option.id === 'stop') return !canInterrupt;
    if (option.id === 'new') return !canNewConversation;
    return false;
  }
  function choose(index: number) {
    const option = options[index];
    if (!option || optionDisabled(option)) return;
    if (option.skill) {
      onSelectSkill?.({ name: option.skill.name, path: option.skill.path });
      onPromptChange('');
      return;
    }
    if (option.id === 'skills') {
      onPromptChange('/skills ');
      return;
    }
    onPromptChange('');
    if (option.id === 'permission' && permissionButton.current)
      onPermissionMenu?.(permissionButton.current);
    else if (option.id === 'model') modelButton.current?.click();
    else onCommand?.(option.id as ComposerCommand);
  }
  function submit() {
    if (commandsOpen) {
      choose(activeIndex);
      return;
    }
    if (isBusy) {
      if (canSteer && !disabled && prompt.trim()) onSteer?.();
    } else if (!disabled) onSend();
  }
  // Attachment steering is intentionally separate from ordinary text steering.
  const canSteer = supportsSteer && !attachments.length && !selectedSkills.length;
  return (
    <form
      className="sf-ai-composer"
      data-dragging={dragging || undefined}
      onPaste={(event) => {
        const files = Array.from(event.clipboardData.files);
        if (!files.length) return;
        event.preventDefault();
        onAttach?.(files);
      }}
      onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.items).some((item) => item.kind === 'file')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(event) => {
        setDragging(false);
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        event.stopPropagation();
        onAttach?.(Array.from(event.dataTransfer.files));
      }}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {commandsOpen ? (
        <div className="sf-ai-command-menu sf-popover" data-state="open" data-native-overlay="true">
          <div className="sf-ai-command-heading">
            <span>{skillMode ? t('选择技能') : t('快捷命令')}</span>
            {skillMode && skillsAvailable ? (
              <Button variant="ghost" size="sm" type="button" onClick={onSkillsRefresh}>
                {t('刷新技能')}
              </Button>
            ) : null}
          </div>
          {skillMode && !skillsAvailable ? (
            <p role="status">{t('请在项目中使用支持 Agent 的连接以选择技能。')}</p>
          ) : null}
          {skillMode && skillsLoading ? <p role="status">{t('正在读取技能…')}</p> : null}
          {skillMode
            ? skillsErrors.map((message, index) => (
                <p role="status" key={index}>
                  {message}
                </p>
              ))
            : null}
          {skillMode && selectedSkills.length >= 4 ? (
            <p role="status">{t('每条消息最多选择 4 个技能。')}</p>
          ) : null}
          <div role="listbox" id={listId} aria-label={skillMode ? t('可用技能') : t('快捷命令')}>
            {options.map((option, index) => {
              const unavailable = optionDisabled(option);
              return (
                <div
                  key={option.id}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  aria-disabled={unavailable || undefined}
                  className="sf-ai-command-option"
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setCursor({ query: prompt, index })}
                  onClick={() => {
                    if (!unavailable) choose(index);
                  }}
                >
                  <strong>{option.label}</strong>
                  <span>{option.description}</span>
                </div>
              );
            })}
          </div>
          {skillMode && skillsAvailable && !skillsLoading && !options.length ? (
            <p role="status">
              {t(
                '没有匹配的可用技能。技能需先安装到工作区 .agents/skills 或 Scientify 的 Codex 数据目录。',
              )}
            </p>
          ) : null}
          <div className="sf-ai-command-hint">{t('↑ ↓ 选择 · Enter 确认 · Esc 关闭')}</div>
        </div>
      ) : null}
      <Textarea
        ref={inputRef}
        aria-label={t('向 AI 提问')}
        maxLength={12000}
        rows={2}
        value={prompt}
        placeholder={t('Ask about this project...')}
        aria-autocomplete="list"
        aria-controls={commandsOpen ? listId : undefined}
        aria-activedescendant={
          commandsOpen && options.length ? `${listId}-${activeIndex}` : undefined
        }
        onChange={(event) => {
          setDismissed(null);
          onPromptChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (commandsOpen && event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setDismissed(prompt);
            return;
          }
          if (commandsOpen && ['ArrowDown', 'ArrowUp'].includes(event.key) && options.length) {
            event.preventDefault();
            setCursor({
              query: prompt,
              index:
                (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + options.length) %
                options.length,
            });
            return;
          }
          const pressedShortcut = eventToShortcut(event.nativeEvent);
          const stopShortcut = bindingFor(shortcuts, 'assistant.stop');
          const sendShortcut = bindingFor(shortcuts, 'assistant.send');
          if (
            isBusy &&
            stopShortcut?.enabled !== false &&
            pressedShortcut === normalizeShortcut(stopShortcut?.keys ?? 'Escape')
          ) {
            event.preventDefault();
            onInterrupt();
            return;
          }
          if (
            sendShortcut?.enabled !== false &&
            pressedShortcut === normalizeShortcut(sendShortcut?.keys ?? 'Mod+Enter')
          ) {
            event.preventDefault();
            submit();
            return;
          }
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
      />
      {selectedSkills.length ? (
        <div className="sf-ai-attachments" aria-label={t('待发送技能')}>
          {selectedSkills.map((skill, index) => (
            <span className="sf-ai-attachment" key={skill.path}>
              <span>{skill.name}</span>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                type="button"
                aria-label={t('移除技能 {name}', { name: skill.name })}
                onClick={() => onRemoveSkill?.(index)}
              >
                ×
              </Button>
            </span>
          ))}
        </div>
      ) : null}
      {attachments.length ? (
        <div className="sf-ai-attachments" aria-label={t('待发送附件')}>
          {attachments.map((attachment, index) => (
            <span className="sf-ai-attachment" key={`${attachment.name}-${index}`}>
              {attachment.mimeType.startsWith('image/') ? (
                <img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt="" />
              ) : (
                <span aria-hidden="true">
                  {attachment.mimeType === 'application/pdf' ? 'PDF' : 'TXT'}
                </span>
              )}
              <span>{attachment.name}</span>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                type="button"
                aria-label={t(attachment.mimeType.startsWith('image/') ? '移除图片' : '移除附件')}
                onClick={() => onRemoveAttachment?.(index)}
              >
                ×
              </Button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="sf-ai-composer-actions">
        <Button
          ref={modelButton}
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
        <Button
          ref={permissionButton}
          variant="ghost"
          size="sm"
          type="button"
          className="sf-ai-model-control sf-ai-permission-control"
          aria-label={t('执行权限')}
          aria-haspopup="menu"
          aria-expanded={permissionMenuOpen}
          disabled={permissionDisabled}
          title={
            permissionDisabled ? t('当前任务或保存结束后可切换权限') : t('设置当前会话的执行权限')
          }
          data-permission={permission}
          onClick={(event) => onPermissionMenu?.(event.currentTarget)}
        >
          <Shield size={12} />
          <span>
            <span className="sf-ai-permission-prefix">{t('Permission')} · </span>
            {permission === 'full' ? t('完全允许') : t('询问')}
          </span>
          <ChevronUp size={12} />
        </Button>
        <span className="sf-spacer" />
        {isBusy && prompt.trim() && canSteer ? (
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            type="submit"
            aria-label={t('补充指令')}
            tooltip={t('补充指令')}
            disabled={disabled}
          >
            <CornerDownLeft size={15} />
          </Button>
        ) : null}
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
          disabled={isBusy ? !canInterrupt : disabled || (!prompt.trim() && !attachments.length)}
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
