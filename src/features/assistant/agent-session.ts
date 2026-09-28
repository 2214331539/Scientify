import {
  approvalResult,
  isApprovalRequest,
  type AgentBackend,
  type AgentConnection,
  type AgentDomain,
  type AgentEvent,
  type ApprovalDecision,
  type ApprovalRequest,
} from '../../platform/agent';
import { t } from '../../i18n';

export type AgentPhase = 'idle' | 'opening' | 'running' | 'waiting';

export interface AgentSessionSnapshot {
  phase: AgentPhase;
  threadId: string | null;
  approvals: ApprovalRequest[];
  error: string | null;
}

export const initialAgentSession: AgentSessionSnapshot = {
  phase: 'idle',
  threadId: null,
  approvals: [],
  error: null,
};

/**
 * Requests are identified by id, so an approval the engine repeats is not shown
 * twice. Order is preserved because a turn can ask for several in sequence.
 */
export function mergeApprovals(
  current: ApprovalRequest[],
  incoming: AgentEvent[],
): ApprovalRequest[] {
  const seen = new Set(current.map((entry) => String(entry.id)));
  const added = incoming.filter(isApprovalRequest).filter((entry) => !seen.has(String(entry.id)));
  return added.length ? [...current, ...added] : current;
}

export function resolveApproval(
  current: ApprovalRequest[],
  id: string | number,
): ApprovalRequest[] {
  return current.filter((entry) => String(entry.id) !== String(id));
}

/**
 * Whether the workspace has unfinished agent work.
 *
 * A pending approval counts: the engine is blocked waiting for an answer, so
 * closing the window would abandon a turn mid-flight.
 */
export function hasPendingWork(snapshot: AgentSessionSnapshot): boolean {
  return (
    snapshot.phase === 'opening' || snapshot.phase === 'running' || snapshot.approvals.length > 0
  );
}

/**
 * Drives one (project, domain) thread.
 *
 * The engine answers a host request immediately and may raise approvals after
 * it, so a turn is not finished until the event queue stops yielding requests.
 * Callers poll while a turn runs.
 */
export class AgentSession {
  private snapshot: AgentSessionSnapshot = { ...initialAgentSession };

  constructor(
    private readonly agent: AgentBackend,
    private readonly binding: { projectId: string; domain: AgentDomain },
    private readonly connection: AgentConnection,
    private readonly onUpdate: (snapshot: AgentSessionSnapshot) => void = () => {},
  ) {}

  get state(): AgentSessionSnapshot {
    return this.snapshot;
  }

  private set(patch: Partial<AgentSessionSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.onUpdate(this.snapshot);
  }

  async open(): Promise<boolean> {
    this.set({ phase: 'opening', error: null });
    try {
      const thread = await this.agent.startThread(
        this.binding.projectId,
        this.binding.domain,
        this.connection,
      );
      this.set({ phase: 'running', threadId: thread.threadId });
      return true;
    } catch (reason) {
      this.set({
        phase: 'idle',
        error: reason instanceof Error ? reason.message : String(reason),
      });
      return false;
    }
  }

  /** Start a turn and pick up whatever it raised. */
  async send(text: string): Promise<boolean> {
    const threadId = this.snapshot.threadId;
    if (!threadId) {
      this.set({ error: t('请先建立 Agent 线程。') });
      return false;
    }
    this.set({ phase: 'running', error: null });
    try {
      const turn = await this.agent.startTurn({
        projectId: this.binding.projectId,
        domain: this.binding.domain,
        threadId,
        text,
      });
      this.set({ approvals: mergeApprovals(this.snapshot.approvals, turn.events) });
      // A response returns before trailing events are readable, so drain once
      // more rather than assuming the handle is complete.
      await this.poll();
      return true;
    } catch (reason) {
      this.set({
        phase: 'idle',
        error: reason instanceof Error ? reason.message : String(reason),
      });
      return false;
    }
  }

  /** Read queued messages and fold approvals into the snapshot. */
  async poll(): Promise<void> {
    let approvals = this.snapshot.approvals;
    try {
      approvals = mergeApprovals(
        approvals,
        await this.agent.events(this.binding.projectId, this.binding.domain),
      );
    } catch (reason) {
      this.set({ error: reason instanceof Error ? reason.message : String(reason) });
      return;
    }
    const phase = approvals.length
      ? 'waiting'
      : this.snapshot.phase === 'waiting'
        ? 'running'
        : this.snapshot.phase;
    this.set({ approvals, phase });
  }

  async decide(approval: ApprovalRequest, decision: ApprovalDecision): Promise<boolean> {
    try {
      await this.agent.respond({
        projectId: this.binding.projectId,
        domain: this.binding.domain,
        id: approval.id,
        result: approvalResult(decision),
      });
      const approvals = resolveApproval(this.snapshot.approvals, approval.id);
      this.set({ approvals, phase: approvals.length ? 'waiting' : 'running' });
      return true;
    } catch (reason) {
      this.set({ error: reason instanceof Error ? reason.message : String(reason) });
      return false;
    }
  }
}
