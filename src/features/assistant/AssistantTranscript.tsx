import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { ArrowDown, LoaderCircle } from 'lucide-react';
import { Mascot } from '../../components/ai/Mascot';
import { ApprovalCard } from '../../components/ai/ApprovalCard';
import { ChatMessageView } from '../../components/ai/ChatMessageView';
import { Button } from '../../components/primitives';
import type { ApprovalDecision, ApprovalRequest } from '../../platform/agent';
import { t } from '../../i18n';
import { initialAgentSession } from './agent-session';
import type { AgentTask } from './agent-runtime';
import type { ChatTask } from './chat-runtime';
import type { ChatMessage, Conversation } from './model';
import { AssistantRuns } from './AssistantRuns';
import { TurnFiles, TurnProcess } from './TurnDetails';
import { ConversationRail, messageAnchor } from './ConversationRail';
import { locateFile, nativeResearch } from '../../platform/research';

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
};
const imageType = (path: string) =>
  IMAGE_TYPES[path.split('.').at(-1)?.toLowerCase() ?? ''] ?? 'application/octet-stream';

const GAP = 30 * 60_000;

/** "今天 13:54" above a message that starts a new stretch of the conversation. */
export function timeStamp(createdAt: string, previous?: string, now = new Date()) {
  const at = new Date(createdAt);
  if (Number.isNaN(at.getTime())) return '';
  if (previous) {
    const before = new Date(previous);
    if (
      !Number.isNaN(before.getTime()) &&
      at.getTime() - before.getTime() < GAP &&
      at.toDateString() === before.toDateString()
    )
      return '';
  }
  const time = at.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (at.toDateString() === now.toDateString()) return t('今天 {time}', { time });
  if (at.toDateString() === yesterday.toDateString()) return t('昨天 {time}', { time });
  return t('{month} 月 {day} 日 {time}', {
    month: at.getMonth() + 1,
    day: at.getDate(),
    time,
  });
}

interface Props {
  scope: string;
  conversation: Conversation;
  activeTask?: AgentTask;
  chatTask?: ChatTask;
  agentPending: boolean;
  busy: boolean;
  sandboxBusy: boolean;
  pinnedToBottom: RefObject<boolean>;
  onSetupSandbox?: () => void;
  onDecide(approval: ApprovalRequest, decision: ApprovalDecision): Promise<void>;
  /** Ask the last question again, or put it back in the composer to change it. */
  onRegenerate?(message: ChatMessage): void;
  onEdit?(message: ChatMessage): void;
  /** Put the files the last turn changed back as they were. */
  onUndo?(): Promise<void>;
}

/** Message rendering owns scroll-following, while task actions stay in the panel. */
export function AssistantTranscript({
  scope,
  conversation,
  activeTask,
  chatTask,
  agentPending,
  busy,
  sandboxBusy,
  pinnedToBottom,
  onSetupSandbox,
  onDecide,
  onRegenerate,
  onEdit,
  onUndo,
}: Props) {
  const messagesRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const agentState = activeTask?.state ?? initialAgentSession;
  // The page opens over the current module (App), so the answer stays in view.
  const openLink = useCallback(
    (url: string) =>
      window.dispatchEvent(
        new CustomEvent('scientify-preview-url', { detail: { projectId: scope, url } }),
      ),
    [scope],
  );
  const onOpenLink = isTauri() && scope !== '__inbox__' ? openLink : undefined;
  const local = isTauri() && scope !== '__inbox__';
  const onOpenFile = useCallback(
    (path: string) =>
      window.dispatchEvent(
        new CustomEvent('scientify-preview-file', { detail: { projectId: scope, path } }),
      ),
    [scope],
  );
  const loadImage = useCallback(
    async (path: string) => {
      const located = await locateFile(scope, path);
      if (!located || !nativeResearch.readBinary) return null;
      const bytes = await nativeResearch.readBinary(scope, located.path, located.root);
      return new Blob([new Uint8Array(bytes)], { type: imageType(path) });
    },
    [scope],
  );
  const messages = conversation.messages;
  const chatPending = !!chatTask?.pending;
  // Only the last exchange can be asked again, and only when nothing is running.
  const lastQuestion = messages.map((item) => item.role).lastIndexOf('user');
  const lastAnswer = messages.length - 1;
  const idle = !agentPending && !chatPending && !busy && lastQuestion >= 0;
  // The saved run belongs to the last question when it started after it was asked.
  const run = conversation.agentRun;
  const savedRun =
    !activeTask &&
    run &&
    lastQuestion >= 0 &&
    messages[lastAnswer]?.role === 'assistant' &&
    Date.parse(run.startedAt) >= Date.parse(messages[lastQuestion].createdAt) - 60_000
      ? run
      : undefined;
  const operations = activeTask?.state.operations ?? [];
  // What the Agent is doing right now, e.g. "搜索网页：…".
  const current = [...operations].reverse().find((op) => op.status === 'inProgress');
  const marks = useMemo(
    () => messages.filter((item) => item.role === 'user').map(({ id, text }) => ({ id, text })),
    [messages],
  );
  useEffect(() => {
    const pane = messagesRef.current;
    if (pane && pinnedToBottom.current) pane.scrollTop = pane.scrollHeight;
  }, [messages.length, conversation.id, agentState.agentText, agentPending, busy, chatTask?.text]);
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined' || !transcriptRef.current) return;
    const observer = new ResizeObserver(() => {
      const pane = messagesRef.current;
      if (pane && pinnedToBottom.current) pane.scrollTop = pane.scrollHeight;
    });
    observer.observe(transcriptRef.current);
    return () => observer.disconnect();
  }, []);
  const toBottom = () => {
    const pane = messagesRef.current;
    if (!pane) return;
    pinnedToBottom.current = true;
    pane.scrollTo({ top: pane.scrollHeight, behavior: 'smooth' });
  };
  const view = (message: ChatMessage, index: number) => (
    <ChatMessageView
      anchor={message.role === 'user' ? messageAnchor(message.id) : undefined}
      onRegenerate={
        onRegenerate && idle && message.role === 'assistant' && index === lastAnswer
          ? () => onRegenerate(messages[lastQuestion])
          : undefined
      }
      onEdit={
        onEdit && idle && message.role === 'user' && index === lastQuestion
          ? () => onEdit(message)
          : undefined
      }
      role={message.role}
      text={message.text}
      attachments={message.attachments}
      skills={message.skills}
      context={message.context}
      onOpenLink={onOpenLink}
      onOpenFile={local ? onOpenFile : undefined}
      loadImage={local ? loadImage : undefined}
    />
  );

  return (
    <div className="sf-chat-frame">
      <div
        ref={messagesRef}
        className="sf-chat-messages sf-aux-scroll"
        role="log"
        aria-label={t('对话消息')}
        aria-live="polite"
        onScroll={(event) => {
          const pane = event.currentTarget;
          const bottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 48;
          pinnedToBottom.current = bottom;
          setAtBottom(bottom);
        }}
      >
        <div className="sf-chat-transcript" ref={transcriptRef}>
          <AssistantRuns key={conversation.id} projectId={scope} conversationId={conversation.id} />
          {!messages.length ? (
            <div className="sf-ai-conversation-empty">
              <Mascot size={56} shadow />
              {t('提问，或直接描述要在当前工作区完成的任务')}
            </div>
          ) : (
            messages.map((message, index) => {
              const stamp = timeStamp(message.createdAt, messages[index - 1]?.createdAt);
              const answered = savedRun && index === lastAnswer;
              return (
                <Fragment key={message.id}>
                  {stamp ? <div className="sf-chat-stamp">{stamp}</div> : null}
                  {answered ? (
                    <TurnProcess
                      running={false}
                      startedAt={savedRun.startedAt}
                      completedAt={savedRun.completedAt}
                      reasoning={savedRun.reasoning}
                      plan={savedRun.plan ?? []}
                      operations={savedRun.operations}
                      diff={savedRun.diff}
                    />
                  ) : null}
                  {view(message, index)}
                  {answered ? (
                    <TurnFiles
                      files={savedRun.files ?? []}
                      cwd={conversation.agentCwd}
                      onOpen={local ? onOpenFile : undefined}
                      undone={savedRun.undone}
                      onUndo={
                        local && idle && savedRun.diff && !savedRun.diffCut ? onUndo : undefined
                      }
                    />
                  ) : null}
                </Fragment>
              );
            })
          )}
          {activeTask ? (
            <TurnProcess
              running={agentPending && !agentState.approvals.length}
              status={
                agentState.phase === 'stopping'
                  ? t('正在中止…')
                  : activeTask.starting
                    ? t('正在连接 Agent…')
                    : (current?.label ??
                      (agentState.thinkingSince && agentState.thoughtMs === null
                        ? t('正在思考…')
                        : undefined))
              }
              startedAt={activeTask.startedAt}
              reasoning={agentState.reasoning}
              plan={agentState.plan}
              operations={operations}
              diff={agentState.diff}
            />
          ) : null}
          {agentState.agentText &&
          !messages.some((message) => message.id === activeTask?.answerId) ? (
            <ChatMessageView
              role="assistant"
              text={agentState.agentText}
              streaming={agentPending}
              onOpenLink={onOpenLink}
              onOpenFile={local ? onOpenFile : undefined}
              loadImage={local ? loadImage : undefined}
            />
          ) : null}
          {activeTask ? (
            <TurnFiles
              files={agentState.files}
              cwd={agentState.cwd}
              onOpen={local ? onOpenFile : undefined}
            />
          ) : null}
          {chatTask?.text && !messages.some((message) => message.id === chatTask.answerId) ? (
            <ChatMessageView
              role="assistant"
              text={chatTask.text}
              streaming={chatPending}
              onOpenLink={onOpenLink}
            />
          ) : null}
          {chatPending ? (
            <div className="sf-ai-progress" role="status">
              <Mascot size={18} mood="thinking" />
              <span>{chatTask.stopping ? t('正在中止…') : t('正在回答…')}</span>
            </div>
          ) : null}
          {agentState.sandbox === 'readOnly' && conversation.agentPermission !== 'readonly' ? (
            <div className="sf-agent-sandbox-notice" role="status">
              <span>
                {t(
                  '当前 Windows 沙箱尚未配置，Agent 目前只能读取工作区。需要修改、删除或运行文件时，请先完成配置。',
                )}
              </span>
              {onSetupSandbox ? (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={sandboxBusy || busy || agentPending || !!activeTask?.saving}
                  onClick={onSetupSandbox}
                >
                  {sandboxBusy ? t('正在配置…') : t('配置 Windows 沙箱')}
                </Button>
              ) : null}
            </div>
          ) : null}
          {agentState.unsupportedRequests.length ? (
            <div role="alert" className="sf-aux-error">
              {t('此任务需要当前界面尚未支持的交互，请中止后重试。')}
              <code>{agentState.unsupportedRequests.join(', ')}</code>
            </div>
          ) : null}
          {agentState.approvals.map((approval) => (
            <ApprovalCard
              key={String(approval.id)}
              event={approval}
              busy={busy}
              onDecide={(decision) => onDecide(approval, decision)}
            />
          ))}
          {busy && !agentPending ? (
            <div className="sf-ai-progress" role="status">
              <LoaderCircle className="sf-ai-spinner" size={14} aria-hidden="true" />
              {t('正在处理…')}
            </div>
          ) : null}
        </div>
      </div>
      <ConversationRail marks={marks} pane={messagesRef} />
      {!atBottom ? (
        <button
          type="button"
          className="sf-chat-to-bottom"
          aria-label={t('回到最新')}
          onClick={toBottom}
        >
          <ArrowDown size={15} />
        </button>
      ) : null}
    </div>
  );
}
