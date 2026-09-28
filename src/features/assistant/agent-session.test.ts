import { describe, expect, it, vi } from 'vitest';
import {
  AgentSession,
  hasPendingWork,
  initialAgentSession,
  mergeApprovals,
  resolveApproval,
} from './agent-session';
import type { AgentBackend, AgentEvent, ApprovalRequest } from '../../platform/agent';

const approval = (id: string): ApprovalRequest =>
  ({
    kind: 'request',
    id,
    method: 'item/fileChange/requestApproval',
    params: {},
  }) as ApprovalRequest;

const notification: AgentEvent = { kind: 'notification', method: 'turn/started', params: {} };

const connection = {
  endpoint: 'https://api.openai.com/v1',
  model: 'test-model',
  provider: 'openai' as const,
};

function backend(overrides: Partial<AgentBackend> = {}): AgentBackend {
  return {
    status: vi.fn(),
    handshake: vi.fn(),
    domains: vi.fn(),
    startThread: vi.fn(async () => ({ threadId: 't1' })),
    startTurn: vi.fn(async () => ({ turnId: 'turn1', status: 'running', events: [] })),
    events: vi.fn(async () => []),
    respond: vi.fn(async () => {}),
    ...overrides,
  } as unknown as AgentBackend;
}

describe('approval queue', () => {
  it('ignores notifications and repeats of a request already shown', () => {
    const first = mergeApprovals([], [notification, approval('a1')]);
    expect(first.map((entry) => entry.id)).toEqual(['a1']);
    // The engine may re-announce a request; the user must not see it twice.
    expect(mergeApprovals(first, [approval('a1'), approval('a2')]).map((e) => e.id)).toEqual([
      'a1',
      'a2',
    ]);
  });

  it('matches numeric and string ids so a decision clears the right row', () => {
    // RequestId is a string or a number, so comparison cannot assume either.
    const queue = [{ ...approval('7'), id: 7 }] as ApprovalRequest[];
    expect(resolveApproval(queue, '7')).toEqual([]);
  });
});

describe('close protection', () => {
  it('treats a pending approval as unfinished work', () => {
    // The engine is blocked waiting for an answer, so quitting would abandon it.
    expect(
      hasPendingWork({ ...initialAgentSession, phase: 'waiting', approvals: [approval('a1')] }),
    ).toBe(true);
    expect(hasPendingWork({ ...initialAgentSession, phase: 'running' })).toBe(true);
    expect(hasPendingWork(initialAgentSession)).toBe(false);
  });
});

describe('AgentSession', () => {
  it('opens a thread and reports the engine that owns it', async () => {
    const session = new AgentSession(
      backend(),
      { projectId: 'p1', domain: 'literature' },
      connection,
    );
    expect(await session.open()).toBe(true);
    expect(session.state.threadId).toBe('t1');
    expect(session.state.phase).toBe('running');
  });

  it('surfaces an approval raised after the turn response', async () => {
    // startTurn returns before the trailing approval is readable, so `send`
    // must poll once more or the request would sit unanswered.
    const agent = backend({ events: vi.fn(async () => [approval('a1')]) });
    const session = new AgentSession(agent, { projectId: 'p1', domain: 'code' }, connection);
    await session.open();
    await session.send('整理数据');
    expect(session.state.approvals.map((entry) => entry.id)).toEqual(['a1']);
    expect(session.state.phase).toBe('waiting');
    expect(hasPendingWork(session.state)).toBe(true);
  });

  it('answers with the decision the user picked and clears the row', async () => {
    const respond = vi.fn(async () => {});
    const agent = backend({ events: vi.fn(async () => [approval('a1')]), respond });
    const session = new AgentSession(agent, { projectId: 'p1', domain: 'code' }, connection);
    await session.open();
    await session.poll();
    expect(await session.decide(session.state.approvals[0], 'decline')).toBe(true);
    expect(respond).toHaveBeenCalledWith({
      projectId: 'p1',
      domain: 'code',
      id: 'a1',
      result: { decision: 'decline' },
    });
    expect(session.state.approvals).toEqual([]);
    expect(session.state.phase).toBe('running');
  });

  it('reports a failed open instead of pretending a thread exists', async () => {
    const agent = backend({
      startThread: vi.fn(async () => {
        throw new Error('暂不支持该服务商的原始协议。');
      }),
    });
    const session = new AgentSession(agent, { projectId: 'p1', domain: 'code' }, connection);
    expect(await session.open()).toBe(false);
    expect(session.state.threadId).toBeNull();
    expect(session.state.error).toContain('暂不支持');
  });

  it('refuses to send before a thread exists', async () => {
    const agent = backend();
    const session = new AgentSession(agent, { projectId: 'p1', domain: 'code' }, connection);
    expect(await session.send('你好')).toBe(false);
    expect(agent.startTurn).not.toHaveBeenCalled();
  });
});
