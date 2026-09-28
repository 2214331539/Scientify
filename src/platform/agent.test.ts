import { describe, expect, it } from 'vitest';
import {
  approvalResult,
  domainForWorkspace,
  engineSupports,
  isApprovalRequest,
  type AgentEvent,
} from './agent';

describe('agent domain binding', () => {
  it('maps the three project-file views onto one domain', () => {
    // Code, Manuscript and All files edit the same root, so they must not split
    // into three separate memories.
    expect(domainForWorkspace('experiments')).toBe('code');
    expect(domainForWorkspace('writing')).toBe('code');
    expect(domainForWorkspace('files')).toBe('code');
  });

  it('gives the literature workspace its own domain', () => {
    expect(domainForWorkspace('literature')).toBe('literature');
  });

  it('leaves rootless views unbound so the previous binding is kept', () => {
    expect(domainForWorkspace('overview')).toBeNull();
    expect(domainForWorkspace('notes')).toBeNull();
    // The project manager is not a research workspace and owns no directory.
    expect(domainForWorkspace('projects')).toBeNull();
  });
});

describe('agent approval handling', () => {
  it('recognises the three requests that must be answered', () => {
    const approval: AgentEvent = {
      kind: 'request',
      id: 'a1',
      method: 'item/fileChange/requestApproval',
      params: {},
    };
    expect(isApprovalRequest(approval)).toBe(true);
    expect(approvalResult('accept')).toEqual({ decision: 'accept' });
  });

  it('does not mistake notifications or other requests for approvals', () => {
    expect(isApprovalRequest({ kind: 'notification', method: 'turn/started', params: {} })).toBe(
      false,
    );
    // `item/tool/requestUserInput` also needs an answer, but it is a question
    // rather than an approval, so it must not be routed to the approval card.
    expect(
      isApprovalRequest({
        kind: 'request',
        id: 2,
        method: 'item/tool/requestUserInput',
        params: {},
      }),
    ).toBe(false);
  });

  it('keeps cancel distinct from decline', () => {
    // Cancelling aborts the turn; declining refuses one action.
    expect(approvalResult('cancel')).not.toEqual(approvalResult('decline'));
  });
});

describe('engine protocol support', () => {
  it('accepts only the protocols the engine can actually speak', () => {
    expect(engineSupports('openai')).toBe(true);
    expect(engineSupports('ollama')).toBe(true);
    // These use different wire formats and would fail at request time, so the
    // panel must be able to refuse them up front.
    expect(engineSupports('anthropic')).toBe(false);
    expect(engineSupports('gemini')).toBe(false);
  });
});
