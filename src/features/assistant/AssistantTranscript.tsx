import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { openBrowserSource } from '../../platform/browser-pane';
import { ChevronRight, LoaderCircle } from 'lucide-react';
import { ApprovalCard } from '../../components/ai/ApprovalCard';
import { ChatMessageView } from '../../components/ai/ChatMessageView';
import { Button } from '../../components/primitives';
import type { ApprovalDecision, ApprovalRequest } from '../../platform/agent';
import { t } from '../../i18n';
import { initialAgentSession } from './agent-session';
import type { AgentTask } from './agent-runtime';
import type { ChatTask } from './chat-runtime';
import type { Conversation } from './model';
import { AssistantRuns } from './AssistantRuns';

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
}: Props) {
  const messagesRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const agentState = activeTask?.state ?? initialAgentSession;
  const [linkError, setLinkError] = useState('');
  const openLink = useCallback(
    (url: string) => {
      setLinkError('');
      void openBrowserSource(scope, url).catch((error) => setLinkError(String(error)));
    },
    [scope],
  );
  const onOpenLink = isTauri() && scope !== '__inbox__' ? openLink : undefined;
  const chatPending = !!chatTask?.pending;
  const operations = activeTask?.state.operations ?? conversation.agentRun?.operations ?? [];
  useEffect(() => {
    const pane = messagesRef.current;
    if (pane && pinnedToBottom.current) pane.scrollTop = pane.scrollHeight;
  }, [
    conversation.messages.length,
    conversation.id,
    agentState.agentText,
    agentPending,
    busy,
    chatTask?.text,
  ]);
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined' || !transcriptRef.current) return;
    const observer = new ResizeObserver(() => {
      const pane = messagesRef.current;
      if (pane && pinnedToBottom.current) pane.scrollTop = pane.scrollHeight;
    });
    observer.observe(transcriptRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={messagesRef}
      className="sf-chat-messages sf-aux-scroll"
      role="log"
      aria-label={t('对话消息')}
      aria-live="polite"
      onScroll={(event) => {
        const pane = event.currentTarget;
        pinnedToBottom.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 48;
      }}
    >
      <div className="sf-chat-transcript" ref={transcriptRef}>
        <AssistantRuns key={conversation.id} projectId={scope} conversationId={conversation.id} />
        {!conversation.messages.length ? (
          <div className="sf-ai-conversation-empty">
            {t('提问，或直接描述要在当前工作区完成的任务')}
          </div>
        ) : (
          conversation.messages.map((message) => (
            <ChatMessageView
              key={message.id}
              role={message.role}
              text={message.text}
              attachments={message.attachments}
              skills={message.skills}
              context={message.context}
              onOpenLink={onOpenLink}
            />
          ))
        )}
        {agentState.agentText &&
        !conversation.messages.some((message) => message.id === activeTask?.answerId) ? (
          <ChatMessageView
            role="assistant"
            text={agentState.agentText}
            streaming={agentPending}
            onOpenLink={onOpenLink}
          />
        ) : null}
        {chatTask?.text &&
        !conversation.messages.some((message) => message.id === chatTask.answerId) ? (
          <ChatMessageView
            role="assistant"
            text={chatTask.text}
            streaming={chatPending}
            onOpenLink={onOpenLink}
          />
        ) : null}
        {chatPending ? (
          <div className="sf-ai-progress" role="status">
            <LoaderCircle className="sf-ai-spinner" size={14} aria-hidden="true" />
            <span>{chatTask.stopping ? t('正在中止…') : t('正在回答…')}</span>
          </div>
        ) : null}
        {linkError ? (
          <div className="sf-aux-error" role="alert">
            {linkError}
          </div>
        ) : null}
        {agentPending && !agentState.approvals.length ? (
          <div className="sf-ai-progress sf-ai-agent-progress" role="status">
            <LoaderCircle className="sf-ai-spinner" size={14} aria-hidden="true" />
            <span>
              {agentState.phase === 'stopping'
                ? t('正在中止…')
                : activeTask?.starting
                  ? t('正在连接 Agent…')
                  : t('Agent 正在工作…')}
            </span>
          </div>
        ) : null}
        {agentState.sandbox === 'readOnly' ? (
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
        {operations.length ? (
          <details className="sf-ai-task-details">
            <summary className="sf-disclosure">
              <ChevronRight size={13} aria-hidden="true" />
              {t('执行记录')} · {operations.length}
            </summary>
            {operations.map((op) => (
              <div key={op.id}>
                <strong>{op.label}</strong>
                <span>{t(op.status)}</span>
                {op.output ? <pre>{op.output}</pre> : null}
              </div>
            ))}
          </details>
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
  );
}
