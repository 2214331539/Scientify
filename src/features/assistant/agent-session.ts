import {
  approvalResult,
  isApprovalRequest,
  type AgentBackend,
  type AgentConnection,
  type AgentDomain,
  type AgentEvent,
  type ApprovalDecision,
  type ApprovalRequest,
  type ThreadHandle,
} from '../../platform/agent';
import { t } from '../../i18n';

export type AgentPhase = 'idle' | 'opening' | 'running' | 'waiting' | 'stopping';
export type AgentOperation = { id: string; label: string; status: string; output: string };
export interface AgentSessionSnapshot {
  phase: AgentPhase;
  threadId: string | null;
  turnId: string | null;
  approvals: ApprovalRequest[];
  error: string | null;
  agentText: string;
  sandbox: string | null;
  cwd: string | null;
  outcome: 'completed' | 'failed' | 'interrupted' | null;
  operations: AgentOperation[];
  unsupportedRequests: string[];
}
export const initialAgentSession: AgentSessionSnapshot = {
  phase: 'idle',
  threadId: null,
  turnId: null,
  approvals: [],
  error: null,
  agentText: '',
  sandbox: null,
  cwd: null,
  outcome: null,
  operations: [],
  unsupportedRequests: [],
};
export function mergeApprovals(
  current: ApprovalRequest[],
  incoming: AgentEvent[],
): ApprovalRequest[] {
  const seen = new Set(current.map((e) => String(e.id)));
  const added = incoming.filter(isApprovalRequest).filter((e) => {
    if (seen.has(String(e.id))) return false;
    seen.add(String(e.id));
    return true;
  });
  return added.length ? [...current, ...added] : current;
}
export function resolveApproval(current: ApprovalRequest[], id: string | number) {
  return current.filter((e) => String(e.id) !== String(id));
}
export function hasPendingWork(snapshot: AgentSessionSnapshot) {
  return snapshot.phase !== 'idle';
}
const object = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' ? (value as Record<string, any>) : {};
const terminal = (value: unknown): value is 'completed' | 'failed' | 'interrupted' =>
  ['completed', 'failed', 'interrupted'].includes(String(value));

/** One conversation's protocol state. The application runtime owns its lifetime. */
export class AgentSession {
  private snapshot: AgentSessionSnapshot = { ...initialAgentSession };
  private polling: Promise<{ completed: boolean }> | null = null;
  private starting = false;
  private deciding = new Set<string>();
  private textItems = new Map<string, string>();
  private resolvedRequests = new Set<string>();
  handle: ThreadHandle | null = null;
  constructor(
    private readonly agent: AgentBackend,
    readonly binding: {
      projectId: string;
      domain: AgentDomain;
      conversationId: string;
      workspaceRoot?: string;
    },
    private readonly connection: AgentConnection,
    private readonly onUpdate: (snapshot: AgentSessionSnapshot) => void = () => {},
  ) {}
  get state() {
    return this.snapshot;
  }
  private set(patch: Partial<AgentSessionSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.onUpdate(this.snapshot);
  }
  private failure(reason: unknown) {
    const value = reason instanceof Error ? reason.message : String(reason);
    return this.connection.apiKey
      ? value.split(this.connection.apiKey).join(t('[已隐藏密钥]'))
      : value;
  }
  async open(): Promise<boolean> {
    this.set({ phase: 'opening', error: null });
    try {
      this.handle = await this.agent.startThread(
        this.binding.projectId,
        this.binding.domain,
        this.connection,
        {
          conversationId: this.binding.conversationId,
          ...(this.binding.workspaceRoot ? { workspaceRoot: this.binding.workspaceRoot } : {}),
        },
      );
      if (!this.handle.threadId) throw new Error(t('Agent 返回了空线程标识。'));
      this.set({
        phase: this.handle.activeTurnId ? 'running' : 'idle',
        threadId: this.handle.threadId,
        turnId: this.handle.activeTurnId ?? null,
        sandbox: this.handle.sandbox ?? null,
        cwd: this.handle.cwd ?? null,
      });
      this.consume(this.handle.events ?? []);
      return true;
    } catch (reason) {
      this.set({ phase: 'idle', threadId: null, error: this.failure(reason), outcome: 'failed' });
      return false;
    }
  }
  private consume(events: AgentEvent[]) {
    let state = { ...this.snapshot };
    for (const event of events) {
      const p = object(event.params);
      if (p.threadId && p.threadId !== state.threadId) continue;
      const turn = object(p.turn);
      const incomingTurn = p.turnId ?? turn.id;
      if (incomingTurn && state.turnId && incomingTurn !== state.turnId) continue;
      if (state.outcome) continue; // Ignore late events for an already completed turn.
      if (event.kind === 'request') {
        if (this.resolvedRequests.has(String(event.id))) continue;
        if (isApprovalRequest(event)) state.approvals = mergeApprovals(state.approvals, [event]);
        else if (!state.unsupportedRequests.includes(event.method))
          state.unsupportedRequests = [...state.unsupportedRequests, event.method];
        state.phase = 'waiting';
        continue;
      }
      if (event.method === 'turn/started' && !state.turnId) state.turnId = turn.id ?? null;
      if (event.method === 'item/agentMessage/delta') {
        const id = String(p.itemId ?? 'answer');
        this.textItems.set(id, (this.textItems.get(id) ?? '') + String(p.delta ?? ''));
        state.agentText = [...this.textItems.values()].join('\n\n');
      }
      if (event.method === 'item/completed' && p.item?.type === 'agentMessage') {
        this.textItems.set(String(p.item.id ?? 'answer'), String(p.item.text ?? ''));
        state.agentText = [...this.textItems.values()].join('\n\n');
      }
      if ((event.method === 'item/started' || event.method === 'item/completed') && p.item) {
        const item = object(p.item);
        if (
          [
            'commandExecution',
            'fileChange',
            'mcpToolCall',
            'webSearch',
            'dynamicToolCall',
          ].includes(item.type)
        ) {
          const label = String(
            item.command ??
              item.tool ??
              item.query ??
              (item.changes?.map((c: any) => c.path).join(', ') || item.type),
          );
          const operation = {
            id: String(item.id),
            label,
            status: String(
              item.status ?? (event.method === 'item/completed' ? 'completed' : 'running'),
            ),
            output: String(
              item.aggregatedOutput ??
                item.contentItems?.map((c: any) => c.text ?? '').join('\n') ??
                item.result ??
                '',
            ).slice(-32000),
          };
          state.operations = [
            ...state.operations.filter((e) => e.id !== operation.id),
            operation,
          ].slice(-100);
        }
      }
      if (event.method === 'item/commandExecution/outputDelta') {
        state.operations = state.operations.map((op) =>
          op.id === p.itemId
            ? { ...op, output: (op.output + String(p.delta ?? '')).slice(-32000) }
            : op,
        );
      }
      if (event.method === 'error' && !p.willRetry)
        state.error = this.failure(p.error?.message ?? p.message ?? t('Agent 任务失败。'));
      if (event.method === 'turn/completed') {
        state.outcome = terminal(turn.status) ? turn.status : 'completed';
        state.error = turn.error?.message ? this.failure(turn.error.message) : state.error;
        // Some providers emit the final items only in turn/completed.
        for (const item of turn.items ?? [])
          if (item.type === 'agentMessage')
            this.textItems.set(String(item.id ?? 'answer'), String(item.text ?? ''));
        state.agentText = [...this.textItems.values()].join('\n\n');
        state.phase = 'idle';
        state.approvals = [];
        state.unsupportedRequests = [];
      }
    }
    this.set(state);
  }
  async send(text: string): Promise<boolean> {
    if (!this.snapshot.threadId || hasPendingWork(this.snapshot)) return false;
    this.starting = true;
    this.textItems.clear();
    this.resolvedRequests.clear();
    this.set({
      phase: 'running',
      turnId: null,
      error: null,
      agentText: '',
      outcome: null,
      approvals: [],
      operations: [],
      unsupportedRequests: [],
    });
    try {
      const turn = await this.agent.startTurn({
        ...this.binding,
        threadId: this.snapshot.threadId!,
        text,
      });
      if (!turn.turnId) throw new Error(t('Agent 返回了空 turn 标识。'));
      this.set({ turnId: turn.turnId });
      this.consume(turn.events);
      if (terminal(turn.status))
        this.set({ phase: 'idle', outcome: turn.status, approvals: [], unsupportedRequests: [] });
      this.starting = false;
      await this.poll();
      return true;
    } catch (reason) {
      this.set({
        phase: 'idle',
        error: this.failure(reason),
        outcome: 'failed',
        threadId: null,
        approvals: [],
      });
      return false;
    } finally {
      this.starting = false;
    }
  }
  poll(): Promise<{ completed: boolean }> {
    if (this.polling) return this.polling;
    if (this.starting || !this.snapshot.threadId) return Promise.resolve({ completed: false });
    const work = async () => {
      try {
        const events = await this.agent.events(
          this.binding.projectId,
          this.binding.domain,
          this.binding.conversationId,
          this.snapshot.threadId!,
        );
        if (events.length) this.consume(events);
        return { completed: this.snapshot.phase === 'idle' };
      } catch (reason) {
        this.set({
          phase: 'idle',
          error: this.failure(reason),
          outcome: 'failed',
          threadId: null,
          approvals: [],
        });
        return { completed: true };
      } finally {
        this.polling = null;
      }
    };
    this.polling = work();
    return this.polling;
  }
  async interrupt(): Promise<boolean> {
    const { threadId, turnId } = this.snapshot;
    if (
      !threadId ||
      !turnId ||
      !this.agent.interrupt ||
      !hasPendingWork(this.snapshot) ||
      this.snapshot.phase === 'stopping'
    )
      return false;
    this.set({ phase: 'stopping', error: null });
    try {
      await this.agent.interrupt({ ...this.binding, threadId, turnId });
      await this.poll();
      return true;
    } catch (reason) {
      if (hasPendingWork(this.snapshot))
        this.set({ phase: 'running', error: this.failure(reason) });
      return false;
    }
  }
  async decide(approval: ApprovalRequest, decision: ApprovalDecision): Promise<boolean> {
    const key = String(approval.id);
    if (this.deciding.has(key) || !this.snapshot.approvals.some((e) => String(e.id) === key))
      return false;
    this.deciding.add(key);
    try {
      // Permissions approval has no cancel variant. Stop the turn explicitly.
      if (decision === 'cancel') return await this.interrupt();
      await this.agent.respond({
        ...this.binding,
        id: approval.id,
        result: approvalResult(decision, approval),
      });
      this.resolvedRequests.add(key);
      if (this.snapshot.outcome) return true;
      const approvals = resolveApproval(this.snapshot.approvals, approval.id);
      this.set({ approvals, phase: approvals.length ? 'waiting' : 'running' });
      await this.poll();
      return true;
    } catch (reason) {
      this.set({ error: this.failure(reason) });
      return false;
    } finally {
      this.deciding.delete(key);
    }
  }
}
