import { useState } from 'react';
import { ChevronDown, LoaderCircle, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '../../components/primitives';
import { Menu, menuAnchor, type MenuAnchor } from '../../components/primitives/Menu';
import { t } from '../../i18n';
import type { Workspace } from '../../domain/workspace';
import type { AgentRuntime } from './agent-runtime';
import type { ChatRuntime } from './chat-runtime';
import type { Conversation } from './model';

export type AssistantMenu = {
  kind: 'sessions' | 'tools' | 'models' | 'permissions';
  anchor: MenuAnchor;
};

interface Props {
  scope: string;
  conversation: Conversation;
  history: Workspace['sessions'];
  runtime: AgentRuntime;
  chatRuntime: ChatRuntime;
  disabled: boolean;
  menu: AssistantMenu | null;
  onOpenMenu(kind: 'sessions' | 'tools', trigger: HTMLButtonElement): void;
  onCloseMenu(): void;
  onSelect(id: string): void;
  onRename(id: string): Promise<void>;
  onDelete(id: string): Promise<void>;
}

/** Conversation navigation reads task status; the runtimes still own execution. */
export function AssistantConversations({
  scope,
  conversation,
  history,
  runtime,
  chatRuntime,
  disabled,
  menu,
  onOpenMenu,
  onCloseMenu,
  onSelect,
  onRename,
  onDelete,
}: Props) {
  // `list` is the button that opened the conversation list: after renaming or
  // deleting from the right-click menu the list opens again, as it was.
  const [action, setAction] = useState<{
    id: string;
    anchor: MenuAnchor;
    list?: HTMLElement | null;
  } | null>(null);
  const reopen = (list?: HTMLElement | null) => {
    if (list instanceof HTMLButtonElement && list.isConnected) onOpenMenu('sessions', list);
  };
  // Finds past chats by title or by what was said in them.
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const matches = (item: Workspace['sessions'][number]) =>
    !needle ||
    String(item.title ?? '')
      .toLowerCase()
      .includes(needle) ||
    (Array.isArray(item.messages) &&
      item.messages.some(
        (message: { text?: unknown }) =>
          typeof message?.text === 'string' && message.text.toLowerCase().includes(needle),
      ));
  const backgroundTasks = [...runtime.tasks.values(), ...chatRuntime.tasks.values()].filter(
    (task) =>
      task.projectId === scope &&
      task.conversationId !== conversation.id &&
      (task.saveError || ('state' in task ? runtime.pending(task) : task.pending || task.saving)),
  );
  const agentTask = action ? runtime.get(scope, action.id) : undefined;
  const chatTask = action ? chatRuntime.get(scope, action.id) : undefined;
  const deleteDisabled =
    disabled ||
    !!(agentTask && (runtime.pending(agentTask) || agentTask.saveError)) ||
    !!(chatTask && (chatTask.pending || chatTask.saving || chatTask.saveError));

  return (
    <>
      <div className="sf-ai-session-header">
        <Button
          variant="ghost"
          className="sf-ai-session-title"
          aria-label={t('当前 AI 对话')}
          aria-haspopup="menu"
          aria-expanded={menu?.kind === 'sessions'}
          disabled={disabled}
          title={conversation.title}
          onClick={(event) => onOpenMenu('sessions', event.currentTarget)}
        >
          <span>
            {conversation.messages.length || conversation.title !== t('新对话')
              ? conversation.title
              : t('新对话')}
          </span>
          <ChevronDown size={12} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={t('新建 AI 对话')}
          tooltip={t('新建 AI 对话')}
          disabled={disabled}
          onClick={() => onSelect('')}
        >
          <Plus size={15} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={t('对话选项')}
          aria-haspopup="menu"
          aria-expanded={menu?.kind === 'tools'}
          onClick={(event) => onOpenMenu('tools', event.currentTarget)}
        >
          <MoreHorizontal size={16} />
        </Button>
      </div>
      {backgroundTasks.length ? (
        <div className="sf-ai-background-tasks" aria-label={t('后台任务')}>
          {backgroundTasks.map((task) => (
            <Button
              key={task.conversationId}
              variant="ghost"
              size="sm"
              onClick={() => onSelect(task.conversationId)}
            >
              <LoaderCircle className="sf-ai-spinner" size={12} />
              <span>
                {String(
                  history.find((item) => item.id === task.conversationId)?.title ?? t('历史对话'),
                )}
              </span>
              <span>
                {task.saveError
                  ? t('待保存')
                  : 'state' in task
                    ? task.state.phase === 'waiting'
                      ? t('等待审批')
                      : task.state.phase === 'stopping'
                        ? t('正在中止…')
                        : t('运行中')
                    : task.stopping
                      ? t('正在中止…')
                      : t('运行中')}
              </span>
            </Button>
          ))}
        </div>
      ) : null}
      <Menu
        anchor={menu?.kind === 'sessions' ? menu.anchor : null}
        label={t('历史对话')}
        onClose={onCloseMenu}
      >
        <Button role="menuitem" variant="ghost" onClick={() => onSelect('')}>
          <Plus size={14} />
          {t('新建 AI 对话')}
        </Button>
        {history.length > 6 ? (
          <input
            className="sf-ai-session-search"
            type="search"
            value={query}
            placeholder={t('搜索对话')}
            aria-label={t('搜索对话')}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
          />
        ) : null}
        <div className="sf-ai-session-list">
          {[...history]
            .filter(matches)
            .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
            .map((item) => {
              const task = runtime.get(scope, item.id);
              const running =
                (task && runtime.pending(task)) || chatRuntime.get(scope, item.id)?.pending;
              return (
                <Button
                  key={item.id}
                  role="menuitemradio"
                  aria-checked={item.id === conversation.id}
                  variant="ghost"
                  onContextMenu={(event) => {
                    if (disabled) return;
                    event.preventDefault();
                    event.stopPropagation();
                    // The list stays open under the right-click menu.
                    setAction({
                      id: item.id,
                      anchor: menuAnchor(event),
                      list: menu?.anchor.trigger,
                    });
                  }}
                  onKeyDown={(event) => {
                    if (
                      (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) &&
                      !disabled
                    ) {
                      event.preventDefault();
                      setAction({
                        id: item.id,
                        anchor: menuAnchor(event),
                        list: menu?.anchor.trigger,
                      });
                    }
                  }}
                  onClick={() => onSelect(item.id)}
                >
                  <span className="sf-ai-session-name">{String(item.title || t('历史对话'))}</span>
                  {running ? (
                    <LoaderCircle
                      className="sf-ai-spinner"
                      size={12}
                      aria-label={t('任务进行中')}
                    />
                  ) : null}
                </Button>
              );
            })}
        </div>
      </Menu>
      <Menu
        anchor={action?.anchor ?? null}
        label={t('对话操作')}
        nested
        onClose={() => setAction(null)}
      >
        {action ? (
          <>
            <Button
              variant="ghost"
              role="menuitem"
              disabled={disabled}
              onClick={() => void onRename(action.id).finally(() => reopen(action.list))}
            >
              <Pencil size={14} />
              {t('重命名对话')}
            </Button>
            <div role="separator" className="sf-menu-separator" />
            <Button
              variant="ghost"
              role="menuitem"
              className="sf-menu-danger"
              disabled={deleteDisabled}
              onClick={() => void onDelete(action.id).finally(() => reopen(action.list))}
            >
              <Trash2 size={14} />
              {t('删除对话')}
            </Button>
          </>
        ) : null}
      </Menu>
    </>
  );
}
